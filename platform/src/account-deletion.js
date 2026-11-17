// People delete their own accounts (Google Play requires this in the app and on a web page: /delete-account).
//
// Patients: deleted at once, with everything that belongs to them: appointments (upcoming ones are cancelled first, so
// the doctor is told and the time becomes free), reviews, home visit requests, the donor entry, notifications and the
// health file, including the encrypted files on disk. A child's profile goes too, unless another parent also has it.
// Lab results stay with the lab that issued them; only the patient's link to them goes. The security log keeps the
// account's id without a name.
//
// Doctors and facilities: switched off at once (signed out, gone from the directory) and marked for deletion. Every
// administrator gets an email. Removing them for good is a separate step (`npm run delete-account`), because the
// results a lab issued live on in patients' files and licence documents may have to be kept for a while.
//
// Deleting needs a sign-in from the last 15 minutes, so a phone left signed in for weeks cannot wipe an account.
import {clearSessionCookie, HttpError, requireRole} from './auth.js';
import {notifyWaitlist} from './appointment-comfort.js';
import {audit, transaction} from './db.js';
import {sendEmail} from './notify.js';
import {pushToUser} from './push.js';

export const RECENT_SIGN_IN_MINUTES = 15;
const RULE = '\n\n— — —\n\n';
const both = (language, ar, en) => language === 'en' ? en + RULE + ar : ar + RULE + en;

export const deletedEmail = user => ({
    subject: user.language === 'en' ? 'Your SyriaHC account has been deleted' : 'تم حذف حسابك في صحة تك',
    text: both(user.language,
        `مرحباً ${user.name}،\n\nتم حذف حسابك في صحة تك مع مواعيدك وملفك الصحي. لا يمكن التراجع عن ذلك.\nيمكنك إنشاء حساب جديد في أي وقت.`,
        `Hello ${user.name},\n\nYour SyriaHC account has been deleted, together with your appointments and your health file. This cannot be undone.\nYou can create a new account at any time.`)
});

export const deletionRequestedEmail = user => ({
    subject: user.language === 'en' ? 'Your SyriaHC account is switched off and will be deleted' : 'تم إيقاف حسابك في صحة تك وسيُحذف',
    text: both(user.language,
        `مرحباً ${user.name}،\n\nتلقّينا طلبك حذف الحساب. أوقفنا الحساب فوراً ولم يعد ظاهراً في الدليل. سنحذفه نهائياً بعد مراجعة البيانات التي يجب الاحتفاظ بها قانونياً، مثل النتائج التي أصدرتموها للمرضى ووثائق الترخيص.\n\nإن لم تطلب ذلك فتواصل معنا فوراً.`,
        `Hello ${user.name},\n\nWe received your request to delete your account. The account is switched off and no longer listed. We will delete it for good once we have checked what must be kept by law, such as results you issued to patients and licence documents.\n\nIf you did not ask for this, contact us at once.`)
});

const adminNoticeEmail = (admin, user, origin) => ({
    subject: admin.language === 'en' ? `Account deletion requested: ${user.name}` : `طلب حذف حساب: ${user.name}`,
    text: both(admin.language,
        `طلب ${user.name} (${user.email}، ${user.role === 'doctor' ? 'طبيب' : 'منشأة'}) حذف حسابه. الحساب موقوف ولم يعد ظاهراً.\n\nللحذف النهائي على الخادم:\ndocker compose exec app node src/delete-account.js ${user.email}\n\n${origin}/admin`,
        `${user.name} (${user.email}, ${user.role}) asked to delete their account. It is switched off and no longer listed.\n\nTo delete it for good, on the server:\ndocker compose exec app node src/delete-account.js ${user.email}\n\n${origin}/admin`)
});

// Profiles in the health file that only this account can open, and older duplicates merged into them.
async function ownProfiles(db, userId) {
    const {rows} = await db.query(
        `WITH RECURSIVE mine AS (
             SELECT pa.patient_id AS id FROM patient_access pa
             WHERE pa.user_id = $1
               AND NOT EXISTS (SELECT 1 FROM patient_access other WHERE other.patient_id = pa.patient_id AND other.user_id <> $1)
             UNION
             SELECT p.id FROM patients p JOIN mine ON p.merged_into = mine.id)
         SELECT id FROM mine`, [userId]);
    return rows.map(r => r.id);
}

