// Master patient index (stage 2b): merges two profiles of the same person into one.
// Run on the server only, after checking with the person (administrators have no route to health files):
//   npm run merge-patients -- SHC-AAAA-BBBB-C SHC-DDDD-EEEE-F      (the first is merged into the second)
// Entries, consents, appointments, logins and identifiers move to the surviving profile. The merged profile stays as an
// empty record with merged_into set, so old links and its patient number keep leading to the right person (src/access.js).
import {fileURLToPath} from 'node:url';
import {audit, createPool, transaction} from './db.js';
import {cleanPatientNumber} from './patient-number.js';

export async function mergePatients(db, fromId, intoId, {actorId = null} = {}) {
    if (fromId === intoId) throw new Error('A profile cannot be merged into itself.');
    const {rows} = await db.query('SELECT id, merged_into, birth_date FROM patients WHERE id = ANY($1) FOR UPDATE', [[fromId, intoId]]);
    const from = rows.find(r => r.id === fromId), into = rows.find(r => r.id === intoId);
    if (!from || !into) throw new Error('Both profiles must exist.');
    if (from.merged_into || into.merged_into) throw new Error('One of the profiles was already merged.');

    const moved = {};
    moved.documents = (await db.query('UPDATE clinical_documents SET patient_id = $2, updated_at = now() WHERE patient_id = $1', [fromId, intoId])).rowCount;
    moved.appointments = (await db.query('UPDATE appointments SET subject_id = $2 WHERE subject_id = $1', [fromId, intoId])).rowCount;
    // One active consent is enough; the merged profile's own consent stays in the history as withdrawn.
    await db.query(`UPDATE consents SET withdrawn_at = now() WHERE patient_id = $1 AND withdrawn_at IS NULL
        AND EXISTS (SELECT 1 FROM consents WHERE patient_id = $2 AND withdrawn_at IS NULL)`, [fromId, intoId]);
    moved.consents = (await db.query('UPDATE consents SET patient_id = $2 WHERE patient_id = $1', [fromId, intoId])).rowCount;
    // Logins that could open the merged profile can now open the surviving one (same relationship).
    // (A login that could already open both keeps its access to the surviving one only.)
    await db.query('DELETE FROM patient_access f USING patient_access i WHERE f.patient_id = $1 AND i.patient_id = $2 AND i.user_id = f.user_id', [fromId, intoId]);
    moved.logins = (await db.query('UPDATE patient_access SET patient_id = $2 WHERE patient_id = $1', [fromId, intoId])).rowCount;
    moved.identifiers = (await db.query('UPDATE patient_identifiers SET patient_id = $2 WHERE patient_id = $1', [fromId, intoId])).rowCount;
    if (!into.birth_date && from.birth_date) await db.query('UPDATE patients SET birth_date = $2 WHERE id = $1', [intoId, from.birth_date]);
    await db.query('UPDATE patients SET merged_into = $2, updated_at = now() WHERE id = $1', [fromId, intoId]);
    await db.query('UPDATE patients SET updated_at = now() WHERE id = $1', [intoId]);
    await audit(db, {actorId, action: 'patient.merged', targetId: intoId, details: {patient_id: intoId, merged: fromId, ...moved}});
    return moved;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [fromNumber, intoNumber] = process.argv.slice(2).map(cleanPatientNumber);
    if (!fromNumber || !intoNumber) {
        console.error('Usage: npm run merge-patients -- <patient number to merge away> <patient number to keep>');
        process.exit(1);
    }
    const {config} = await import('./config.js');
    const pool = createPool(config.databaseUrl);
    try {
        const {rows} = await pool.query('SELECT id, patient_number, name FROM patients WHERE patient_number = ANY($1)', [[fromNumber, intoNumber]]);
        const from = rows.find(r => r.patient_number === fromNumber), into = rows.find(r => r.patient_number === intoNumber);
        if (!from || !into) throw new Error('Patient number not found.');
        const moved = await transaction(pool, db => mergePatients(db, from.id, into.id));
        console.log(`Merged ${from.patient_number} (${from.name}) into ${into.patient_number} (${into.name}):`, moved);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}
