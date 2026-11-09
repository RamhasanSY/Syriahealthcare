// Background work of the running server (stage 2a): send queued emails, remove expired sign-in data and old entries in
// the health file's bin, and warn the administrators by email when the disk is nearly full. Each job is a plain function, so tests can run it directly.
import {statfs} from 'node:fs/promises';
import {enqueueEmail, deliverDue} from './outbox.js';

export const EVERY = {outbox: 5 * 60_000, cleanup: 60 * 60_000, disk: 60 * 60_000};

// A warning when less than this is free, whichever is reached first.
export const DISK_LIMITS = {minFreeBytes: 2 * 1024 ** 3, minFreeShare: 0.10};
// At most one disk warning per day, so a full disk does not flood the administrators' inboxes.
const WARN_EVERY_MS = 24 * 60 * 60_000;

// Expired sessions and codes are useless; sent emails are kept 30 days for questions like "did the code go out?".
const CLEANUP = [
    ['sessions', 'DELETE FROM sessions WHERE expires_at < now()'],
    ['otp_codes', "DELETE FROM otp_codes WHERE created_at < now() - interval '1 day'"],
    ['staff_login_codes', "DELETE FROM staff_login_codes WHERE created_at < now() - interval '1 day'"],
    ['login_failures', "DELETE FROM login_failures WHERE created_at < now() - interval '1 day'"],
    ['password_resets', "DELETE FROM password_resets WHERE created_at < now() - interval '1 day'"],
    ['email_outbox', "DELETE FROM email_outbox WHERE (sent_at < now() - interval '30 days') OR (failed_at < now() - interval '30 days')"]
];

export async function cleanup(pool) {
    const removed = {};
    for (const [table, sql] of CLEANUP) removed[table] = (await pool.query(sql)).rowCount;
    return removed;
}

// Health file entries in the bin for more than 30 days are removed for good, with their encrypted files (stage 2b).
// Lab results taken over from a slip have no files of their own: only the link to the lab's result goes.
export async function purgeBin({pool, documents, days = 30}) {
    const {rows} = await pool.query(
        `DELETE FROM clinical_documents WHERE deleted_at < now() - make_interval(days => $1)
         RETURNING (SELECT coalesce(json_agg(storage_key), '[]'::json) FROM clinical_document_files WHERE document_id = clinical_documents.id) AS keys`, [days]);
    const keys = rows.flatMap(r => r.keys);
    for (const key of keys) await documents.remove(key);
    return {documents: rows.length, files: keys.length};
}

// Free space of the file system that holds `dir`. Returns null where the platform cannot tell.
export async function diskSpace(dir, stat = statfs) {
    try {
        const s = await stat(dir);
        const total = s.blocks * s.bsize, free = s.bavail * s.bsize;
        return total > 0 ? {total, free, share: free / total} : null;
    } catch (_) {
        return null;
    }
}

export const diskIsLow = space => Boolean(space) && (space.free < DISK_LIMITS.minFreeBytes || space.share < DISK_LIMITS.minFreeShare);

const gb = bytes => (bytes / 1024 ** 3).toFixed(1);

// Queues one email per active administrator. Returns how many were queued.
export async function warnAdminsOfDisk(pool, space) {
    const {rows: admins} = await pool.query("SELECT email FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL");
    const subject = 'SyriaHC server: disk nearly full | الخادم: القرص شبه ممتلئ';
    const text = `Only ${gb(space.free)} GB of ${gb(space.total)} GB (${Math.round(space.share * 100)}%) are free on the platform server.\n` +
        'Backups, uploads and the database stop working when the disk is full. Please delete old backups or add space.\n\n' +
        `المساحة الحرة على خادم المنصة ${gb(space.free)} غيغابايت فقط من ${gb(space.total)}.\n` +
        'تتوقف النسخ الاحتياطية والرفع وقاعدة البيانات عند امتلاء القرص. يرجى حذف النسخ القديمة أو زيادة المساحة.';
    for (const admin of admins) await enqueueEmail(pool, {to: admin.email, subject, text});
    return admins.length;
}

// Checks the disk and warns at most once per WARN_EVERY_MS. `state` remembers the last warning between runs.
export async function checkDisk({pool, dir, log, state, stat, now = Date.now()}) {
    const space = await diskSpace(dir, stat);
    if (!diskIsLow(space)) return {low: false, space};
    log?.warn({free: space.free, total: space.total}, 'Disk nearly full');
    if (state.lastWarning && now - state.lastWarning < WARN_EVERY_MS) return {low: true, space, warned: 0};
    state.lastWarning = now;
    return {low: true, space, warned: await warnAdminsOfDisk(pool, space)};
}

// Starts the timers. They never keep the process alive on their own (unref), and a failing job only logs.
export function startJobs({pool, mail, log, dir, documents}) {
    const state = {};
    const run = (name, job) => () => job().catch(error => log.error({err: error}, `Job ${name} failed`));
    const timers = [
        setInterval(run('outbox', () => deliverDue({pool, mail, log})), EVERY.outbox),
        setInterval(run('cleanup', () => cleanup(pool).then(() => purgeBin({pool, documents}))), EVERY.cleanup),
        setInterval(run('disk', () => checkDisk({pool, dir, log, state})), EVERY.disk)
    ];
    timers.forEach(t => t.unref());
    return () => timers.forEach(clearInterval);
}
