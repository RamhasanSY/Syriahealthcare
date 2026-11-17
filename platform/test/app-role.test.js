// The app's own database user (production, src/migrate.js prepareAppRole): rows only, nothing else.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createPool} from '../src/db.js';
import {prepareAppRole} from '../src/migrate.js';
import {pool, setup, teardown} from './helpers.js';

const ROLE = 'shc_role_check', PASSWORD = 'role-check-password-123456';
let app, restricted;
before(async () => {
    ({app} = await setup());
    await prepareAppRole(pool, ROLE, PASSWORD);
    await prepareAppRole(pool, ROLE, PASSWORD);  // a second run (every deploy) changes nothing and does not fail
    const url = Object.assign(new URL(process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:54329/shc_test'), {username: ROLE, password: PASSWORD});
    restricted = createPool(url.href);
});
after(async () => {
    await restricted?.end();
    await teardown(app);
});

const refused = async (sql, what) => {
    await assert.rejects(restricted.query(sql), error => ['42501', '42P01'].includes(error.code) || assert.fail(`${what}: ${error.code} ${error.message}`), what);
};

test('it reads and changes rows', async () => {
    await restricted.query("INSERT INTO login_failures (email, ip) VALUES ('x@example.org', '203.0.113.5')");
    const {rows: [row]} = await restricted.query("UPDATE login_failures SET email = 'y@example.org' RETURNING email");
    assert.equal(row.email, 'y@example.org');
    await restricted.query('DELETE FROM login_failures');
    assert.ok((await restricted.query('SELECT count(*) FROM schema_migrations')).rows[0].count > 0);
});

test('it cannot change the schema, the list of migrations, roles, or reach programs on the server', async () => {
    await refused('CREATE TABLE intruder (a int)', 'create a table');
    await refused('DROP TABLE users', 'drop a table');
    await refused('ALTER TABLE users ADD COLUMN x int', 'change a table');
    await refused("INSERT INTO schema_migrations (name) VALUES ('999_fake.sql')", 'fake a migration');
    await refused("COPY (SELECT 1) TO PROGRAM 'true'", 'run a program');
    await refused("SELECT pg_read_file('/etc/passwd')", 'read a server file');
    await refused('CREATE ROLE intruder SUPERUSER', 'make a role');
    const {rows: [role]} = await pool.query('SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = $1', [ROLE]);
    assert.deepEqual(role, {rolsuper: false, rolcreaterole: false, rolcreatedb: false});
});

test('names that are not plain and short passwords are refused', async () => {
    await assert.rejects(prepareAppRole(pool, 'x"; DROP TABLE users; --', PASSWORD), /plain/);
    await assert.rejects(prepareAppRole(pool, ROLE, 'short'), /24 characters/);
});
