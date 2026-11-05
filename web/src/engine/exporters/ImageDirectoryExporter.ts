import { MangaExporter } from './MangaExporter';
import { SanitizeFileName } from '../StorageController';
import { TaskPool, Priority } from '../taskpool/TaskPool';
import type { ExportContext } from '../DownloadContract';
import { WriteExportFile } from './WriteExportFile';

export class ImageDirectoryExporter extends MangaExporter {

    public override async Export(sourceFileList: Map<number, string>, targetDirectory: FileSystemDirectoryHandle, chapterTitle: string, _mangaTitle?: string, context?: ExportContext): Promise<void> {
        const taskPool = new TaskPool(8);
        const digits = sourceFileList.size.toString().length;
        context?.signal.throwIfAborted();
        const chapterName = SanitizeFileName(chapterTitle);
        const directory = context?.write ? targetDirectory : await targetDirectory.getDirectoryHandle(chapterName, { create: true });

        // TODO: delete all existing entries?
        const promises = [...sourceFileList].map(([ index, tempfile ]) => taskPool.Add(async () => {
            const { name, data } = await super.ReadTempImageData(tempfile, index, digits);
            await WriteExportFile(directory, name, data, context, `${chapterName}/${name}`);
        }, Priority.Normal, context?.signal));

        const results = await Promise.allSettled(promises);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
    }
}
