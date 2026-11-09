import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {activePdfContent, cleanUpload, stripJpeg, stripPng, UploadError} from '../src/uploads.js';
import {checkCharacter, cleanPatientNumber, newPatientNumber} from '../src/patient-number.js';
import {jpegWithExif, PDF, PDF_ESCAPED, PDF_HIDDEN, PDF_LAUNCH, PDF_SCRIPT, pngWithText} from './fixtures.js';

describe('photos lose their metadata', () => {
    test('JPEG: EXIF with the GPS position and the comment go, the picture and its colour profile stay', () => {
        const original = jpegWithExif();
        const clean = stripJpeg(original);
        const text = clean.toString('latin1');
        assert.doesNotMatch(text, /GPSLatitude|PhoneX|Mezzeh/);
        assert.match(text, /JFIF/);
        assert.match(text, /ICC_PROFILE/);
        assert.match(text, /IMAGEDATA/);
        assert.deepEqual([...clean.subarray(0, 2)], [0xff, 0xd8]);
        assert.deepEqual([...clean.subarray(-2)], [0xff, 0xd9]);
        assert.ok(clean.length < original.length);
    });

    test('PNG: text, EXIF and time chunks go, the image chunks stay', () => {
        const clean = stripPng(pngWithText()).toString('latin1');
        assert.doesNotMatch(clean, /Lina Haddad|GPSLatitude|tIME|tEXt|eXIf/);
        assert.match(clean, /IHDR/);
        assert.match(clean, /IDAT/);
        assert.match(clean, /IEND/);
    });

    test('damaged pictures are refused', () => {
        assert.throws(() => stripJpeg(Buffer.from([0xff, 0xd8, 0x00, 0x01])), UploadError);
        assert.throws(() => stripPng(pngWithText().subarray(0, 40)), UploadError);
    });
});

describe('PDFs with active content are refused', () => {
    test('scripts, launch actions and embedded files, also escaped or compressed', () => {
        assert.equal(activePdfContent(PDF), null);
        assert.equal(activePdfContent(PDF_SCRIPT), 'JavaScript');
        assert.equal(activePdfContent(PDF_ESCAPED), 'JavaScript');
        assert.equal(activePdfContent(PDF_LAUNCH), 'Launch');
        assert.equal(activePdfContent(PDF_HIDDEN), 'EmbeddedFiles');
    });

    test('cleanUpload decides the type by content and refuses anything else', () => {
        assert.equal(cleanUpload(PDF).mime, 'application/pdf');
        assert.equal(cleanUpload(jpegWithExif()).mime, 'image/jpeg');
        assert.equal(cleanUpload(pngWithText()).mime, 'image/png');
        assert.throws(() => cleanUpload(Buffer.from('<html><script>alert(1)</script>')), {code: 'invalid_file_type'});
        assert.throws(() => cleanUpload(PDF_SCRIPT), {code: 'active_pdf'});
    });
});

describe('SyriaHC patient number', () => {
    test('has the form SHC-XXXX-XXXX-X with unambiguous characters and a valid check character', () => {
        for (let i = 0; i < 200; i++) {
            const number = newPatientNumber();
            assert.match(number, /^SHC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]$/);
            assert.equal(cleanPatientNumber(number), number);
        }
    });

    test('a typed number is cleaned, and a wrong character or a swap is caught', () => {
        const number = newPatientNumber(), chars = number.replace(/^SHC|-/g, '');
        assert.equal(cleanPatientNumber(' shc ' + chars.toLowerCase().replace(/(.{4})/g, '$1 ')), number);
        assert.equal(cleanPatientNumber('SHC-ABCD-EFGH'), null, 'too short');
        assert.equal(cleanPatientNumber('SHC-ABCD-EFG0-2'), null, '0 is never used');
        let caught = 0, tried = 0;
        for (let i = 0; i < 8; i++) {
            for (const c of '23456789ABCDEFGHJKLMNPQRSTUVWXYZ') {
                if (c === chars[i]) continue;
                tried++;
                if (cleanPatientNumber(chars.slice(0, i) + c + chars.slice(i + 1)) === null) caught++;
            }
        }
        assert.equal(caught, tried, 'every single wrong character');
        let swaps = 0, swapsCaught = 0;
        for (let i = 0; i < 7; i++) {
            if (chars[i] === chars[i + 1]) continue;
            swaps++;
            const swapped = chars.slice(0, i) + chars[i + 1] + chars[i] + chars.slice(i + 2);
            if (cleanPatientNumber(swapped) === null) swapsCaught++;
        }
        assert.ok(swapsCaught >= swaps - 1, 'almost every swap of neighbours');
        assert.equal(checkCharacter('22222222').length, 1);
    });
});
