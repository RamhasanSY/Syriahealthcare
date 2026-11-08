// Emails to doctors, facilities and admins. Every email is in both languages, the account's own language first.
// A failed email is logged but never undoes the action that triggered it.
import {facilityKinds} from './catalog.js';

const RULE = '\n\n— — —\n\n';
const both = (language, ar, en) => language === 'en' ? en + RULE + ar : ar + RULE + en;

export async function sendEmail(app, to, message) {
    try {
        await app.mail.send({to, ...message});
    } catch (error) {
        app.log.error({err: error, subject: message.subject}, 'Email delivery failed');
    }
}

// Patient sign-in code by email. The code is in the subject too, so it shows in the phone's notification,
// as SMS codes do. There may be no account yet, so the language is the one chosen on the sign-in page.
export const emailCodeEmail = (language, code, minutes) => ({
    subject: language === 'en' ? `SyriaHC sign-in code: ${code}` : `رمز الدخول إلى صحة تك: ${code}`,
    text: both(language,
        `رمز الدخول الخاص بك: ${code}

الرمز صالح لمدة ${minutes} دقيقة. أدخله في صفحة تسجيل الدخول.
لا تعطِ هذا الرمز لأي شخص، فلن يطلبه منك فريق صحة تك أبداً.
إن لم تطلب هذا الرمز فتجاهل هذه الرسالة.`,
        `Your sign-in code: ${code}

The code is valid for ${minutes} minutes. Enter it on the sign-in page.
Never give this code to anyone; the SyriaHC team will never ask you for it.
If you did not ask for this code, ignore this email.`)
});

// Someone asked for a patient code for an address that belongs to a doctor or facility account. No code is sent;
// the screen looks the same as for any address, so nobody learns which addresses have staff accounts.
export const staffAddressEmail = (user, origin) => ({
    subject: user.language === 'en' ? 'Sign in to SyriaHC with your password' : 'سجّل الدخول إلى صحة تك بكلمة المرور',
    text: both(user.language,
        `مرحباً ${user.name}،

طُلب رمز دخول للمرضى لهذا العنوان، لكنه مرتبط بحساب طبيب أو منشأة. سجّل الدخول ببريدك وكلمة المرور من هنا:

${origin}/staff

إن لم تطلب ذلك فتجاهل هذه الرسالة.`,
        `Hello ${user.name},

Someone asked for a patient sign-in code for this address, but it belongs to a doctor or facility account. Sign in with your email and password here:

${origin}/staff

If this was not you, ignore this email.`)
});

export const resetEmail = (user, link, minutes) => ({
    subject: user.language === 'en' ? 'Reset your SyriaHC password' : 'إعادة تعيين كلمة المرور — صحة تك',
    text: both(user.language,
        `مرحباً ${user.name}،\n\nطلب أحدهم إعادة تعيين كلمة مرور حسابك. افتح هذا الرابط خلال ${minutes} دقيقة لاختيار كلمة مرور جديدة:\n\n${link}\n\nيعمل الرابط مرة واحدة فقط. إن لم تطلب ذلك فتجاهل هذه الرسالة، وتبقى كلمة مرورك كما هي.`,
        `Hello ${user.name},\n\nSomeone asked to reset the password of your account. Open this link within ${minutes} minutes to choose a new password:\n\n${link}\n\nThe link works only once. If this was not you, ignore this email; your password stays the same.`)
});

export const passwordChangedEmail = (user, origin) => ({
    subject: user.language === 'en' ? 'Your SyriaHC password was changed' : 'تم تغيير كلمة المرور — صحة تك',
    text: both(user.language,
        `مرحباً ${user.name}،\n\nتم تغيير كلمة مرور حسابك وتسجيل الخروج من جميع الأجهزة.\nإن لم تكن أنت من غيّرها، فاطلب رابطاً جديداً فوراً من ${origin}/forgot وتواصل مع الدعم.`,
        `Hello ${user.name},\n\nThe password of your account was changed and all devices were signed out.\nIf this was not you, request a new link right away at ${origin}/forgot and contact support.`)
});

export const welcomeEmail = (user, origin) => ({
    subject: user.language === 'en' ? 'Welcome to SyriaHC' : 'أهلاً بك في صحة تك',
    text: both(user.language,
        `مرحباً ${user.name}،\n\nتم إنشاء حسابك. الخطوات التالية: أكمل البيانات، وارفع الترخيص، ثم أرسلها للمراجعة. سنراسلك عند صدور القرار.\n\n${origin}/account\n\nإن لم تنشئ هذا الحساب فتجاهل هذه الرسالة.`,
        `Hello ${user.name},\n\nYour account has been created. Next steps: complete your details, upload your licence, then send them for review. We will email you when we have decided.\n\n${origin}/account\n\nIf you did not create this account, ignore this email.`)
});

