/**
 * Validate a downloaded page using the browser image decoder, retaining the original bytes.
 * Common raster signatures take precedence over an inaccurate HTTP content type.
 */
export async function ValidateImage(data: Blob): Promise<Blob> {
    if (!data?.size) throw new Error('Downloaded page is empty or missing');

    const header = new Uint8Array(await data.slice(0, 64).arrayBuffer());
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
    else throw new Error('Downloaded page is not a recognized image');

    const imageData = type === data.type ? data : data.slice(0, data.size, type);
    const url = URL.createObjectURL(imageData);
    try {
        const image = new Image();
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error('Image has no dimensions');
        return imageData;
    } catch(cause) {
        throw new Error('Downloaded page could not be decoded as an image', { cause });
    } finally {
        URL.revokeObjectURL(url);
    }
}
