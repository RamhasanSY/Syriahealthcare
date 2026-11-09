// The one place that decides who may open which health file (stage 2b; stage 2c adds doctors with a share).
// Used by /api/file and by FHIR. Outside a relationship the answer is always "not found" (404), never "forbidden",
// so nobody can find out whether a profile exists. Merged profiles are followed to the profile they were merged into.
import {HttpError} from './auth.js';
import {newPatientNumber, PATIENT_NUMBER_SYSTEM} from './patient-number.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const notFound = () => new HttpError(404, 'not_found', 'Not found.');

// Follows merged_into to the surviving profile (at most a few steps; a loop is impossible by construction).
export async function resolvePatient(db, patientId) {
    if (!UUID.test(String(patientId))) return null;
    let id = patientId;
    for (let i = 0; i < 10; i++) {
        const {rows: [p]} = await db.query('SELECT id, merged_into FROM patients WHERE id = $1', [id]);
        if (!p) return null;
        if (!p.merged_into) return p.id;
        id = p.merged_into;
    }
    return null;
}

// Every profile this login may open, with the relationship ('self' or 'child'). Profiles merged away are left out.
export async function ownProfiles(db, userId) {
    const {rows} = await db.query(
        `SELECT p.*, a.relationship FROM patient_access a JOIN patients p ON p.id = a.patient_id
         WHERE a.user_id = $1 AND p.merged_into IS NULL ORDER BY a.relationship = 'self' DESC, p.created_at`, [userId]);
    return rows;
}

// Loads one profile for a signed-in patient, or throws 404. Returns the profile with its relationship.
export async function patientFor(db, user, patientId) {
    if (!user || user.role !== 'patient') throw notFound();
    const id = await resolvePatient(db, patientId);
    if (!id) throw notFound();
    const {rows: [p]} = await db.query(
        `SELECT p.*, a.relationship FROM patients p JOIN patient_access a ON a.patient_id = p.id AND a.user_id = $2 WHERE p.id = $1`,
        [id, user.id]);
    if (!p) throw notFound();
    return p;
}

// Creates a profile with a fresh patient number (retrying in the very unlikely case the number is taken).
export async function createPatient(db, {name, birthDate = null, sex = null}) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const number = newPatientNumber();
        const {rows: [p]} = await db.query(
            `INSERT INTO patients (patient_number, name, birth_date, sex) VALUES ($1, $2, $3, $4)
             ON CONFLICT (patient_number) DO NOTHING RETURNING *`, [number, name, birthDate, sex]);
        if (p) {
            await db.query('INSERT INTO patient_identifiers (patient_id, system, value) VALUES ($1, $2, $3)', [p.id, PATIENT_NUMBER_SYSTEM, number]);
            return p;
        }
    }
    throw new Error('Could not create a unique patient number');
}

// The own profile of a patient login, created on first need (sign-in, booking, opening the file).
export async function ensureSelfProfile(db, user) {
    if (user.role !== 'patient') return null;
    const {rows: [existing]} = await db.query(
        `SELECT p.* FROM patient_access a JOIN patients p ON p.id = a.patient_id WHERE a.user_id = $1 AND a.relationship = 'self'`, [user.id]);
    if (existing) return existing.merged_into ? {...existing, id: await resolvePatient(db, existing.id)} : existing;
    const p = await createPatient(db, {name: user.name});
    const {rowCount} = await db.query(
        `INSERT INTO patient_access (user_id, patient_id, relationship) VALUES ($1, $2, 'self') ON CONFLICT DO NOTHING`, [user.id, p.id]);
    if (rowCount) return p;
    // Another request created it at the same moment: use that one and drop ours.
    await db.query('DELETE FROM patients WHERE id = $1', [p.id]);
    return ensureSelfProfile(db, user);
}
