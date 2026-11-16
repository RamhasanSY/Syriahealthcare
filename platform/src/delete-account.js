// Removes a doctor or facility account for good, with its documents and their encrypted files.
// Run on the server only, after the account asked for deletion (src/account-deletion.js) and after checking what must
// be kept by law:
//   npm run delete-account -- doctor@example.org
//   npm run delete-account -- lab@example.org --with-results      (also the results this lab issued)
// A lab's results live on in patients' files and doctors' records, so they are deleted only with --with-results.
// An account that did not ask for deletion needs --force.
import {fileURLToPath} from 'node:url';
import {audit, createPool, transaction} from './db.js';

export async function deleteStaffAccount({pool, documents}, email, {withResults = false, force = false} = {}) {
    const result = await transaction(pool, async db => {
        const {rows: [user]} = await db.query(
            "SELECT id, role, name, deletion_requested_at FROM users WHERE email = $1 AND role IN ('doctor', 'facility') FOR UPDATE", [email]);
        if (!user) throw new Error('No doctor or facility account with this email.');
        if (!user.deletion_requested_at && !force) throw new Error('This account did not ask for deletion. Run again with --force to delete it anyway.');
        const {rows: [issued]} = await db.query('SELECT count(*)::int AS n FROM lab_results WHERE facility_id = $1', [user.id]);
        if (issued.n && !withResults) {
            throw new Error(`This account issued ${issued.n} lab results that patients and doctors may still use. Run again with --with-results to delete them too.`);
        }
        const {rows: files} = await db.query(
            `SELECT storage_key FROM doctor_documents WHERE doctor_id = $1
             UNION ALL SELECT storage_key FROM lab_results WHERE facility_id = $1`, [user.id]);
        await db.query('DELETE FROM users WHERE id = $1', [user.id]);
        await audit(db, {action: 'account.deleted', targetId: user.id, details: {role: user.role, files: files.length, results: issued.n}});
        return {user, results: issued.n, keys: files.map(f => f.storage_key)};
    });
    for (const key of result.keys) await documents.remove(key);
    return {name: result.user.name, role: result.user.role, files: result.keys.length, results: result.results};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const email = args.find(a => !a.startsWith('--'))?.trim().toLowerCase();
    if (!email) {
        console.error('Usage: npm run delete-account -- <email> [--with-results] [--force]');
        process.exit(1);
    }
    const {config} = await import('./config.js');
    const {createDocumentStore} = await import('./documents.js');
    const pool = createPool(config.databaseUrl);
    try {
        const done = await deleteStaffAccount({pool, documents: createDocumentStore({dir: config.documentDir, keyHex: config.documentKey})}, email,
            {withResults: args.includes('--with-results'), force: args.includes('--force')});
        console.log(`Deleted ${done.role} account ${email} (${done.name}): ${done.files} files, ${done.results} lab results.`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}
