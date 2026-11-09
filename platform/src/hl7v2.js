// HL7 v2.5.1 over HTTPS for older lab and clinic software (stage 2d): POST /hl7v2 with one message in ER7 form.
// - ORU^R01: a lab result. PID (patient), OBR (test, the lab's number), OBX (values, and the PDF as ED).
// - MDM^T02: a document such as a discharge letter. PID, TXA (type, document number), OBX (the file as ED).
// The answer is always an ACK: AA (accepted), AE (error in the message, with an ERR segment) or AR (refused, e.g. no
// valid token or wrong scope). The same checks and the same storage as FHIR (src/ingest.js) apply.
import {cleanPatientNumber} from './patient-number.js';
import {CATEGORY_BY_LOINC, ingest, IngestError} from './ingest.js';
import {tokenClient} from './oauth.js';

export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const ER7 = 'x-application/hl7-v2+er7';

// ---- Parsing ----

export const MAX_SEGMENTS = 2000;

export function parseMessage(text) {
    const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/).filter(l => l.trim());
    if (lines.length > MAX_SEGMENTS) throw new IngestError('too_many_segments', `At most ${MAX_SEGMENTS} segments per message.`, 'MSH');
    if (!lines[0]?.startsWith('MSH')) throw new IngestError('no_msh', 'The message must start with an MSH segment.', 'MSH');
    const field = lines[0][3], [component, repetition, escape, sub] = lines[0].slice(4, 8).split('');
    const enc = {field, component: component || '^', repetition: repetition || '~', escape: escape || '\\', sub: sub || '&'};
    // The escape pattern is built once per message (not once per field read).
    enc.pattern = new RegExp(`\\${enc.escape}([FSTRE])\\${enc.escape}`, 'g');
    const segments = lines.map(line => {
        const parts = line.split(enc.field);
        // MSH-1 is the field separator itself, so MSH fields are shifted by one.
        return line.startsWith('MSH') ? {id: 'MSH', fields: ['MSH', enc.field, ...parts.slice(1)]} : {id: parts[0], fields: parts};
    });
    return {enc, segments};
}

const unescape = (value, enc) => String(value ?? '').replace(enc.pattern || new RegExp(`\\${enc.escape}([FSTRE])\\${enc.escape}`, 'g'), (_, c) =>
    ({F: enc.field, S: enc.component, T: enc.sub, R: enc.repetition, E: enc.escape})[c]);

// Field n of a segment (1-based, as in the HL7 tables), split into components; repetition r.
function get(message, segment, n, {component = 0, repetition = 0} = {}) {
    const raw = segment?.fields[n] ?? '';
    const rep = raw.split(message.enc.repetition)[repetition] ?? '';
    const parts = rep.split(message.enc.component);
    return component ? unescape(parts[component - 1] ?? '', message.enc) : unescape(rep, message.enc);
}
const first = (message, id) => message.segments.find(s => s.id === id);
const all = (message, id) => message.segments.filter(s => s.id === id);

function patientOf(message) {
    const pid = first(message, 'PID');
    if (!pid) throw new IngestError('no_pid', 'The PID segment is missing.', 'PID');
    const ids = (pid.fields[3] || '').split(message.enc.repetition).map(rep => unescape(rep.split(message.enc.component)[0], message.enc));
    const dob = get(message, pid, 7, {component: 1});
    return {
        name: [get(message, pid, 5, {component: 2}), get(message, pid, 5, {component: 1})].filter(Boolean).join(' '),
        phone: get(message, pid, 13, {component: 1}) || get(message, pid, 13, {component: 12}),
        number: ids.map(cleanPatientNumber).find(Boolean) || null,
        birthYear: /^\d{4}/.test(dob) ? Number(dob.slice(0, 4)) : null
    };
}

// OBX-2 "ED": OBX-5 = source ^ type ^ subtype ^ encoding ^ data, e.g. ^application^pdf^Base64^JVBERi0...
function encapsulated(message, obx) {
    if (get(message, obx, 2) !== 'ED') return null;
    const encoding = get(message, obx, 5, {component: 4}).toLowerCase();
    if (encoding !== 'base64') throw new IngestError('encoding', 'Embedded files must be Base64 encoded (OBX-5.4).', 'OBX-5');
    const data = (obx.fields[5] || '').split(message.enc.component)[4] || '';
    return {buffer: Buffer.from(data, 'base64'), filename: `${get(message, obx, 5, {component: 2})}.${get(message, obx, 5, {component: 3})}`.replace(/^\.|\.$/g, '') || 'document'};
}

function observation(message, obx) {
    const system = get(message, obx, 3, {component: 3});
    return {
        code: {system: system === 'LN' ? 'http://loinc.org' : system || null, code: get(message, obx, 3, {component: 1}) || null, display: get(message, obx, 3, {component: 2}) || null},
        value: get(message, obx, 5) || null, unit: get(message, obx, 6, {component: 2}) || get(message, obx, 6, {component: 1}) || null,
        ucum: get(message, obx, 6, {component: 3}) === 'UCUM' ? get(message, obx, 6, {component: 1}) : null,
        interpretation: get(message, obx, 8) || null, reference_range: get(message, obx, 7) || null
    };
}

