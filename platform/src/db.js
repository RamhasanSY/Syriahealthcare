import pg from 'pg';

// Calendar dates (birth dates, document dates) stay "YYYY-MM-DD" text. As JavaScript dates they would be read at local
// midnight and could shift by a day when turned back into text on a computer outside UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);

// No query may run longer than 15 seconds and no transaction may sit idle for more than 30: one slow or stuck request
// cannot hold the small server's connections (migrations lift the limit for themselves, src/migrate.js).
export function createPool(connectionString) {
    return new pg.Pool({connectionString, max: 10, statement_timeout: 15000, idle_in_transaction_session_timeout: 30000});
}

// Runs fn inside a transaction and returns its result.
// For "count, check the limit, then insert" inside a transaction: one request per key at a time, so parallel requests
// cannot all pass the count. A request that finds the key busy gets false at once instead of waiting, which would hold
// one of the few database connections. The lock ends with the transaction.
export async function tryLock(db, key) {
    const {rows: [lock]} = await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [key]);
    return lock.ok;
}

export async function transaction(pool, fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

export async function audit(db, {actorId = null, action, targetId = null, details = {}, ip = null}) {
    await db.query('INSERT INTO audit_log (actor_id, action, target_id, details, ip) VALUES ($1, $2, $3, $4, $5)',
        [actorId, action, targetId, details, ip]);
}
