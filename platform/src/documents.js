// Encrypted storage for doctors' licence documents (AES-256-GCM, a fresh IV per file).
// Files live in DOCUMENT_DIR under random names; the key never touches the disk or the database.
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

// The file content decides the type, not the name or the browser's claim.
export function sniffType(buffer) {
    if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    return null;
}

export function createDocumentStore({dir, keyHex}) {
    const key = Buffer.from(keyHex, 'hex');
    if (key.length !== 32) throw new Error('DOCUMENT_KEY must be 64 hex characters (32 bytes)');
    const file = storageKey => {
        if (!/^[a-f0-9]{48}$/.test(storageKey)) throw new Error('Invalid storage key');
        return path.join(dir, storageKey);
    };
    return {
        async save(buffer) {
            await mkdir(dir, {recursive: true});
            const iv = randomBytes(12), storageKey = randomBytes(24).toString('hex');
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
            await writeFile(file(storageKey), encrypted, {mode: 0o600});
            return {storageKey, iv: iv.toString('base64'), authTag: cipher.getAuthTag().toString('base64'),
                sha256: createHash('sha256').update(buffer).digest('hex')};
        },
        async open({storage_key, iv, auth_tag}) {
            const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
            decipher.setAuthTag(Buffer.from(auth_tag, 'base64'));
            return Buffer.concat([decipher.update(await readFile(file(storage_key))), decipher.final()]);
        },
        async remove(storageKey) {
            await rm(file(storageKey), {force: true});
        }
    };
}
