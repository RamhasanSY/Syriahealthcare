import {config} from './config.js';
import {buildApp} from './app.js';
import {createPool} from './db.js';
import {migrate} from './migrate.js';
import {deliverDue} from './outbox.js';

const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp({config, pool});

// Send queued emails every 5 minutes; failed ones are retried by the queue itself.
setInterval(() => {
    deliverDue({pool, mail: app.mail, log: app.log})
        .catch(error => app.log.error({err: error}, 'Email queue failed'));
}, 300_000).unref();

// Remove expired sessions, codes and password links every hour.
setInterval(() => {
    pool.query(`DELETE FROM sessions WHERE expires_at < now();
        DELETE FROM otp_codes WHERE created_at < now() - interval '1 day';
        DELETE FROM staff_login_codes WHERE created_at < now() - interval '1 day';
        DELETE FROM login_failures WHERE created_at < now() - interval '1 day';
        DELETE FROM password_resets WHERE created_at < now() - interval '1 day'`)
        .catch(error => app.log.error({err: error}, 'Cleanup failed'));
}, 3600_000).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await app.close();
        await pool.end();
        process.exit(0);
    });
}
await app.listen({port: config.port, host: config.host});
