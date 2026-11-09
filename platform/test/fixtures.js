// Small files for upload tests, built byte by byte so every test knows exactly what is inside.
import {deflateSync} from 'node:zlib';

const segment = (marker, payload) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length + 2);
    return Buffer.concat([Buffer.from([0xff, marker]), length, payload]);
};

// A JPEG frame with JFIF, an EXIF block holding a GPS position and a phone model, a colour profile and a comment.
export function jpegWithExif() {
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
        segment(0xe1, Buffer.from('Exif\0\0GPSLatitude 33.5138 GPSLongitude 36.2765 Model PhoneX', 'latin1')),
        segment(0xe2, Buffer.from('ICC_PROFILE\0colour', 'latin1')),
        segment(0xfe, Buffer.from('Taken at home in Mezzeh', 'latin1')),
        segment(0xdb, Buffer.alloc(65, 1)),
        segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from('IMAGEDATA', 'latin1'),
        Buffer.from([0xff, 0xd9])
    ]);
}

const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);  // CRC is not checked here
};

// A PNG with a text chunk (author and place), an EXIF chunk and a time stamp around the image data.
export function pngWithText() {
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', Buffer.alloc(13, 1)),
        chunk('tEXt', Buffer.from('Author\0Lina Haddad, Damascus', 'latin1')),
        chunk('eXIf', Buffer.from('GPSLatitude 33.5', 'latin1')),
        chunk('tIME', Buffer.alloc(7, 2)),
        chunk('IDAT', Buffer.from('PIXELS', 'latin1')),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
export const PDF_SCRIPT = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF\n');
export const PDF_ESCAPED = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /J#61vaScript >> >> endobj\n%%EOF\n');
export const PDF_LAUNCH = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /Launch /F (cmd.exe) >> >> endobj\n%%EOF\n');
// The script sits inside a compressed object stream, invisible to a plain text search.
export const PDF_HIDDEN = Buffer.concat([
    Buffer.from('%PDF-1.5\n2 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\n'),
    deflateSync(Buffer.from('<< /Names << /EmbeddedFiles 3 0 R >> >>')),
    Buffer.from('\nendstream\nendobj\n%%EOF\n')
]);

// Builds a multipart body: fields first (as browsers send them), then one part per file.
export function multipart(fields, files) {
    const boundary = '----shctest' + Math.random().toString(16).slice(2);
    const body = Buffer.concat([
        ...Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)),
        ...files.flatMap(({name = 'page', filename, type = 'application/octet-stream', content}) => [
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
            content, Buffer.from('\r\n')
        ]),
        Buffer.from(`--${boundary}--\r\n`)
    ]);
    return {body, contentType: `multipart/form-data; boundary=${boundary}`};
}
