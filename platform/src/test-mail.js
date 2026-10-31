// Sends one test email through the SMTP mailbox, to check the settings before going live:
//   npm run test-mail -- you@example.com
// Uses SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and MAIL_FROM from the environment (on the server: from .env,
// with `docker compose exec app node src/test-mail.js you@example.com`). Anything missing is asked for; the password hidden.
import {createInterface} from 'node:readline/promises';
import {createMail} from './mail.js';
import {askHidden} from './prompt.js';
import {normalizeEmail} from './security.js';

const to = normalizeEmail(process.argv[2]);
if (!to) {
    console.error('Usage: npm run test-mail -- you@example.com');
    process.exit(1);
}
const env = process.env;
let user = env.SMTP_USER;
if (!user) {
    const rl = createInterface({input: process.stdin, output: process.stdout});
    user = (await rl.question('Mailbox (SMTP user), e.g. noreply@syriahealthcare.com: ')).trim();
    rl.close();
}
const password = env.SMTP_PASSWORD || await askHidden(`Password of ${user}: `);
const config = {
    mailProvider: 'smtp',
    smtp: {host: env.SMTP_HOST || 'smtp.strato.de', port: Number(env.SMTP_PORT || 465), user, password},
    mailFrom: env.MAIL_FROM || `Syria Healthcare <${user}>`
};
console.log(`Sending from ${config.mailFrom} to ${to} through ${config.smtp.host}:${config.smtp.port} ...`);
try {
    await createMail(config).send({
        to,
        subject: 'Test email from Syria Healthcare / رسالة تجريبية',
        text: 'This is a test from the Syria Healthcare platform. If you can read it, sending emails works.\n\nهذه رسالة تجريبية من منصة الرعاية الصحية في سوريا. إن وصلتك، فإرسال البريد يعمل.'
    });
    console.log('Sent. Check the inbox, and the spam folder if it is not there.');
} catch (error) {
    console.error(`Not sent: ${error.message}`);
    if (error.code === 'EAUTH') console.error('The mailbox or password is wrong.');
    process.exit(1);
}
