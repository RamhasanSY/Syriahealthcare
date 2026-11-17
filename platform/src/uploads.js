// Checks and cleans files patients upload to their health file (stage 2b).
// - Only PDF, JPEG and PNG, decided by the first bytes, never by the name.
// - Photos lose their metadata: EXIF (with the GPS position and the phone model), XMP, IPTC and comments in JPEG;
//   text, EXIF and time chunks in PNG. The picture itself is not touched.
// - PDFs that can run code or carry other files (/JavaScript, /JS, /Launch, /EmbeddedFile, /OpenAction with script)
//   are refused, also when hidden in compressed object streams or written with #-escapes.
import {constants as zlib, inflateSync} from 'node:zlib';
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
    const damaged = () => new UploadError('invalid_file', 'This picture is damaged.');
    const parts = [buffer.subarray(0, 2)];
    let i = 2;
    while (i < buffer.length) {
        if (buffer[i] !== 0xff) throw damaged();
        const marker = buffer[i + 1];
        if (marker === 0xff) { i++; continue; }                         // fill byte
        // End of image: anything after it (a second picture with its own location data, a motion-photo video) is dropped.
        if (marker === 0xd9) { parts.push(buffer.subarray(i, i + 2)); return Buffer.concat(parts); }
        if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { parts.push(buffer.subarray(i, i + 2)); i += 2; continue; }
        if (i + 4 > buffer.length) throw damaged();
        const length = buffer.readUInt16BE(i + 2);
        if (length < 2 || i + 2 + length > buffer.length) throw damaged();
        if (!DROP_JPEG.has(marker)) parts.push(buffer.subarray(i, i + 2 + length));
        i += 2 + length;
        if (marker === 0xda) {
            // Start of scan: the compressed picture runs until the next real marker (0xFF followed by something other
            // than 0x00, a restart marker or a fill byte). Progressive pictures have several scans; the loop continues.
            let j = i;
            while (j + 1 < buffer.length && !(buffer[j] === 0xff && buffer[j + 1] !== 0x00 && !(buffer[j + 1] >= 0xd0 && buffer[j + 1] <= 0xd7) && buffer[j + 1] !== 0xff)) j++;
            if (j + 1 >= buffer.length) throw damaged();
            parts.push(buffer.subarray(i, j));
            i = j;
        }
    }
    throw damaged();  // no end-of-image marker
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
// Encodings that could hide such names from the check below and are not used for normal pages and scans.
const UNUSUAL = /\/(ASCIIHexDecode|ASCII85Decode|LZWDecode|RunLengthDecode|AHx|A85|LZW|RL|Crypt)\b/;
// The check's own limits, so one crafted file cannot keep the server busy: at most 400 streams and 25 MB unpacked in all.
export const PDF_LIMITS = {streams: 400, inflatedBytes: 25 * 1024 * 1024};
// Filter chains ([/FlateDecode /FlateDecode]) would hide content from a single unpacking; pages and scans use one filter.
const FILTER_CHAIN = /\[\s*\/(FlateDecode|Fl|DCTDecode|DCT|JPXDecode|JBIG2Decode|CCITTFaxDecode|CCF)\s*\//;
// Decoding parameters kept in another object cannot be read here.
const INDIRECT_PARAMS = /\/(Filter|DecodeParms|Predictor|Columns|Colors|BitsPerComponent)\s+\d+\s+\d+\s+R\b/;
// Starts like zlib data (RFC 1950 header), as readers expect of /FlateDecode.
const zlibHeader = b => b.length >= 2 && (b[0] & 0x0f) === 8 && b[0] >> 4 <= 7 && ((b[0] << 8) | b[1]) % 31 === 0;
const lastNumber = (text, key, fallback) => {
    const all = [...text.matchAll(new RegExp(`/${key}\\s+(\\d+)`, 'g'))];
    return all.length ? Number(all.at(-1)[1]) : fallback;
};

// Readers undo a "predictor" after unpacking (PDF 32000-1, 7.4.4.4): PNG predictors change every byte of a row, so names
// are only readable after the same step. Returns null for settings readers would not accept either.
function unpredict(data, dictionary) {
    const predictor = lastNumber(dictionary, 'Predictor', 1);
    if (predictor === 1) return data;
    const colors = lastNumber(dictionary, 'Colors', 1), bits = lastNumber(dictionary, 'BitsPerComponent', 8), columns = lastNumber(dictionary, 'Columns', 1);
    if (!colors || !columns || ![1, 2, 4, 8, 16].includes(bits) || columns * colors > 1_000_000) return null;
    if (predictor === 2) {
        if (bits !== 8) return null;
        const out = Buffer.from(data), row = columns * colors;
        for (let i = 0; i < out.length; i++) if (i % row >= colors) out[i] = (out[i] + out[i - colors]) & 255;
        return out;
    }
    if (predictor < 10 || predictor > 15) return null;
    const bpp = Math.max(1, Math.ceil(colors * bits / 8)), length = Math.ceil(columns * colors * bits / 8);
    const rows = Math.floor(data.length / (length + 1)), out = Buffer.alloc(rows * length);
    for (let r = 0; r < rows; r++) {
        const type = data[r * (length + 1)], from = r * (length + 1) + 1, to = r * length;
        if (type > 4) return null;
        for (let i = 0; i < length; i++) {
            const a = i >= bpp ? out[to + i - bpp] : 0, b = r ? out[to - length + i] : 0, c = r && i >= bpp ? out[to - length + i - bpp] : 0;
            const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const guess = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][type];
            out[to + i] = (data[from + i] + guess) & 255;
        }
    }
    return out;
}

