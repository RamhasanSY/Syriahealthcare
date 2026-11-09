// Checks and cleans files patients upload to their health file (stage 2b).
// - Only PDF, JPEG and PNG, decided by the first bytes, never by the name.
// - Photos lose their metadata: EXIF (with the GPS position and the phone model), XMP, IPTC and comments in JPEG;
//   text, EXIF and time chunks in PNG. The picture itself is not touched.
// - PDFs that can run code or carry other files (/JavaScript, /JS, /Launch, /EmbeddedFile, /OpenAction with script)
//   are refused, also when hidden in compressed object streams or written with #-escapes.
import {inflateSync} from 'node:zlib';
import {sniffType} from './documents.js';

export class UploadError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

// ---- JPEG ----

// Marker segments kept: everything except APP1 (EXIF, XMP), APP13 (IPTC/Photoshop) and COM (comments).
// APP0 (JFIF), APP2 (colour profile) and APP14 (Adobe colour transform) are needed to show the picture correctly.
const DROP_JPEG = new Set([0xe1, 0xed, 0xfe]);

export function stripJpeg(buffer) {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new UploadError('invalid_file', 'This picture is damaged.');
    const parts = [buffer.subarray(0, 2)];
    let i = 2;
    while (i < buffer.length) {
        if (buffer[i] !== 0xff) throw new UploadError('invalid_file', 'This picture is damaged.');
        const marker = buffer[i + 1];
        if (marker === 0xff) { i++; continue; }                      // fill byte
        if (marker === 0xda) { parts.push(buffer.subarray(i)); break; } // start of scan: the image data follows, keep the rest
        if (marker === 0xd9) { parts.push(buffer.subarray(i, i + 2)); break; }
        if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) { parts.push(buffer.subarray(i, i + 2)); i += 2; continue; }
        if (i + 4 > buffer.length) throw new UploadError('invalid_file', 'This picture is damaged.');
        const length = buffer.readUInt16BE(i + 2);
        if (length < 2 || i + 2 + length > buffer.length) throw new UploadError('invalid_file', 'This picture is damaged.');
        if (!DROP_JPEG.has(marker)) parts.push(buffer.subarray(i, i + 2 + length));
        i += 2 + length;
    }
    return Buffer.concat(parts);
}

// ---- PNG ----

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Text (tEXt, zTXt, iTXt), EXIF (eXIf) and the time of the last change (tIME) carry personal details, not pixels.
const DROP_PNG = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

export function stripPng(buffer) {
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new UploadError('invalid_file', 'This picture is damaged.');
    const parts = [PNG_SIGNATURE];
    let i = 8, ended = false;
    while (i + 12 <= buffer.length) {
        const length = buffer.readUInt32BE(i), type = buffer.subarray(i + 4, i + 8).toString('latin1');
        const end = i + 12 + length;
        if (end > buffer.length) throw new UploadError('invalid_file', 'This picture is damaged.');
        if (!DROP_PNG.has(type)) parts.push(buffer.subarray(i, end));
        i = end;
        if (type === 'IEND') { ended = true; break; }
    }
    if (!ended) throw new UploadError('invalid_file', 'This picture is damaged.');
    return Buffer.concat(parts);
}

// ---- PDF ----

const ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA|SubmitForm|ImportData|GoToE)\b/;

// "/J#61vaScript" is the same name as "/JavaScript" in PDF.
const unescapeNames = text => text.replace(/\/[^\s/<>()[\]{}%]*/g, name => name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));

export function activePdfContent(buffer) {
    const text = buffer.toString('latin1');
    const found = unescapeNames(text).match(ACTIVE);
    if (found) return found[1];
    // Object streams (PDF 1.5+) hide dictionaries inside compressed streams: look inside every one that inflates.
    const stream = /stream\r?\n/g;
    let match, inspected = 0;
    while ((match = stream.exec(text)) && inspected < 2000) {
        const start = match.index + match[0].length, end = text.indexOf('endstream', start);
        if (end < 0) break;
        inspected++;
        try {
            const inner = unescapeNames(inflateSync(buffer.subarray(start, end), {maxOutputLength: 20 * 1024 * 1024}).toString('latin1'));
            const hidden = inner.match(ACTIVE);
            if (hidden) return hidden[1];
        } catch (_) { /* not a Flate stream, or images: nothing to read */ }
        stream.lastIndex = end;
    }
    return null;
}

// Returns {mime, buffer} with metadata removed, or throws UploadError.
export function cleanUpload(buffer) {
    const mime = sniffType(buffer);
    if (!mime) throw new UploadError('invalid_file_type', 'Upload a PDF, JPG or PNG file.');
    if (mime === 'image/jpeg') return {mime, buffer: stripJpeg(buffer)};
    if (mime === 'image/png') return {mime, buffer: stripPng(buffer)};
    const active = activePdfContent(buffer);
    if (active) throw new UploadError('active_pdf', `This PDF contains active content (${active}) and cannot be uploaded. Print it to a new PDF or take a photo instead.`);
    return {mime, buffer};
}
