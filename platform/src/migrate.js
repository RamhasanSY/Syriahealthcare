// Applies migrations/*.sql in order, once each. Safe to run on every deploy.
import {readdir, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createPool, transaction} from './db.js';

const folder = fileURLToPath(new URL('../migrations/', import.meta.url));

export async function migrate(pool) {
    // Only created when missing: the app's own database user may read the list but not create anything.
    const {rows: [{exists}]} = await pool.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS exists");
    if (!exists) await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const applied = [];
    for (const name of (await readdir(folder)).filter(f => f.endsWith('.sql')).sort()) {
        if (done.has(name)) continue;
        const sql = await readFile(folder + name, 'utf8');
        await transaction(pool, async db => {
            await db.query('SET LOCAL statement_timeout = 0');  // building an index on a big table may take longer than the app's 15 s
            await db.query(sql);
            await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        });
        applied.push(name);
    }
    return applied;
}

// The app's own database user (production, APP_DB_USER): it may read and change rows, and nothing else. It cannot create
// or drop tables, make roles, or reach files and programs on the server (COPY ... TO PROGRAM needs a superuser), so even
// a mistake that let someone run their own SQL could not take over the database server. Created or updated here by the
// owner after every migration, so new tables are always included.
export async function prepareAppRole(pool, user, password) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error('APP_DB_USER must be a plain lower-case name');
    if (typeof password !== 'string' || password.length < 24) throw new Error('APP_DB_PASSWORD must be at least 24 characters');
    const {rows: [found]} = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    const {rows: [role]} = await pool.query(
        `SELECT format('%s ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', $3::text, $1::text, $2::text) AS sql`,
        [user, password, found ? 'ALTER' : 'CREATE']);
    await pool.query(role.sql);
    for (const statement of [
        'GRANT USAGE ON SCHEMA public TO %I',
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
        'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
        'REVOKE INSERT, UPDATE, DELETE ON schema_migrations FROM %I'
    ]) {
        const {rows: [grant]} = await pool.query('SELECT format($1, $2::text) AS sql', [statement, user]);
        await pool.query(grant.sql);
    }
}

// "node src/migrate.js": run by the one-off "migrate" container before the app starts (docker-compose.yml), with the
// database owner. Reads DATABASE_URL directly, so it needs none of the app's other secrets.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const pool = createPool(process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/shc_dev');
    const applied = await migrate(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date.');
    if (process.env.APP_DB_USER) {
        await prepareAppRole(pool, process.env.APP_DB_USER, process.env.APP_DB_PASSWORD);
        console.log(`Database user ${process.env.APP_DB_USER} may read and change rows only.`);
    }
    await pool.end();
}
