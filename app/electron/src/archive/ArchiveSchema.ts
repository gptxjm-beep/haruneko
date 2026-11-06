import type { DatabaseSync } from 'node:sqlite';

export const ArchiveSchemaVersion = 6;

const migrations = [
    `
    CREATE TABLE roots(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, label TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), site_id TEXT NOT NULL,
      site_name TEXT NOT NULL, state TEXT NOT NULL, settings TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      index_state TEXT NOT NULL DEFAULT 'unknown');
    CREATE TABLE chapters(key TEXT PRIMARY KEY, site_id TEXT NOT NULL, manga_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
      UNIQUE(site_id,manga_id,chapter_id));
    CREATE TABLE session_chapters(session_id TEXT NOT NULL REFERENCES sessions(id), chapter_key TEXT NOT NULL REFERENCES chapters(key),
      title TEXT NOT NULL, position INTEGER NOT NULL, order_confidence TEXT NOT NULL, order_evidence TEXT NOT NULL,
      expected_pages INTEGER, expected_trusted INTEGER NOT NULL, pages_evidence TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'Pending', local_state TEXT NOT NULL DEFAULT 'uncertain', source_state TEXT NOT NULL DEFAULT 'unknown',
      PRIMARY KEY(session_id,chapter_key));
    CREATE TABLE attempts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL, chapter_key TEXT NOT NULL,
      state TEXT NOT NULL, stage TEXT NOT NULL, received_pages INTEGER NOT NULL DEFAULT 0, validated_pages INTEGER NOT NULL DEFAULT 0,
      expected_files INTEGER, result TEXT, cleanup_keys TEXT NOT NULL DEFAULT '[]', started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      FOREIGN KEY(session_id,chapter_key) REFERENCES session_chapters(session_id,chapter_key));
    CREATE UNIQUE INDEX one_running_attempt ON attempts(session_id,chapter_key) WHERE state='running';
    CREATE TABLE files(id TEXT PRIMARY KEY, root_id TEXT NOT NULL REFERENCES roots(id), chapter_key TEXT NOT NULL REFERENCES chapters(key),
      attempt_id TEXT NOT NULL REFERENCES attempts(id), path TEXT NOT NULL, path_key TEXT NOT NULL,
      format TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT, state TEXT NOT NULL, staging TEXT, stamp TEXT,
      UNIQUE(root_id,path_key));
    CREATE TABLE attempt_files(attempt_id TEXT NOT NULL REFERENCES attempts(id), file_id TEXT NOT NULL REFERENCES files(id),
      PRIMARY KEY(attempt_id,file_id));
    CREATE TABLE errors(id INTEGER PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id),
      stage TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE conflicts(attempt_id TEXT NOT NULL REFERENCES attempts(id), path TEXT NOT NULL, reason TEXT NOT NULL,
      PRIMARY KEY(attempt_id,path));
    `,
    `ALTER TABLE files ADD COLUMN verified_at INTEGER;
     ALTER TABLE roots ADD COLUMN identity TEXT;
     ALTER TABLE attempt_files ADD COLUMN receipt_size INTEGER;
     ALTER TABLE attempt_files ADD COLUMN receipt_sha256 TEXT;
     ALTER TABLE attempt_files ADD COLUMN receipt_verified_at INTEGER;
     UPDATE attempt_files SET receipt_size=(SELECT size FROM files WHERE files.id=attempt_files.file_id),
       receipt_sha256=(SELECT sha256 FROM files WHERE files.id=attempt_files.file_id);
     CREATE INDEX interrupted_attempts ON attempts(state,session_id);
     CREATE INDEX chapter_files ON files(root_id,chapter_key);`,
    `CREATE TABLE archive_runs(session_id TEXT PRIMARY KEY REFERENCES sessions(id),state TEXT NOT NULL,policy TEXT NOT NULL,
      epoch INTEGER NOT NULL DEFAULT 0,catalog_done INTEGER NOT NULL DEFAULT 0,catalog_pages INTEGER NOT NULL DEFAULT 0,catalog_attempts INTEGER NOT NULL DEFAULT 0,
      index_state TEXT NOT NULL DEFAULT 'unknown',index_evidence TEXT NOT NULL DEFAULT '',mangas_used INTEGER NOT NULL DEFAULT 0,
      chapters_started INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '');
     CREATE TABLE archive_mangas(session_id TEXT NOT NULL REFERENCES sessions(id),id TEXT NOT NULL,title TEXT NOT NULL,
      position INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',admitted INTEGER NOT NULL DEFAULT 0,listed INTEGER NOT NULL DEFAULT 0,
      listings INTEGER NOT NULL DEFAULT 0,next_retry INTEGER NOT NULL DEFAULT 0,retryable INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',evidence_state TEXT NOT NULL DEFAULT 'unknown',evidence TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(session_id,id));
     CREATE TABLE archive_work(session_id TEXT NOT NULL,manga_id TEXT NOT NULL,id TEXT NOT NULL,chapter_key TEXT NOT NULL REFERENCES chapters(key),
      title TEXT NOT NULL,position INTEGER NOT NULL,language TEXT,expected_pages INTEGER,expected_trusted INTEGER NOT NULL DEFAULT 0,
      pages_evidence TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      checked_epoch INTEGER NOT NULL DEFAULT 0,next_retry INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(session_id,manga_id,id),FOREIGN KEY(session_id,manga_id) REFERENCES archive_mangas(session_id,id));
     CREATE TABLE archive_events(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),manga_id TEXT,chapter_id TEXT,
      kind TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL);
     CREATE INDEX archive_work_queue ON archive_work(session_id,manga_id,checked_epoch,position);
     CREATE INDEX archive_manga_queue ON archive_mangas(session_id,state,next_retry);
     CREATE INDEX archive_event_session ON archive_events(session_id,id);`,
    `ALTER TABLE archive_runs ADD COLUMN catalog_active INTEGER NOT NULL DEFAULT 0;
     ALTER TABLE archive_runs ADD COLUMN catalog_state TEXT NOT NULL DEFAULT 'idle';
     UPDATE archive_runs SET catalog_state=CASE WHEN catalog_done=1 THEN 'finished' WHEN state='paused' THEN 'paused' ELSE 'interrupted' END;
     CREATE TABLE archive_manifests(session_id TEXT NOT NULL,manga_id TEXT NOT NULL,token TEXT NOT NULL,
      expected_count INTEGER NOT NULL,received_count INTEGER NOT NULL DEFAULT 0,ordering TEXT NOT NULL,order_evidence TEXT NOT NULL,
      evidence TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'registering',PRIMARY KEY(session_id,manga_id),
      FOREIGN KEY(session_id,manga_id) REFERENCES archive_mangas(session_id,id));
     CREATE TABLE archive_manifest_entries(session_id TEXT NOT NULL,manga_id TEXT NOT NULL,id TEXT NOT NULL,
      position INTEGER NOT NULL,payload TEXT NOT NULL,conflict INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(session_id,manga_id,id),
      FOREIGN KEY(session_id,manga_id) REFERENCES archive_manifests(session_id,manga_id));
     CREATE INDEX archive_manifest_order ON archive_manifest_entries(session_id,manga_id,position,id);`,
    `ALTER TABLE archive_runs ADD COLUMN storage_error TEXT;`,
    `CREATE TABLE archive_ui_preferences(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);`,
];

export function MigrateArchiveDatabase(database: DatabaseSync, target = ArchiveSchemaVersion): void {
    const current = Number(database.prepare('PRAGMA user_version').get()!.user_version);
    if (current > target || target > ArchiveSchemaVersion) throw new Error('Unsupported archive schema version');
    for (let version = current; version < target; version++) {
        database.exec('BEGIN IMMEDIATE');
        try {
            database.exec(migrations[version]);
            database.exec(`PRAGMA user_version=${version + 1}`);
            database.exec('COMMIT');
        } catch(error) { database.exec('ROLLBACK'); throw error; }
    }
}
