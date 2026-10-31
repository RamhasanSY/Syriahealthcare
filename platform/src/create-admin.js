// Creates (or resets the password of) an admin account:
//   npm run create-admin -- admin@example.com "Full Name"
// The password is typed in hidden, or taken from ADMIN_PASSWORD for automated setups.
import {config} from './config.js';
import {audit, createPool} from './db.js';
import {migrate} from './migrate.js';
import {askHidden} from './prompt.js';
import {hashPassword, normalizeEmail, passwordProblem} from './security.js';

const [rawEmail, ...nameParts] = process.argv.slice(2);
const email = normalizeEmail(rawEmail), name = nameParts.join(' ').trim() || 'Administrator';
if (!email) {
    console.error('Usage: npm run create-admin -- admin@example.com "Full Name"');
    process.exit(1);
}

const password = process.env.ADMIN_PASSWORD || await askHidden('Admin password (at least 10 characters): ');
const problem = passwordProblem(password);
if (problem) {
    console.error(problem);
    process.exit(1);
}
const pool = createPool(config.databaseUrl);
await migrate(pool);
const {rows: [user]} = await pool.query(
    `INSERT INTO users (role, name, email, password_hash, consented_at) VALUES ('admin', $1, $2, $3, now())
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', disabled_at = NULL
     RETURNING id`, [name, email, await hashPassword(password)]);
await pool.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
await audit(pool, {action: 'admin.created_from_cli', targetId: user.id, details: {email}});
console.log(`Admin account ready: ${email}`);
await pool.end();