// "/J#61vaScript" is the same name as "/JavaScript" in PDF. Only names that contain "#" are rewritten (cheap).
const unescapeNames = text => text.replace(/\/[^\s/<>()[\]{}%#]*#[0-9a-fA-F]{2}[^\s/<>()[\]{}%]*/g,
    name => name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))));

// Returns the reason a PDF is refused, or null. Reasons: an active-content name, 'encrypted', 'unusual', 'too_complex'.
export function pdfProblem(buffer) {
    const text = unescapeNames(buffer.toString('latin1'));
    if (/\/Encrypt\b/.test(text)) return 'encrypted';
    const found = text.match(ACTIVE);
    if (found) return found[1];
    if (UNUSUAL.test(text) || FILTER_CHAIN.test(text) || INDIRECT_PARAMS.test(text)) return 'unusual';
    // Object streams (PDF 1.5+) hide dictionaries inside compressed streams: look inside each one that inflates.
    // "stream" must not be the end of "endstream", or every second stream would be skipped.
    const stream = /(?<![A-Za-z])stream\r?\n/g;
    let match, streams = 0, budget = PDF_LIMITS.inflatedBytes, previousEnd = 0;
    while ((match = stream.exec(text))) {
        const start = match.index + match[0].length, end = text.indexOf('endstream', start);
        if (end < 0) break;
        if (++streams > PDF_LIMITS.streams) return 'too_complex';
        // Everything since the previous stream: it holds this stream's dictionary (filter and decoding parameters).
        const dictionary = text.slice(previousEnd, match.index);
        const data = buffer.subarray(start, end);
        let inner = null;
        try {
            // A cut-off stream gives what it has (readers show that too); damaged data throws.
            inner = inflateSync(data, {maxOutputLength: budget, finishFlush: zlib.Z_SYNC_FLUSH});
        } catch (error) {
            if (error.code === 'ERR_BUFFER_TOO_LARGE' || /Cannot create a Buffer larger|maxOutputLength/i.test(error.message)) return 'too_complex';
            // Compressed data that does not unpack cleanly cannot be checked, but readers may still show what they can.
            // Refusing at once also stops a file of many such streams from costing the full budget again and again.
            if (zlibHeader(data)) return 'unusual';
            // Not a Flate stream (pictures, fonts): nothing to read.
        }
        if (inner) {
            budget -= inner.length;
            if (budget <= 0) return 'too_complex';
            const decoded = unpredict(inner, dictionary);
            if (!decoded) return 'unusual';
            for (const content of decoded === inner ? [inner] : [inner, decoded]) {
                const hidden = unescapeNames(content.toString('latin1'));
                const name = hidden.match(ACTIVE) || hidden.match(/\/Encrypt\b/) && ['', 'encrypted'];
                if (name) return name[1];
                if (UNUSUAL.test(hidden) || FILTER_CHAIN.test(hidden) || INDIRECT_PARAMS.test(hidden)) return 'unusual';
            }
        }
        previousEnd = end + 9;
        stream.lastIndex = previousEnd;
    }
    return null;
}

export const activePdfContent = buffer => {
    const problem = pdfProblem(buffer);
    return problem && !['encrypted', 'unusual', 'too_complex'].includes(problem) ? problem : null;
};

const PDF_MESSAGES = {
    encrypted: ['pdf_encrypted', 'This PDF is protected or encrypted and cannot be checked. Save it without protection, or take a photo instead.'],
    unusual: ['pdf_unsupported', 'This PDF is built in an unusual way and cannot be checked. Print it to a new PDF, or take a photo instead.'],
    too_complex: ['pdf_unsupported', 'This PDF is built in an unusual way and cannot be checked. Print it to a new PDF, or take a photo instead.']
};

// Returns {mime, buffer} with metadata removed, or throws UploadError.
export function cleanUpload(buffer) {
    const mime = sniffType(buffer);
    if (!mime) throw new UploadError('invalid_file_type', 'Upload a PDF, JPG or PNG file.');
    if (mime === 'image/jpeg') return {mime, buffer: stripJpeg(buffer)};
    if (mime === 'image/png') return {mime, buffer: stripPng(buffer)};
    const problem = pdfProblem(buffer);
    if (PDF_MESSAGES[problem]) throw new UploadError(...PDF_MESSAGES[problem]);
    if (problem) throw new UploadError('active_pdf', `This PDF contains active content (${problem}) and cannot be uploaded. Print it to a new PDF or take a photo instead.`);
    return {mime, buffer};
}
