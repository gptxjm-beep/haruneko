import { TaskPool, Priority } from './taskpool/TaskPool';

const validationPool = new TaskPool(4);
const validatedImages = new WeakSet<Blob>();

export class ImageValidationError extends Error {}

/** This marker does not retain images or skip future validation. */
export function IsValidatedImage(data: Blob): boolean {
    return validatedImages.has(data);
}

function AwaitWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    return new Promise<T>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', abort);
        const abort = () => {
            cleanup();
            reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        operation.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
        if (signal.aborted) abort();
    });
}

/**
 * Validate a downloaded page using the browser image decoder, retaining the original bytes.
 * Common raster signatures take precedence over an inaccurate HTTP content type.
 */
export async function ValidateImage(data: Blob, signal?: AbortSignal, priority: Priority = Priority.Normal, dimensions?: (width: number, height: number) => void): Promise<Blob> {
    signal?.throwIfAborted();
    return AwaitWithAbort(validationPool.Add(() => DecodeImage(data, signal, dimensions), priority, signal), signal);
}

async function DecodeImage(data: Blob, signal?: AbortSignal, dimensions?: (width: number, height: number) => void): Promise<Blob> {
    signal?.throwIfAborted();
    if (!data?.size) throw new ImageValidationError('Downloaded page is empty or missing');

    const header = new Uint8Array(await data.slice(0, 64).arrayBuffer());
    signal?.throwIfAborted();
    const startsWith = (...bytes: number[]) => bytes.every((byte, index) => header[index] === byte);
    let type: string;
    if (startsWith(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) type = 'image/png';
    else if (startsWith(0xFF, 0xD8, 0xFF)) type = 'image/jpeg';
    else if (startsWith(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || startsWith(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) type = 'image/gif';
    else if (startsWith(0x42, 0x4D)) type = 'image/bmp';
    else if (startsWith(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...header.slice(8, 12)) === 'WEBP') type = 'image/webp';
    else if (String.fromCharCode(...header.slice(4, 8)) === 'ftyp' && /avif|avis/.test(String.fromCharCode(...header.slice(8)))) type = 'image/avif';
    else if (startsWith(0x00, 0x00, 0x01, 0x00)) type = 'image/x-icon';
    else if (data.type.startsWith('image/')) type = data.type;
    else throw new ImageValidationError('Downloaded page is not a recognized image');

    const imageData = type === data.type ? data : data.slice(0, data.size, type);
    const url = URL.createObjectURL(imageData);
    const image = new Image();
    try {
        image.src = url;
        await AwaitWithAbort(image.decode(), signal);
        signal?.throwIfAborted();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image has no dimensions');
        validatedImages.add(imageData);
        dimensions?.(image.naturalWidth, image.naturalHeight);
        return imageData;
    } catch(cause) {
        signal?.throwIfAborted();
        throw new ImageValidationError('Downloaded page could not be decoded as an image', { cause });
    } finally {
        image.src = '';
        URL.revokeObjectURL(url);
    }
}
