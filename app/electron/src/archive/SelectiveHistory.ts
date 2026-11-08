import type { DatabaseSync } from 'node:sqlite';
export const OwnedRuns = `SELECT r.*,coalesce(q.seq,CAST(json_extract(s.settings,'$._queueSeq') AS INTEGER)) owner
 FROM archive_runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN hub_queue q ON q.session_id=r.session_id`;
export function SelectiveBudget(db: DatabaseSync): { mangasUsed: number; chaptersStarted: number } {
    const row = db.prepare(`WITH owned AS (${OwnedRuns}) SELECT coalesce(sum(m),0) m,coalesce(sum(c),0) c
        FROM (SELECT owner,max(mangas_used) m,sum(chapters_started) c FROM owned WHERE owner IN (SELECT seq FROM hub_queue) GROUP BY owner)`).get()!;
    return { mangasUsed: Number(row.m), chaptersStarted: Number(row.c) };
}
export function AdmittedIdentity(db: DatabaseSync, seq: number): boolean {
    return !!db.prepare(`SELECT 1 FROM (${OwnedRuns}) WHERE owner=? AND mangas_used>0 LIMIT 1`).get(seq);
}
export function LinkSelectiveSession(db: DatabaseSync, seq: number, sessionId: unknown): void {
    if (typeof sessionId === 'string') db.prepare("UPDATE sessions SET settings=json_set(settings,'$._queueSeq',?) WHERE id=?").run(seq, sessionId);
}