// Deletes a patient and everything that belongs to them. Returns what was removed; files are removed after the commit.
export async function deletePatient(app, userId, {ip = null} = {}) {
    const result = await transaction(app.pg, async db => {
        const {rows: [user]} = await db.query("SELECT id, name, email, language FROM users WHERE id = $1 AND role = 'patient' FOR UPDATE", [userId]);
        if (!user) throw new HttpError(404, 'not_found', 'Account not found.');
        // Upcoming appointments go with the account (ON DELETE CASCADE); their doctors are told after the commit.
        const {rows: upcoming} = await db.query(
            `SELECT id, doctor_id, starts_at FROM appointments
             WHERE patient_id = $1 AND status IN ('requested', 'confirmed') AND starts_at > now()`, [userId]);
        const profiles = await ownProfiles(db, userId);
        const {rows: files} = await db.query(
            `SELECT f.storage_key FROM clinical_document_files f JOIN clinical_documents d ON d.id = f.document_id
             WHERE d.patient_id = ANY($1::uuid[])`, [profiles]);
        // Appointments and home visits booked for these profiles by someone else keep their own record, without the profile.
        await db.query('UPDATE appointments SET subject_id = NULL WHERE subject_id = ANY($1::uuid[])', [profiles]);
        await db.query('UPDATE home_visits SET subject_id = NULL WHERE subject_id = ANY($1::uuid[])', [profiles]);
        await db.query('UPDATE patients SET merged_into = NULL WHERE merged_into = ANY($1::uuid[]) AND NOT (id = ANY($1::uuid[]))', [profiles]);
        await db.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [profiles]);
        if (user.email) await db.query('DELETE FROM email_outbox WHERE to_address = $1 AND sent_at IS NULL', [user.email]);
        await db.query('DELETE FROM users WHERE id = $1', [userId]);
        await audit(db, {actorId: null, action: 'account.deleted', targetId: userId,
            details: {role: 'patient', profiles: profiles.length, files: files.length, cancelled: upcoming.length}, ip});
        return {user, upcoming, profiles: profiles.length, keys: files.map(f => f.storage_key)};
    });
    for (const key of result.keys) await app.documents.remove(key).catch(error => app.log.error({err: error}, 'Deleted file not removed'));
    for (const appointment of result.upcoming) {
        await pushToUser(app, appointment.doctor_id, {title: ['Appointment cancelled', 'أُلغي موعد'],
            body: ['The patient deleted their account. The time is free again.', 'حذف المريض حسابه. أصبح الوقت متاحاً من جديد.'],
            url: '/dashboard', tag: `appointment-${appointment.id}`});
        await notifyWaitlist(app, appointment.doctor_id, appointment.starts_at);
    }
    return {profiles: result.profiles, files: result.keys.length, cancelled: result.upcoming.length, user: result.user};
}

export default async function accountDeletionRoutes(app) {
    app.post('/api/account/delete', {
        preHandler: requireRole('patient', 'doctor', 'facility'),
        config: {rateLimit: {max: 10, timeWindow: '15 minutes'}},
        schema: {body: {type: 'object', required: ['confirm'], properties: {confirm: {const: true}}}}
    }, async (request, reply) => {
        const {rows: [session]} = await app.pg.query(
            `SELECT created_at > now() - make_interval(mins => $2) AS recent FROM sessions WHERE token_hash = $1`,
            [request.user.token_hash, RECENT_SIGN_IN_MINUTES]);
        if (!session?.recent) throw new HttpError(403, 'recent_sign_in_required', 'Please sign in again to confirm it is you, then delete the account.');
        const user = request.user;
        if (user.role === 'patient') {
            const done = await deletePatient(app, user.id, {ip: request.ip});
            clearSessionCookie(app, reply);
            if (user.email) await sendEmail(app, user.email, deletedEmail(user));
            return {deleted: true, profiles: done.profiles, cancelled: done.cancelled};
        }
        await transaction(app.pg, async db => {
            await db.query('UPDATE users SET disabled_at = COALESCE(disabled_at, now()), deletion_requested_at = now() WHERE id = $1', [user.id]);
            await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
            await db.query('DELETE FROM trusted_devices WHERE user_id = $1', [user.id]);
            await audit(db, {actorId: user.id, action: 'account.deletion_requested', targetId: user.id, ip: request.ip});
        });
        clearSessionCookie(app, reply);
        await sendEmail(app, user.email, deletionRequestedEmail(user));
        const {rows: admins} = await app.pg.query("SELECT name, email, language FROM users WHERE role = 'admin' AND disabled_at IS NULL");
        for (const admin of admins) await sendEmail(app, admin.email, adminNoticeEmail(admin, user, app.config.appOrigin));
        return {deletion_requested: true};
    });
}
