# Persistent archive repository (phase 3)

Branch base: `35377c8e7daa9ce180e44af74e18cff688d64e0d`. This is a storage and single-chapter integration layer, not an ArchiveManager or site crawler. There is no new user interface.

## Runtime and trust boundary

The installed Electron **45.2.2**, with embedded Node **24.22.2**, was executed against `node:sqlite` (SQLite **3.53.4**). No native addon, Electron ABI rebuild, or renderer SQLite dependency is required. Older Electron versions without this API are unsupported. The database is opened lazily in the main process at `app.getPath('userData')/archive/state.sqlite`; staging is in its private sibling directory.

`ArchiveIPC` accepts only the configured window's main frame at the exact configured origin, including port. Roots are granted through a native directory picker. Renderer requests contain root IDs and bounded relative paths, never arbitrary native paths, SQL, or live filesystem handles. Requests are serialized, with a bounded pending queue; writes stream in 64 KiB IPC chunks. Paths reject traversal, Windows reserved names, case/Unicode aliases, symlink parents and overlapping grants. Root device/inode identity is checked again before access. A second process cannot open the same repository: a process lock and SQLite exclusive locking protect recovery from incorrectly interrupting another instance's live attempts.

The pre-existing preload still exposes generic IPC; this new channel supplies its own sender and input validation. It does not make unrelated existing IPC channels safe. An authorized compromised main renderer can exercise granted archive capabilities; native grants are not an isolation boundary from that renderer.

## Schema (user_version 2)

| Table | Durable data |
| --- | --- |
| `roots` | Native canonical path, opaque ID, label, directory identity |
| `sessions` | Site identity, root, export options, lifecycle, timestamps, independent site-index state |
| `chapters` | Stable SHA-256 key over the site/manga/chapter ID tuple, with a unique identity constraint |
| `session_chapters` | Title, chapter position, order confidence/evidence, expected pages and explicit trust/evidence, local/source states |
| `attempts` | Independent attempt ID, stage, received/validated counts, committed expected output count, result snapshot, pending temporary keys |
| `files` | Relative path, normalized collision key, owner, format, expected size, SHA-256, publication state, owned staging name and verification stamp |
| `attempt_files` | Files used by each attempt and immutable acknowledged size/hash receipts |
| `errors` | Separate stage and sanitized message, including repository, export, verification and cleanup errors |
| `conflicts` | Per-attempt path conflicts requiring review |

Foreign keys, unique path claims and one running attempt per session/chapter apply. Migrations use individual `BEGIN IMMEDIATE` transactions and update `user_version` only on commit. Newer unknown versions are rejected. WAL and `synchronous=FULL` are used; disk/SQLite errors propagate rather than becoming successful completion. No signed image URLs, credentials, or live FileSystemHandles are needed for recovery. Callers must supply stable connector IDs, not expiring URLs as identities.

## Publication and existing files

The adapter reuses DownloadManager, Chapter.Store and all four exporters. Task-specific format/root/organization never temporarily change global settings. A file intent and expected output count are committed before writing. Bytes go only to a new app-owned staging file; its SHA-256 is committed **before** creating the final path. Publication uses `COPYFILE_EXCL`, then verifies the final size/hash and acknowledges the receipt. Only the owned staging artifact is removed afterward.

Unknown files, other chapter owners, aliases, corrupt files and different export bytes are never replaced. An explicit retry against a known healthy file hashes the proposed bytes and reuses the existing file only when identical. This is independent from concurrent-output locking. No command deletes final outputs or offers a force-overwrite shortcut. Native archive publication is exclusive across cooperating and other processes; legacy browser preserve mode remains a best-effort existence check under the application's lock. Legacy manual replacement behavior remains unchanged.

A crash during exclusive copying can leave a partial final file. Recovery reports damage/review, preserving both final and staging bytes; it does not pretend publication was atomic or silently replace that file. Native path checks reduce accidental escapes, but are not a complete defense against a hostile local process racing path components (Node lacks a portable `openat` traversal API). Network filesystems, power loss, directory-entry durability and unusual inode behavior need platform-specific validation.

