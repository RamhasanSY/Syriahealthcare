import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync} from 'node:zlib';
import {cleanUpload, pdfProblem, stripJpeg, UploadError} from '../src/uploads.js';
import {jpegWithExif, PDF} from './fixtures.js';

const pdfWithStreams = (...contents) => Buffer.concat([
    Buffer.from('%PDF-1.5\n'),
    ...contents.flatMap((c, i) => [Buffer.from(`${i + 2} 0 obj << /Filter /FlateDecode >>\nstream\n`), deflateSync(Buffer.from(c)), Buffer.from('\nendstream\nendobj\n')]),
    Buffer.from('%%EOF\n')
]);

describe('PDF check, hardened after the security review', () => {
    test('active content in the second compressed stream is found too (endstream is not a stream)', () => {
        assert.equal(pdfProblem(pdfWithStreams('<< /Type /Font >>', '<< /S /JavaScript >>')), 'JavaScript');
        assert.equal(pdfProblem(pdfWithStreams('<< /Type /Font >>', '<< /Type /Page >>', '<< /S /Launch >>')), 'Launch');
    });

    test('encrypted PDFs and unusual encodings are refused, normal PDFs pass', () => {
        assert.equal(pdfProblem(Buffer.from('%PDF-1.4\ntrailer << /Encrypt 5 0 R >>\n%%EOF')), 'encrypted');
        assert.equal(pdfProblem(Buffer.from('%PDF-1.4\n1 0 obj << /Filter /ASCIIHexDecode >>\nstream\n2F4A53\nendstream\n%%EOF')), 'unusual');
        assert.throws(() => cleanUpload(Buffer.from('%PDF-1.4\ntrailer << /Encrypt 5 0 R >>\n%%EOF')), {code: 'pdf_encrypted'});
        assert.equal(pdfProblem(PDF), null);
        assert.equal(pdfProblem(pdfWithStreams('<< /Type /Page >>', 'BT /F1 12 Tf (Hello) Tj ET')), null);
    });

    test('a crafted PDF cannot keep the server busy', () => {
        // Many streams of nothing but "/" used to cost about 17 s each; now the whole file is refused quickly.
        const slashes = '/'.repeat(5 * 1024 * 1024);
        const bomb = pdfWithStreams(...Array.from({length: 8}, () => slashes));
        const started = Date.now();
        assert.equal(pdfProblem(bomb), 'too_complex');
        assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
        const plain = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('/'.repeat(5 * 1024 * 1024))]);
        const t2 = Date.now();
        pdfProblem(plain);
        assert.ok(Date.now() - t2 < 2000, `plain text took ${Date.now() - t2} ms`);
        const many = pdfWithStreams(...Array.from({length: 450}, () => 'q'));
        assert.equal(pdfProblem(many), 'too_complex');
    });

    test('compressed data with a wrong checksum is refused at once, not unpacked again for every stream', () => {
        const big = deflateSync(Buffer.alloc(20 * 1024 * 1024));
        big[big.length - 1] ^= 1;  // the checksum no longer matches
        const streams = Array.from({length: 200}, (_, i) => [Buffer.from(`${i + 2} 0 obj << /Filter /FlateDecode >>\nstream\n`), big, Buffer.from('\nendstream\nendobj\n')]);
        const file = Buffer.concat([Buffer.from('%PDF-1.5\n'), ...streams.flat(), Buffer.from('%%EOF\n')]);
        const started = Date.now();
        assert.equal(pdfProblem(file), 'unusual');
        assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
        // A stream that is merely cut short is read as far as it goes.
        const cut = deflateSync(Buffer.from('<< /S /JavaScript >>' + ' '.repeat(5000)));
        const shortFile = Buffer.concat([Buffer.from('%PDF-1.5\n1 0 obj << /Filter /FlateDecode >>\nstream\n'), cut.subarray(0, cut.length - 10), Buffer.from('\nendstream\n%%EOF\n')]);
        assert.equal(pdfProblem(shortFile), 'JavaScript');
    });

    test('script hidden by a filter chain, a PNG predictor or parameters in another object is found or refused', () => {
        const script = '<< /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>';
        const twice = deflateSync(deflateSync(Buffer.from(script)));
        assert.equal(pdfProblem(Buffer.concat([Buffer.from('%PDF-1.5\n1 0 obj << /Filter [/FlateDecode /FlateDecode] >>\nstream\n'), twice,
            Buffer.from('\nendstream\n%%EOF\n')])), 'unusual');
        assert.equal(pdfProblem(Buffer.from('%PDF-1.5\n1 0 obj << /Filter 2 0 R >>\nstream\nx\nendstream\n2 0 obj [/FlateDecode] endobj\n%%EOF\n')), 'unusual');
        // PNG "Up" predictor, 4 columns: every row is stored as its difference to the row above.
        const columns = 4, raw = Buffer.from(script.padEnd(Math.ceil(script.length / columns) * columns));
        const rows = [];
        for (let i = 0; i < raw.length; i += columns) {
            const row = raw.subarray(i, i + columns), above = i ? raw.subarray(i - columns, i) : Buffer.alloc(columns);
            rows.push(Buffer.from([2]), Buffer.from(row.map((x, j) => (x - above[j]) & 255)));
        }
        const predicted = deflateSync(Buffer.concat(rows));
        assert.doesNotMatch(Buffer.concat(rows).toString('latin1'), /JavaScript/, 'the predictor really hides the name');
        const file = Buffer.concat([Buffer.from(`%PDF-1.5\n1 0 obj << /Type /ObjStm /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${columns} >> >>\nstream\n`),
            predicted, Buffer.from('\nendstream\n%%EOF\n')]);
        assert.equal(pdfProblem(file), 'JavaScript');
        // A normal cross-reference stream with a predictor still passes.
        const xref = deflateSync(Buffer.from([2, 1, 0, 16, 2, 0, 0, 5]));
        assert.equal(pdfProblem(Buffer.concat([Buffer.from('%PDF-1.5\n9 0 obj << /Type /XRef /Filter /FlateDecode /DecodeParms << /Columns 3 /Predictor 12 >> >>\nstream\n'),
            xref, Buffer.from('\nendstream\n%%EOF\n')])), null);
    });
});

describe('photos: nothing after the picture survives', () => {
    test('data appended after the end-of-image marker (second picture, motion video) is dropped', () => {
        const photo = jpegWithExif();
        const appended = Buffer.concat([photo, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('GPSLatitude 33.5 hidden')]);
        const clean = stripJpeg(appended);
        assert.doesNotMatch(clean.toString('latin1'), /GPSLatitude/);
        assert.deepEqual([...clean.subarray(-2)], [0xff, 0xd9]);
        assert.equal(clean.length, stripJpeg(photo).length);
    });

    test('a picture without an end marker is refused', () => {
        const photo = jpegWithExif();
        assert.throws(() => stripJpeg(photo.subarray(0, photo.length - 2)), UploadError);
    });
});
