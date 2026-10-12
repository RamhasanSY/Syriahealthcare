import pg from 'pg';

export function createPool(connectionString) {
    return new pg.Pool({connectionString, max: 10});
}

// Runs fn inside a transaction and returns its result.
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
