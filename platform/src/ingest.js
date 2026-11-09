// One way in for results and documents sent by lab and clinic software (stage 2d), used by FHIR (src/fhir/write.js)
// and HL7 v2 (src/hl7v2.js), so both store exactly the same data.
// - The sender is always the facility of the access token, never a name inside the message.
// - The sender's own number (lab number, document number) makes a repeated send harmless: the first one is kept.
// - The result goes straight into the patient's health file only when the SyriaHC patient number AND the birth year
//   match a profile that agreed to keep a file. Otherwise it is stored like a result uploaded in the app, and the
//   sender gets a slip code to print. The sender only learns "delivered" or "not delivered", never anything from the file.
import {cleanPatientNumber, PATIENT_NUMBER_SYSTEM} from './patient-number.js';
import {resolvePatient} from './access.js';
import {audit} from './db.js';
import {MAX_DOCUMENT_BYTES} from './documents.js';
import {newResultCode} from './results.js';
import {normalizePhone, resultCodeHash} from './security.js';
import {cleanUpload, UploadError} from './uploads.js';

export class IngestError extends Error {
    // code: a short reason; field: where in the message (for HL7 v2 ERR and FHIR OperationOutcome expression).
    constructor(code, message, field) {
        super(message);
        this.code = code;
        this.field = field;
    }
}

const CODE_DAYS = 90;
export const CATEGORY_BY_LOINC = {'11502-2': 'lab', '18748-4': 'imaging', '11488-4': 'report', '57833-6': 'prescription', '18842-5': 'discharge',
    '34105-7': 'discharge', '11369-6': 'vaccination'};

// item: {patient: {name, phone, number, birthYear}, title, category, externalId, file: {buffer, mime?, filename}, observations, source}
export async function ingest(app, client, item, {ip = null} = {}) {
    const name = String(item.patient?.name || '').trim();
    if (name.length < 2 || name.length > 120) throw new IngestError('patient_name', 'The patient\'s name is missing.', 'Patient.name');
    const phone = normalizePhone(String(item.patient?.phone || ''));
    if (!phone) throw new IngestError('patient_phone', 'The patient\'s mobile number is missing or not valid.', 'Patient.telecom');
    const title = String(item.title || '').trim().slice(0, 120);
    if (title.length < 2) throw new IngestError('title', 'What was tested or what the document is, is missing.', 'code');
    const externalId = item.externalId ? String(item.externalId).trim().slice(0, 100) : null;
    if (!externalId) throw new IngestError('identifier', 'The sender\'s own number for this result is missing (needed to avoid duplicates).', 'identifier');
    if (!item.file?.buffer?.length) throw new IngestError('no_file', 'The result file (PDF, JPEG or PNG) is missing.', 'presentedForm');
    if (item.file.buffer.length > MAX_DOCUMENT_BYTES) throw new IngestError('file_too_large', 'The file is larger than 5 MB.', 'presentedForm');

    // A repeated send: answer with what happened the first time.
    const {rows: [existing]} = await app.pg.query(
        `SELECT r.id, EXISTS (SELECT 1 FROM clinical_documents d WHERE d.lab_result_id = r.id) AS delivered
         FROM lab_results r WHERE r.facility_id = $1 AND r.external_id = $2`, [client.facility_id, externalId]);
    if (existing) return {id: existing.id, created: false, delivered: existing.delivered, code: null};

    let clean;
    try {
        clean = cleanUpload(item.file.buffer);
    } catch (error) {
        if (error instanceof UploadError) throw new IngestError(error.code, error.message, 'presentedForm');
        throw error;
    }
    const birthYear = Number(item.patient?.birthYear) || null;
    const stored = await app.documents.save(clean.buffer), code = newResultCode();
    const filename = String(item.file.filename || `${externalId}`).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 200) || 'result';
    try {
        const {rows: [result]} = await app.pg.query(
            `INSERT INTO lab_results (facility_id, patient_name, patient_phone, title, code_hash, code_expires_at, filename, mime, size_bytes, sha256,
                 storage_key, iv, auth_tag, birth_year, slip_version, external_id, source, category, observations, api_client_id)
             VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6), $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
             ON CONFLICT (facility_id, external_id) WHERE external_id IS NOT NULL DO NOTHING RETURNING *`,
            [client.facility_id, name, phone, title, resultCodeHash(app.config.otpSecret, code), CODE_DAYS, filename, clean.mime, clean.buffer.length,
                stored.sha256, stored.storageKey, stored.iv, stored.authTag, birthYear && birthYear >= 1900 && birthYear <= 2100 ? birthYear : null,
                app.config.healthFile ? 2 : 1, externalId, item.source, item.category || 'lab',
                item.observations?.length ? JSON.stringify(item.observations) : null, client.client_id]);
        if (!result) {
            // Sent twice at the same moment: the other request stored it.
            await app.documents.remove(stored.storageKey);
            return ingest(app, client, item, {ip});
        }
        const delivered = await deliver(app, result, item.patient);
        await audit(app.pg, {actorId: client.facility_id, action: 'result.uploaded', targetId: result.id,
            details: {via: item.source, client: client.client_id, size: clean.buffer.length, delivered}, ip});
        return {id: result.id, created: true, delivered, code: delivered ? null : code};
    } catch (error) {
        if (error instanceof IngestError) throw error;
        await app.pg.query('DELETE FROM lab_results WHERE storage_key = $1', [stored.storageKey]).catch(() => {});
        await app.documents.remove(stored.storageKey);
        throw error;
    }
}

// Into the patient's file when number and birth year match, the health file is on, and the profile agreed to a file.
async function deliver(app, result, patient) {
    if (!app.config.healthFile) return false;
    const number = cleanPatientNumber(patient?.number);
    const birthYear = Number(patient?.birthYear);
    if (!number || !birthYear) return false;
    const {rows: [found]} = await app.pg.query('SELECT patient_id FROM patient_identifiers WHERE system = $1 AND value = $2', [PATIENT_NUMBER_SYSTEM, number]);
    const patientId = found && await resolvePatient(app.pg, found.patient_id);
    if (!patientId) return false;
    const {rows: [p]} = await app.pg.query(
        `SELECT p.id FROM patients p WHERE p.id = $1 AND extract(year FROM p.birth_date) = $2
           AND EXISTS (SELECT 1 FROM consents c WHERE c.patient_id = p.id AND c.scope = 'health_file' AND c.withdrawn_at IS NULL)`, [patientId, birthYear]);
    if (!p) return false;
    const {rowCount} = await app.pg.query(
        `INSERT INTO clinical_documents (patient_id, source, lab_result_id, category, title, document_date)
         VALUES ($1, 'lab_result', $2, $3, $4, ($5 AT TIME ZONE 'Asia/Damascus')::date) ON CONFLICT (lab_result_id) DO NOTHING`,
        [p.id, result.id, result.category, result.title, result.created_at]);
    if (rowCount) await audit(app.pg, {actorId: null, action: 'result.delivered', targetId: result.id, details: {patient_id: p.id}});
    return rowCount > 0;
}
