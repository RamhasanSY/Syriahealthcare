import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {pool, setup, signIn, teardown} from './helpers.js';
import {checkDisk, cleanup, diskIsLow, diskSpace, DISK_LIMITS} from '../src/jobs.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
    await pool.query('TRUNCATE email_outbox');
});
after(() => teardown(app));

const GB = 1024 ** 3;
// A fake statfs: 4 KB blocks, `total` and `free` in bytes.
const stat = (total, free) => async () => ({bsize: 4096, blocks: total / 4096, bavail: free / 4096});
const log = {warn() {}, error() {}};

describe('clean-up', () => {
    test('removes expired sessions and codes and old emails, keeps current ones', async () => {
        await signIn(post, 'admin', 'admin@example.org');
        const {rows: [{id}]} = await pool.query("SELECT id FROM users WHERE email = 'admin@example.org'");
        await pool.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old', $1, now() - interval '1 minute')", [id]);
        await pool.query("INSERT INTO otp_codes (phone, code_hash, expires_at, created_at) VALUES ('+963912345678', 'x', now(), now() - interval '2 days'), ('+963912345678', 'y', now() + interval '5 minutes', now())");
        await pool.query("INSERT INTO login_failures (email, created_at) VALUES ('a@example.org', now() - interval '2 days')");
        await pool.query(`INSERT INTO email_outbox (to_address, subject, body, sent_at) VALUES
            ('a@example.org', 'old', 'b', now() - interval '31 days'), ('a@example.org', 'new', 'b', now() - interval '1 day'), ('a@example.org', 'queued', 'b', NULL)`);

        const removed = await cleanup(pool);
        assert.equal(removed.sessions, 1);
        assert.equal(removed.otp_codes, 1);
        assert.equal(removed.login_failures, 1);
        assert.equal(removed.email_outbox, 1);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1, 'the live admin session stays');
        assert.deepEqual((await pool.query('SELECT subject FROM email_outbox ORDER BY id')).rows.map(r => r.subject), ['new', 'queued']);
    });
});

describe('disk space warning', () => {
    test('measures free space and knows when it is low', async () => {
        assert.deepEqual(await diskSpace('/', stat(60 * GB, 30 * GB)), {total: 60 * GB, free: 30 * GB, share: 0.5});
        assert.equal(await diskSpace('/', async () => { throw new Error('ENOSYS'); }), null, 'unknown is not low');
        assert.equal(diskIsLow({total: 60 * GB, free: 30 * GB, share: 0.5}), false);
        assert.equal(diskIsLow({total: 60 * GB, free: 1.5 * GB, share: 0.025}), true, 'under 2 GB');
        assert.equal(diskIsLow({total: 1000 * GB, free: 50 * GB, share: 0.05}), true, 'under 10 %');
        assert.equal(diskIsLow(null), false);
        assert.ok(DISK_LIMITS.minFreeBytes > 0);
    });

    test('emails every active administrator, at most once a day', async () => {
        await signIn(post, 'admin', 'admin@example.org');
        await signIn(post, 'admin', 'gone@example.org', 'Former Admin');
        await pool.query("UPDATE users SET disabled_at = now() WHERE email = 'gone@example.org'");
        const state = {}, low = stat(60 * GB, GB);
        const first = await checkDisk({pool, dir: '/', log, state, stat: low, now: 1_000_000});
        assert.equal(first.low, true);
        assert.equal(first.warned, 1, 'only the active administrator');
        const {rows} = await pool.query('SELECT to_address, subject, body FROM email_outbox');
        assert.deepEqual(rows.map(r => r.to_address), ['admin@example.org']);
        assert.match(rows[0].body, /1\.0 GB of 60\.0 GB/);

        assert.equal((await checkDisk({pool, dir: '/', log, state, stat: low, now: 1_000_000 + 3600_000})).warned, 0, 'not again within a day');
        assert.equal((await checkDisk({pool, dir: '/', log, state, stat: low, now: 1_000_000 + 25 * 3600_000})).warned, 1, 'again the next day');
        assert.equal((await checkDisk({pool, dir: '/', log, state: {}, stat: stat(60 * GB, 30 * GB)})).low, false);
    });
});
