// Administrators switch staff accounts off and on again (stage 2a). A switched-off account cannot sign in, its sessions
// end at once, and its public listing disappears (the directory only shows accounts without disabled_at).
// Suspending a profile (doctors.js, facilities.js) hides the listing; disabling the account locks the person out entirely.
import {HttpError, requireRole} from './auth.js';
import {audit, transaction} from './db.js';
import {sendEmail} from './notify.js';

const RULE = '\n\n— — —\n\n';
const both = (language, ar, en) => language === 'en' ? en + RULE + ar : ar + RULE + en;

export function accountEmail(user, disabled, note) {
    const subject = disabled ? ['Your SyriaHC account has been switched off', 'تم إيقاف حسابك في صحة تك']
        : ['Your SyriaHC account is active again', 'أُعيد تفعيل حسابك في صحة تك'];
    const en = disabled ? `Your account has been switched off and you can no longer sign in:\n\n${note}\n\nPlease contact support if you think this is a mistake.`
        : 'Your account is active again. You can sign in as before.';
    const ar = disabled ? `تم إيقاف حسابك ولم يعد بإمكانك تسجيل الدخول:\n\n${note}\n\nيرجى التواصل مع الدعم إن كان ذلك خطأً.`
        : 'أُعيد تفعيل حسابك. يمكنك تسجيل الدخول كما في السابق.';
    return {
        subject: user.language === 'en' ? subject[0] : subject[1],
        text: both(user.language, `مرحباً ${user.name}،\n\n${ar}`, `Hello ${user.name},\n\n${en}`)
    };
}

export default async function accountRoutes(app) {
    const schema = {
        params: {type: 'object', properties: {id: {type: 'string', format: 'uuid'}}},
        body: {type: 'object', additionalProperties: false, properties: {note: {type: 'string', maxLength: 1000}}}
    };
    const options = {preHandler: requireRole('admin'), schema};

    // Patients are not listed for administrators (they have no route to patients at all), so only staff accounts can be targeted.
    const change = disable => async request => {
        const note = String(request.body?.note || '').trim();
        if (disable && note.length < 3) throw new HttpError(400, 'note_required', 'Please write a short reason.');
        // Whoever acts is an active administrator and cannot target themselves, so at least one administrator always remains.
        if (request.params.id === request.user.id) throw new HttpError(409, 'own_account', 'You cannot switch off your own account.');
        const user = await transaction(app.pg, async db => {
            const {rows: [target]} = await db.query(
                "SELECT id, name, email, language, role, disabled_at FROM users WHERE id = $1 AND role IN ('doctor', 'facility', 'admin') FOR UPDATE",
                [request.params.id]);
            if (!target) throw new HttpError(404, 'not_found', 'Account not found.');
            if (Boolean(target.disabled_at) === disable) throw new HttpError(409, 'wrong_status', disable ? 'This account is already switched off.' : 'This account is already active.');
            const {rows: [updated]} = await db.query(
                `UPDATE users SET disabled_at = ${disable ? 'now()' : 'NULL'} WHERE id = $1 RETURNING id, disabled_at`, [target.id]);
            if (disable) await db.query('DELETE FROM sessions WHERE user_id = $1', [target.id]);
            await audit(db, {actorId: request.user.id, action: disable ? 'account.disabled' : 'account.enabled', targetId: target.id,
                details: note ? {note} : {}, ip: request.ip});
            return {...target, disabled_at: updated.disabled_at};
        });
        if (user.email) await sendEmail(app, user.email, accountEmail(user, disable, note));
        return {account: {id: user.id, disabled_at: user.disabled_at}};
    };

    app.post('/api/admin/users/:id/disable', options, change(true));
    app.post('/api/admin/users/:id/enable', options, change(false));
}
