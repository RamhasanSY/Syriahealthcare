// SyriaHC patient number (stage 2b): SHC-XXXX-XXXX-X. Eight random characters and one check character.
// The alphabet has no 0/O or 1/I, like the lab result codes, so a number read aloud or typed from paper is never ambiguous.
// The check character (Luhn mod 32) catches every single wrong character and almost every swap of two neighbours.
import {randomInt} from 'node:crypto';

export const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const N = ALPHABET.length;
export const PATIENT_NUMBER_SYSTEM = 'https://syriahc.com/fhir/sid/patient-number';  // as published in NamingSystem/patient-number

// Luhn mod N over the given characters, from the right; returns the check character.
export function checkCharacter(body) {
    let factor = 2, sum = 0;
    for (let i = body.length - 1; i >= 0; i--) {
        const value = ALPHABET.indexOf(body[i]);
        if (value < 0) throw new Error('Invalid character');
        let addend = factor * value;
        factor = factor === 2 ? 1 : 2;
        addend = Math.floor(addend / N) + (addend % N);
        sum += addend;
    }
    return ALPHABET[(N - (sum % N)) % N];
}

const format = chars => `SHC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars[8]}`;

export function newPatientNumber() {
    const body = Array.from({length: 8}, () => ALPHABET[randomInt(N)]).join('');
    return format(body + checkCharacter(body));
}

// Accepts a number as typed: any case, with or without "SHC", dashes and spaces. Returns the canonical form or null.
export function cleanPatientNumber(raw) {
    const chars = String(raw || '').toUpperCase().replace(/^\s*SHC/, '').replace(/[^0-9A-Z]/g, '');
    if (chars.length !== 9 || ![...chars].every(c => ALPHABET.includes(c))) return null;
    return checkCharacter(chars.slice(0, 8)) === chars[8] ? format(chars) : null;
}
