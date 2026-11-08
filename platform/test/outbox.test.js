import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {pool, setup, teardown} from './helpers.js';
import {deliverDue, enqueueEmail, MAX_ATTEMPTS, retryMinutes} from '../src/outbox.js';

let app, mail;
beforeEach(async () => {
    await app?.close();
    ({app, mail} = await setup());
});
after(() => teardown(app));

const failing = () => ({async send() { throw new Error('SMTP down'); }});
const log = {warn() {}, error() {}};
const row = id => pool.query('SELECT * FROM email_outbox WHERE id = $1', [id]).then(r => r.rows[0]);

describe('email outbox', () => {
    test('a queued email is sent once and then stays sent', async () => {
        const id = await enqueueEmail(pool, {to: 'lina@example.org', subject: 'Hello', text: 'Body'});
        assert.deepEqual(await deliverDue({pool, mail, log}), {sent: 1, failed: 0});
        assert.equal(mail.sent.at(-1).to, 'lina@example.org');
        assert.ok((await row(id)).sent_at);
        assert.deepEqual(await deliverDue({pool, mail, log}), {sent: 0, failed: 0}, 'not sent twice');
    });

    test('a failed send is retried later, with a growing pause, and then given up', async () => {
        const id = await enqueueEmail(pool, {to: 'lina@example.org', subject: 'Hello', text: 'Body'});
        assert.deepEqual(await deliverDue({pool, mail: failing(), log}), {sent: 0, failed: 1});
        let r = await row(id);
        assert.equal(r.attempts, 1);
        assert.equal(r.last_error, 'SMTP down');
        assert.equal(r.failed_at, null);
        assert.deepEqual(await deliverDue({pool, mail: failing(), log}), {sent: 0, failed: 0}, 'the pause has not passed yet');

        await pool.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
        for (let i = 1; i < MAX_ATTEMPTS; i++) {
            await pool.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
            await deliverDue({pool, mail: failing(), log});
        }
        r = await row(id);
        assert.equal(r.attempts, MAX_ATTEMPTS);
        assert.ok(r.failed_at, 'given up');
        await pool.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
        assert.deepEqual(await deliverDue({pool, mail, log}), {sent: 0, failed: 0}, 'given up mails are not sent again');
    });

    test('the pause grows and is capped at six hours', () => {
        assert.equal(retryMinutes(1), 2);
        assert.equal(retryMinutes(3), 8);
        assert.equal(retryMinutes(20), 360);
    });

    test('a message recovers when the mail server is back', async () => {
        const id = await enqueueEmail(pool, {to: 'lina@example.org', subject: 'Later', text: 'Body'});
        await deliverDue({pool, mail: failing(), log});
        await pool.query("UPDATE email_outbox SET next_attempt_at = now() - interval '1 second'");
        assert.deepEqual(await deliverDue({pool, mail, log}), {sent: 1, failed: 0});
        const r = await row(id);
        assert.ok(r.sent_at);
        assert.equal(r.last_error, null);
    });
});