## Recovery contract

Opening the repository marks formerly active sessions/running attempts interrupted. `ArchiveFiles.Recover` checks the latest committed output plan for the session, or a compatible earlier session sharing the root/chapter/format/directory organization. It reports:

| Evidence | Decision |
| --- | --- |
| All planned outputs match durable receipts | `healthy` / `reuse` |
| No output ever written, or only confirmed missing outputs | `not-written` or `missing` / `retry-missing` |
| Durable staged hash matches an existing final output, even without Completed | Adopt verified receipt; no image download |
| Valid staging, absent final path | `partial` / `publish-staged`, explicit publication |
| Wrong size/hash, partial staging, conflicting/unknown ownership, offline/replaced root, ambiguous earlier artifacts | `damaged`, `partial` or `uncertain` / `review` |

Unchanged verified size/device/inode/mtime/ctime may reuse the prior hash evidence (`metadata-cache`). `fullAudit: true` streams SHA-256 again. Metadata caching is not cryptographic proof against a hostile filesystem; use full audits for stronger checks. Untracked paths can be inspected explicitly with `inspect-path`; phase 3 does not recursively crawl all existing root files.

`EnqueueArchiveChapter` returns either a download handle or a reuse/review/publish decision. `reviewedRetry` permits a new attempt after caller review but **does not** permit replacement. A failed final metadata transaction resolves the handle as `unverified`, preserving the successful output receipt and adding a repository error. Reopening can reconcile the durable pre-publication witness. Interrupted empty retries cannot hide older artifacts and trigger blind downloads.

Cleanup has its own evidence. A healthy file with failed cleanup remains reusable. `ResumeArchiveCleanup` removes only the recorded temporary keys through the original storage controller, and can retry owned staging cleanup. It never calls remove-all, fetches images, or deletes final files. Interrupted staging with no durable complete hash requires inspection. Automatic orphan garbage collection is deliberately absent.

Local health is separate from source completeness. Source completion requires explicit trusted expected-page evidence matching the same session's validated count; cross-session file reuse provides no fresh source proof. `DownloadResult.fetch.sourceCompleteness` remains unknown and the site index remains unknown. No session or site is declared complete merely because there were no errors.

## Task retention

Owned automation defaults to `retention: 'release'`: terminal tasks leave DownloadManager's in-memory queue. Manual tasks default to `keep`, preserving existing history and legacy Enqueue deduplication. DownloadHandle results stay usable after queue removal; callers that retain handles retain their own associated objects and must release them when done. Persistent attempts are stored in SQLite, not retained as all-history task objects. The processing loop now drains and stops instead of polling indefinitely.

## Verification

From the repository root:

```sh
npm test
npm run check
npm run build --workspaces
node test/archive-runtime.mjs
DISPLAY=:99 node test/archive-electron.mjs
BROWSER_EXECUTABLE_PATH=/usr/bin/chromium node test/image-validation.mjs
BROWSER_EXECUTABLE_PATH=/usr/bin/chromium node test/download-contract.mjs
```

The Electron renderer test requires a display and built `app/electron/build/preload.js`; its native dialog substitution exists only in the isolated test entry. SQLite tests run under the installed Electron, use isolated temporary roots/profiles, kill child processes at six transaction/write checkpoints, exercise migration rollback, collisions, corruption, interrupted retries and cross-session reuse. Unit tests include 500 archive tasks with preserved manual history, sender guards and repository-failure handling. No test reads or replaces user archives. Real sites and a Windows distribution are outside this stage's verification.

Validated on 2026-11-05: 2,224 unit tests passed, 5 skipped; all workspace static checks and builds passed; 23 native SQLite/recovery checks, 18 real Electron renderer/IPC checks across all four formats, 22 browser image checks and 16 browser filesystem contract checks passed. Existing external HTTP tests required `NODE_USE_ENV_PROXY=1` in this environment. Classic/Fluent layout smoke tests are separate from live-site bookmark tests; the latter require MangaDex connectivity and are not evidence of connector health.
