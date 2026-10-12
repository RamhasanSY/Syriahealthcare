import {createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';

const scryptAsync = promisify(scrypt);
// scrypt with N=2^15, r=8, p=1 (OWASP-recommended minimum), stored as "scrypt$N$r$p$salt$hash".
const SCRYPT = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};

export async function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64, SCRYPT);
    return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
    const [scheme, N, r, p, salt, hash] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem});
    return timingSafeEqual(actual, expected);
}

// A password hash computed once, so unknown emails take as long as wrong passwords.
export const dummyPasswordHash = await hashPassword(randomBytes(16).toString('hex'));

export function passwordProblem(password) {
    if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
    if (password.length > 200) return 'Password is too long.';
    return null;
}

export const newToken = () => randomBytes(32).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const otpHash = (secret, phone, code) => createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex');

export function sameHash(a, b) {
    const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
    return x.length === y.length && timingSafeEqual(x, y);
}

// Normalizes phone numbers to E.164. Accepts Syrian local mobiles (09xxxxxxxx) and international numbers (+..., 00...).
// With {landline: true}, Syrian landlines with area code (e.g. 011 234 5678) are accepted too, for clinic phones.
export function normalizePhone(raw, {landline = false} = {}) {
    let digits = String(raw || '').replace(/[\s\-().]/g, '');
    digits = digits.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));  // Arabic-Indic digits
    if (/^09\d{8}$/.test(digits)) return '+963' + digits.slice(1);
    if (landline && /^0[1-8]\d{7,8}$/.test(digits)) return '+963' + digits.slice(1);
    if (digits.startsWith('00')) digits = '+' + digits.slice(2);
    if (/^\+9630?9\d{8}$/.test(digits)) return '+963' + digits.replace(/^\+9630?/, '');
    return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

export const normalizeEmail = raw => {
    const email = String(raw || '').trim().toLowerCase();
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && email.length <= 254 ? email : null;
};
