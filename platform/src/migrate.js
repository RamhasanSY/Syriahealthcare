// Applies migrations/*.sql in order, once each. Safe to run on every deploy.
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPool, transaction} from './db.js';

const folder = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const applied = [];
    for (const name of (await readdir(folder)).filter(f => f.endsWith('.sql')).sort()) {
        if (done.has(name)) continue;
        const sql = await readFile(folder + name, 'utf8');
        await transaction(pool, async db => {
            await db.query(sql);
            await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        });
        applied.push(name);
    }
    return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const {config} = await import('./config.js');
    const pool = createPool(config.databaseUrl);
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
    await pool.end();
}
