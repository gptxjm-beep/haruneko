import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ValidateImage } from './ValidateImage';

const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const decode = vi.fn();

beforeEach(() => {
    decode.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal('Image', class {
        public naturalWidth = 1;
        public naturalHeight = 1;
        public src = '';
        public decode = decode;
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('ValidateImage', () => {
    it.each(['text/html', 'application/octet-stream', '', 'image/jpeg'])('Should normalize PNG bytes declared as %s without converting them', async type => {
        const data = new Blob([png], { type });
        const image = await ValidateImage(data);

        expect(image.type).toBe('image/png');
        expect(await image.arrayBuffer()).toEqual(await data.arrayBuffer());
        expect(decode).toHaveBeenCalledTimes(1);
    });

    it('Should preserve an already correctly typed image', async () => {
        const data = new Blob([png], { type: 'image/png' });
        expect(await ValidateImage(data)).toBe(data);
    });

    it('Should reject HTML without trusting its MIME and retain the decoder error', async () => {
        const cause = new Error('Image decoder rejected HTML');
        decode.mockRejectedValue(cause);
        const data = new Blob(['<html>Error</html>'], { type: 'image/png' });

        await expect(ValidateImage(data)).rejects.toMatchObject({ cause });
    });

    it('Should reject a truncated image even when the signature is valid', async () => {
        decode.mockRejectedValue(new Error('Truncated PNG'));
        await expect(ValidateImage(new Blob([png], { type: 'image/png' }))).rejects.toThrow('could not be decoded');
    });

    it('Should reject an empty response', async () => {
        await expect(ValidateImage(new Blob([], { type: 'image/png' }))).rejects.toThrow('empty or missing');
        expect(decode).not.toHaveBeenCalled();
    });

    it('Should reject a missing response', async () => {
        await expect(ValidateImage(undefined)).rejects.toThrow('empty or missing');
    });

    it('Should release the object URL after successful validation', async () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL');
        try {
            await ValidateImage(new Blob([png]));
            expect(revoke).toHaveBeenCalledTimes(1);
        } finally {
            revoke.mockRestore();
        }
    });

    it('Should release the object URL after decoder failure', async () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL');
        decode.mockRejectedValue(new Error('Invalid image'));
        try {
            await expect(ValidateImage(new Blob([png]))).rejects.toThrow();
            expect(revoke).toHaveBeenCalledTimes(1);
        } finally {
            revoke.mockRestore();
        }
    });

    it('Should use the decoder for additional declared image formats, including SVG', async () => {
        const data = new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'], { type: 'image/svg+xml' });
        expect(await ValidateImage(data)).toBe(data);
        expect(decode).toHaveBeenCalledTimes(1);
    });
});