// Review decisions. `kind` is 'doctor' or a facility kind (lab, imaging, hospital, clinic).
export function decisionEmail(user, kind, status, note, origin) {
    const doctor = kind === 'doctor', page = `${origin}/${doctor ? 'doctor' : 'facility'}`;
    const texts = {
        approved: {
            subject: ['Your profile is approved', 'تم اعتماد ملفك'],
            en: doctor ? 'Your profile has been approved. Patients can now find you and book appointments.'
                : 'Your listing has been approved. It appears on syriahc.com within about 12 hours, as the website is updated twice a day.',
            ar: doctor ? 'تم اعتماد ملفك. يمكن للمرضى الآن إيجادك وحجز المواعيد لديك.'
                : 'تم اعتماد منشأتكم. ستظهر على syriahc.com خلال 12 ساعة تقريباً، إذ يُحدَّث الموقع مرتين يومياً.'
        },
        rejected: {
            subject: ['Changes needed on your profile', 'مطلوب تعديلات على ملفك'],
            en: `We need some changes before we can approve your profile:\n\n${note}\n\nPlease update it and send it again:`,
            ar: `نحتاج إلى بعض التعديلات قبل اعتماد ملفك:\n\n${note}\n\nيرجى تعديله وإرساله مجدداً:`
        },
        suspended: {
            subject: ['Your profile has been suspended', 'تم إيقاف ملفك'],
            en: `Your profile has been suspended and is hidden from the public:\n\n${note}\n\nPlease contact support.`,
            ar: `تم إيقاف ملفك وإخفاؤه عن العموم:\n\n${note}\n\nيرجى التواصل مع الدعم.`
        }
    }[status];
    return {
        subject: (user.language === 'en' ? texts.subject[0] : texts.subject[1]) + (user.language === 'en' ? ' — SyriaHC' : ' — صحة تك'),
        text: both(user.language, `مرحباً ${user.name}،\n\n${texts.ar}\n\n${page}`, `Hello ${user.name},\n\n${texts.en}\n\n${page}`)
    };
}

// The doctor's decision on a patient's appointment, for patients who have an email address.
// `when` is the Syria-time "2026-10-14 10:00" string also used in the SMS; the doctor's note arrives without its
// final full stop (the SMS adds its own), so it is added back here.
export function appointmentEmail(patient, status, {doctorName, when, address, note}, origin) {
    const said = note ? `:\n\n${note}.` : '.';
    const texts = {
        confirmed: {
            subject: ['Your appointment is confirmed', 'تم تأكيد موعدك'],
            en: `${doctorName} has confirmed your appointment on ${when} (Syria time).\nAddress: ${address}`,
            ar: `أكّد ${doctorName} موعدك في ${when} (بتوقيت سوريا).\nالعنوان: ${address}`
        },
        declined: {
            subject: ['Your appointment request was declined', 'تم الاعتذار عن طلب موعدك'],
            en: `${doctorName} cannot see you on ${when}${said}\n\nYou can choose another time.`,
            ar: `اعتذر ${doctorName} عن موعد ${when}${said}\n\nيمكنك اختيار وقت آخر.`
        },
        cancelled_by_doctor: {
            subject: ['Your appointment was cancelled', 'تم إلغاء موعدك'],
            en: `${doctorName} has cancelled your appointment on ${when}${said}`,
            ar: `ألغى ${doctorName} موعدك في ${when}${said}`
        }
    }[status];
    if (!texts) return null;
    return {
        subject: (patient.language === 'en' ? texts.subject[0] : texts.subject[1]) + (patient.language === 'en' ? ' — SyriaHC' : ' — صحة تك'),
        text: both(patient.language, `مرحباً ${patient.name}،\n\n${texts.ar}\n\n${origin}/appointments`, `Hello ${patient.name},\n\n${texts.en}\n\n${origin}/appointments`)
    };
}

// Tells every admin that a profile is waiting for review.
export async function notifyAdminsOfSubmission(app, user, kind, displayName) {
    const {rows: admins} = await app.pg.query("SELECT email FROM users WHERE role = 'admin' AND disabled_at IS NULL AND email IS NOT NULL");
    const what = kind === 'doctor' ? ['Doctor', 'طبيب'] : facilityKinds[kind];
    const message = {
        subject: `New profile to review / ملف جديد للمراجعة: ${what[0]}`,
        text: `${what[0]}: ${displayName}\nAccount: ${user.name} <${user.email}>\n\n${app.config.appOrigin}/admin` + RULE +
            `${what[1]}: ${displayName}\nالحساب: ${user.name} <${user.email}>\n\n${app.config.appOrigin}/admin`
    };
    for (const admin of admins) await sendEmail(app, admin.email, message);
}
