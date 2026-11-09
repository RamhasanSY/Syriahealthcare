import {config} from './config.js';
import {buildApp} from './app.js';
import {createPool} from './db.js';
import {migrate} from './migrate.js';
import {startJobs} from './jobs.js';

const pool = createPool(config.databaseUrl);
await migrate(pool);
const app = await buildApp({config, pool});

// Email queue, clean-up and disk check (src/jobs.js).
startJobs({pool, mail: app.mail, log: app.log, dir: config.documentDir});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
        await app.close();
        await pool.end();
        process.exit(0);
    });
}
await app.listen({port: config.port, host: config.host});
