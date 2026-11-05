import PDFDocument from 'pdfkit';
import { MangaExporter } from './MangaExporter';
import { SanitizeFileName } from '../StorageController';
import { Priority, TaskPool } from '../taskpool/TaskPool';
import { ConvertBitmap } from '../transformers/ImageConverter';
import type { ExportContext } from '../DownloadContract';
import { WriteExportFile } from './WriteExportFile';

const pdfImageFormats = [ 'image/png', 'image/jpeg' ];
const pageWidth = 2400; // (W)QUXGA - Portrait

export class PortableDocumentFormatExporter extends MangaExporter {

    private async PrepareImages(sourceFileList: Map<number, string>, context?: ExportContext) {
        const taskPool = new TaskPool(8);
        const digits = sourceFileList.size.toString().length;
        const promises = new Array(sourceFileList.size).fill(null).map((_, index) => taskPool.Add(async () => {
            context?.signal.throwIfAborted();
            const { data } = await super.ReadTempImageData(sourceFileList.get(index), index, digits);
            const bitmap = await createImageBitmap(data);
            try {
                return {
                    width: bitmap.width,
                    height: bitmap.height,
                    // Conversion of unsupported images via jsPDF is slow and produces a large PDF => Using own implementation of image conversion
                    data: pdfImageFormats.includes(data.type) ? data : await ConvertBitmap(bitmap, 'image/jpeg', 0.95)
                };
            } finally {
                bitmap.close();
            }
        }, Priority.Normal, context?.signal));
        const results = await Promise.allSettled(promises);
        const failure = results.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return results.map(result => result.status === 'fulfilled' ? result.value : undefined);
    }

    public override async Export(sourceFileList: Map<number, string>, targetDirectory: FileSystemDirectoryHandle, chapterTitle: string, _mangaTitle?: string, context?: ExportContext): Promise<void> {
        const images = await this.PrepareImages(sourceFileList, context);
        const buffers = await Promise.all(images.map(async image => ({ ...image, data: await image.data.arrayBuffer() })));
        context?.signal.throwIfAborted();
        // PDFKit emits chunks asynchronously. Wait for end/error rather than returning
        // while writes and close are still outstanding.
        const document = await new Promise<Blob>((resolve, reject) => {
            const chunks: Uint8Array<ArrayBuffer>[] = [];
            const pdf = new PDFDocument({ autoFirstPage: false, compress: false, margin: 0 });
            pdf.on('data', (bytes: Uint8Array<ArrayBuffer>) => chunks.push(bytes));
            pdf.once('error', reject);
            pdf.once('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
            try {
                for(const { width, height, data } of buffers) {
                    context?.signal.throwIfAborted();
                    const pageHeight = height * pageWidth / width;
                    pdf.addPage({ size: [pageWidth, pageHeight], margin: 0 }).image(data, {
                        fit: [pageWidth, pageHeight], valign: 'center', align: 'center',
                    });
                }
                pdf.end();
            } catch(error) {
                pdf.destroy();
                reject(error);
            }
        });
        await WriteExportFile(targetDirectory, SanitizeFileName(chapterTitle + '.pdf'), document, context);
    }
}
