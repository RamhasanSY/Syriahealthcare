// Chooses how a patient is reached. Sign-in codes: WhatsApp where Meta delivers, then Telegram (Telegram Gateway) where the
// number has Telegram, then SMS. Appointment updates: WhatsApp, then SMS (the Telegram Gateway carries codes only).
// If one channel refuses a message, the next one is tried, so a patient is never left without their code.

export const whatsappReaches = (app, phone) =>
    Boolean(app.whatsapp) && !app.config.whatsapp.blockedPrefixes.some(prefix => phone.startsWith(prefix));

// Sends a sign-in code. Returns the channel that was used: 'whatsapp', 'telegram' or 'sms'.
// `channel: 'sms'` forces SMS, for "I did not get the message" (e.g. WhatsApp or Telegram not opened on this phone).
export async function sendCode(app, request, phone, code, {language, minutes, channel}) {
    if (channel !== 'sms' && whatsappReaches(app, phone)) {
        try {
            await app.whatsapp.sendTemplate(phone, {name: app.config.whatsapp.templates.code, language, params: [code], copyCode: code});
            return 'whatsapp';
        } catch (error) {
            request.log.error({err: error}, 'WhatsApp code failed, trying the next channel');
        }
    }
    if (channel !== 'sms' && app.telegram) {
        try {
            await app.telegram.sendCode(phone, code, minutes * 60);
            return 'telegram';
        } catch (error) {
            // Usually just a number without Telegram; checking that costs nothing.
            request.log.warn({err: error}, 'Telegram code not possible, sending SMS instead');
        }
    }
    await app.sms.send(phone, `رمز الدخول إلى الرعاية الصحية في سوريا: ${code} (صالح ${minutes} دقائق)\nSyria Healthcare sign-in code: ${code}`);
    return 'sms';
}

// Tells a patient that the doctor confirmed, declined or cancelled. `smsText` is used when WhatsApp is not possible.
export async function sendAppointmentUpdate(app, request, phone, {status, language, params, smsText}) {
    const name = app.config.whatsapp.templates[status];
    if (name && whatsappReaches(app, phone)) {
        try {
            await app.whatsapp.sendTemplate(phone, {name, language, params});
            return 'whatsapp';
        } catch (error) {
            request.log.error({err: error}, 'WhatsApp appointment message failed, sending SMS instead');
        }
    }
    await app.sms.send(phone, smsText);
    return 'sms';
}
