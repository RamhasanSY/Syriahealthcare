// Sends emails as plain text, so names and review notes typed by users can never turn into links or markup.
import nodemailer from 'nodemailer';

export function createMail(config, log) {
    if (config.mailProvider === 'console') {
        return {
            async send({to, subject, text}) {
                log.warn({to}, `[development email] ${subject}\n${text}`);
            }
        };
    }
    if (config.mailProvider === 'smtp') {
        const {host, port, user, password} = config.smtp;
        if (!host || !user || !password) throw new Error('SMTP_HOST, SMTP_USER and SMTP_PASSWORD are required for MAIL_PROVIDER=smtp');
        const transport = nodemailer.createTransport({
            host, port, secure: port === 465, requireTLS: port !== 465, auth: {user, pass: password},
            tls: {minVersion: 'TLSv1.2'}, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
            disableFileAccess: true, disableUrlAccess: true
        });
        return {
            async send({to, subject, text}) {
                await transport.sendMail({from: config.mailFrom, to, subject, text});
            }
        };
    }
    if (config.mailProvider === 'test') {
        const sent = [];
        return {sent, async send(message) { sent.push(message); }};
    }
    throw new Error(`Unknown MAIL_PROVIDER ${config.mailProvider}`);
}
