# Download task contract

`DownloadManager` remains the scheduler and executes chapters sequentially, as before.
This contract does not implement site archiving, persistent sessions, disk quotas, or a new UI.

## Enqueue and observe an attempt

```ts
import { MangaExportFormat } from '../../web/src/engine/exporters/MangaExporterRegistry';

const handle = await HakuNeko.DownloadManager.EnqueueTask(chapter, {
    directory: authorizedDirectoryHandle,
    format: MangaExportFormat.CBZ,
    useWebsiteSubDirectory: true,
    owner: 'archive:session-id',
    signal: cancellation.signal,
});
handle.progress.Subscribe(value => console.log(value));
handle.exportProgress.Subscribe(value => console.log(value.state, value.writtenFiles));
handle.errors.Subscribe(errors => console.log(errors.map(item => item.stage)));
const result = await handle.completion;
```

Acquire directory permission through an appropriate user gesture before submitting a custom
directory. The background export checks permission but does not open an unexpected prompt.
Custom destination, format, and organization options do not modify global settings. Omitted
options use the original global settings at export time. Scalar values are read before the
first asynchronous operation in `Chapter.Store` and remain consistent for that export.

The handle captures one immutable completion result and one attempt ID. Repeated requests
for the same active media, owner, signal, destination and export options return its handle.
Different owners or destinations are independent. A new `EnqueueTask` after a terminal result
is an explicit new attempt, with a new ID and completion promise. Old handles cannot cancel
or observe replacement attempts. The legacy `Enqueue(...media): Promise<void>` keeps its
existing deduplication and UI contract; use the new method for explicit retries.

## Receipts and their limits

- `fetch` records the returned page list and received resources. `sourceCompleteness` stays
  `unknown`: a connector response does not prove it listed all source pages or chapters.
- `inputValidation` records actual successful browser image validation. A WeakSet marker
  records validation without retaining images or bypassing repeated validation. Opaque
  non-image providers can report `not-performed`; this must not be treated as image validation.
- `output.files` contains only acknowledged, successfully closed writes, with the expected
  byte size, relative path, and live file handle. `output.directory` is the selected root
  and `format` the effective format. These handles are not portable filesystem paths or
  a durable SQLite manifest.
- `verification` reads each reported file and checks its size. It is not a checksum, full
  archive parser, source-completeness proof, or power-loss durability guarantee.
- `partial` means some planned files were closed. `unknown` means a write was attempted but
  no complete receipt proves its result, or a legacy provider returned no receipts.
- `cleanup` and staged `errors` are independent of writing. `succeeded-with-warnings` can
  preserve a verified write despite cleanup failure. Legacy UI status remains conservatively
  `Failed` in that case; consumers must use the result rather than infer redownload necessity
  from that status alone.

Do not automatically redownload written, size-verified artifacts after cleanup failure.
`await handle.retryCleanup()` retries only that attempt's remaining temporary keys. It returns
a separate cleanup result without mutating the original receipt, refetching images, or
exporting again. Concurrent cleanup retries on a handle coalesce. Partial and unknown outputs
require reconciliation before an archiver decides to retry. Existing filenames can still be
replaced by an explicit download, as in the original exporters; no automatic output deletion
or rollback is performed.

## Cancellation and write ownership

`cancel(reason)` settles a queued attempt without starting it. Active attempts stop at safe
checkpoints; providers and archive generation that cannot be interrupted must finish or fail
before their resources and output locks are released. The cancellation signal reaches image
fetching, validation, exporter task pools, and file writes. Writers abort an unfinished stream
on failure rather than closing it as a successful partial file. Successful earlier files are
never deleted on cancellation. Cancellation arriving after all writes does not erase receipts.

Locks are shared across manager instances and compare physical directory handles, including
ancestor aliases. Locking is deliberately broader than one filename: exports into the same or
nested directory serialize, even when their filenames or formats differ. Independent directories
can proceed independently across managers. Locks cover exporter completion and receipt readback; RAW and image
preparation wait for all started workers before cleanup can remove source temporary data.

PDF completion now waits for PDFKit output, writing, and close. PDF bytes are assembled into a
Blob before the shared writer runs; peak memory on large documents needs measurement. Neither
the existing ZIP builders nor PDF generation provide fully interruptible streaming in this change.

## Validation commands

From the repository root:

```sh
NODE_USE_ENV_PROXY=1 npm test
npm run check
npm run build --workspace=web
npm run build --workspace=app/electron
BROWSER_EXECUTABLE_PATH=/usr/bin/chromium node test/image-validation.mjs
BROWSER_EXECUTABLE_PATH=/usr/bin/chromium node test/download-contract.mjs
DISPLAY=:99 NODE_USE_ENV_PROXY=1 dbus-run-session npm exec -- vitest run --config=test/vitest.e2e.ts Frontend --testNamePattern=SmokeTests
```

The filesystem browser checks use a disposable Chromium profile's origin-private filesystem,
not user download folders. They exercise RAW, CBZ, EPUB, PDF, readback, settings isolation,
cleanup-only retries, and cross-manager write exclusion. They do not establish Windows
compatibility, live connector health, full archive integrity, or recovery after power loss.