// One message into an item for src/ingest.js, with the scope it needs.
export function itemOf(message) {
    const msh = first(message, 'MSH');
    const type = `${get(message, msh, 9, {component: 1})}^${get(message, msh, 9, {component: 2})}`;
    const obx = all(message, 'OBX');
    const file = obx.map(o => encapsulated(message, o)).find(Boolean) || null;
    if (type === 'ORU^R01') {
        const obr = first(message, 'OBR');
        if (!obr) throw new IngestError('no_obr', 'The OBR segment is missing.', 'OBR');
        return {scope: 'system/DiagnosticReport.c', patient: patientOf(message), title: get(message, obr, 4, {component: 2}) || get(message, obr, 4, {component: 1}),
            category: get(message, obr, 24) === 'RAD' ? 'imaging' : 'lab', externalId: get(message, obr, 3, {component: 1}) || get(message, obr, 2, {component: 1}),
            file, observations: obx.filter(o => get(message, o, 2) !== 'ED').map(o => observation(message, o))};
    }
    if (type === 'MDM^T02') {
        const txa = first(message, 'TXA');
        if (!txa) throw new IngestError('no_txa', 'The TXA segment is missing.', 'TXA');
        const docType = get(message, txa, 2, {component: 1});
        return {scope: 'system/DocumentReference.c', patient: patientOf(message), title: get(message, txa, 2, {component: 2}) || docType || 'Document',
            category: CATEGORY_BY_LOINC[docType] || (docType === 'DS' ? 'discharge' : 'other'), externalId: get(message, txa, 12, {component: 1}),
            file, observations: []};
    }
    throw Object.assign(new IngestError('unsupported_message', `Message type ${type} is not supported. Send ORU^R01 or MDM^T02.`, 'MSH-9'), {refuse: true});
}

// ---- Acknowledgement ----

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const esc = (text, enc) => String(text).replace(/[|^~\\&\r\n]/g, c => ({'|': '\\F\\', '^': '\\S\\', '~': '\\R\\', '\\': '\\E\\', '&': '\\T\\', '\r': ' ', '\n': ' '})[c]);

export function ack(message, code, text, {error} = {}) {
    const msh = message ? first(message, 'MSH') : null;
    const enc = message?.enc || {field: '|'};
    const g = (n, c) => msh ? get(message, msh, n, c ? {component: c} : {}) : '';
    const control = g(10);
    const lines = [
        ['MSH', '^~\\&', 'SyriaHC', 'SyriaHC', g(3), g(4), stamp(), '', `ACK^${g(9, 2) || ''}^ACK`, `ACK${Date.now()}`, 'P', '2.5.1'].join('|'),
        ['MSA', code, control, esc(text, enc)].join('|')
    ];
    // ERR-2 location, ERR-3 HL7 error code (table 0357), ERR-4 severity, ERR-8 user message.
    if (error) lines.push(['ERR', '', esc(error.field || '', enc), error.hl7 || '207^Application internal error^HL70357', 'E', '', '', '', esc(error.message, enc)].join('|'));
    return lines.join('\r') + '\r';
}

const HL7_ERROR = {no_msh: '100^Segment sequence error^HL70357', no_pid: '100^Segment sequence error^HL70357', no_obr: '100^Segment sequence error^HL70357',
    no_txa: '100^Segment sequence error^HL70357', unsupported_message: '200^Unsupported message type^HL70357'};

export default async function hl7v2Routes(app) {
    for (const type of [ER7, 'application/hl7-v2', 'text/plain']) {
        app.addContentTypeParser(type, {parseAs: 'string', bodyLimit: MAX_MESSAGE_BYTES}, (request, body, done) => done(null, body));
    }

    // The access token is checked before the message is even read: without a valid one, nothing is parsed.
    const tokenFirst = async (request, reply) => {
        try {
            request.apiClient = await tokenClient(app.pg, request);
        } catch (error) {
            reply.code(error.statusCode || 401).type(ER7).header('Cache-Control', 'no-store');
            return reply.send(ack(null, 'AR', error.message, {error: {field: 'Authorization', message: error.message, hl7: '207^Application internal error^HL70357'}}));
        }
    };
    app.post('/hl7v2', {bodyLimit: MAX_MESSAGE_BYTES, onRequest: tokenFirst, config: {rateLimit: {max: 600, timeWindow: '15 minutes'}}}, async (request, reply) => {
        reply.type(ER7).header('Cache-Control', 'no-store');
        let message = null;
        try {
            message = parseMessage(request.body);
        } catch (error) {
            if (!(error instanceof IngestError)) throw error;
            return ack(null, 'AE', error.message, {error: {...error, message: error.message, hl7: HL7_ERROR[error.code]}});
        }
        let item;
        try {
            item = itemOf(message);
        } catch (error) {
            if (!(error instanceof IngestError)) throw error;
            return ack(message, error.refuse ? 'AR' : 'AE', error.message, {error: {field: error.field, message: error.message, hl7: HL7_ERROR[error.code]}});
        }
        const client = request.apiClient;
        if (!client.scopes.includes(item.scope)) {
            reply.code(403);
            const text = `This needs the scope ${item.scope}.`;
            return ack(message, 'AR', text, {error: {field: 'Authorization', message: text, hl7: '207^Application internal error^HL70357'}});
        }
        try {
            const result = await ingest(app, client, {...item, source: 'hl7v2'}, {ip: request.ip});
            const status = result.delivered ? 'Delivered to the patient\'s SyriaHC health file.'
                : result.code ? `Not delivered to a health file. Print this code for the patient: ${result.code}` : 'Not delivered to a health file.';
            return ack(message, 'AA', result.created ? status : `Received before. ${status}`);
        } catch (error) {
            if (!(error instanceof IngestError)) throw error;
            return ack(message, 'AE', error.message, {error: {field: error.field, message: error.message, hl7: '101^Required field missing^HL70357'}});
        }
    });
}
