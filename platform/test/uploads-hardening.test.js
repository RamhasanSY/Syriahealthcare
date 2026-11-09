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
