// Email queue: a message is stored first, then sent by a worker. A failed send is retried after a growing pause
// (2, 4, 8 ... minutes, at most 6 hours) and given up after MAX_ATTEMPTS. Nothing is lost while the mail server is down.
export const MAX_ATTEMPTS = 8;

export async function enqueueEmail(db, {to, subject, text}) {
    const {rows: [row]} = await db.query(
        'INSERT INTO email_outbox (to_address, subject, body) VALUES ($1, $2, $3) RETURNING id', [to, subject, text]);
    return row.id;
}

export const retryMinutes = attempts => Math.min(2 ** attempts, 360);

// Sends the due messages. Rows are locked while being sent, so two workers never send the same message twice.
export async function deliverDue({pool, mail, log, limit = 20}) {
    const client = await pool.connect();
    let sent = 0, failed = 0;
    try {
        await client.query('BEGIN');
        const {rows} = await client.query(
            `SELECT id, to_address, subject, body, attempts FROM email_outbox
             WHERE sent_at IS NULL AND failed_at IS NULL AND next_attempt_at <= now()
             ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
        for (const row of rows) {
            try {
                await mail.send({to: row.to_address, subject: row.subject, text: row.body});
                await client.query('UPDATE email_outbox SET sent_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1', [row.id]);
                sent++;
            } catch (error) {
                const attempts = row.attempts + 1;
                log?.warn({err: error, id: row.id, attempts}, 'Email not sent, will retry');
                const giveUp = attempts >= MAX_ATTEMPTS;
                await client.query(
                    `UPDATE email_outbox SET attempts = $2, last_error = $3,
                        failed_at = CASE WHEN $4 THEN now() END,
                        next_attempt_at = now() + make_interval(mins => $5)
                     WHERE id = $1`,
                    [row.id, attempts, String(error.message || error).slice(0, 300), giveUp, retryMinutes(attempts)]);
                failed++;
            }
        }
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
    return {sent, failed};
}
