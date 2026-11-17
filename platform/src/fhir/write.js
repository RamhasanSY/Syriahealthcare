// HL7 FHIR R4 writing for lab and clinic software (stage 2d): a transaction Bundle POSTed to /fhir/r4.
// - Lab results: Patient + DiagnosticReport (presentedForm with the PDF or image) + optional Observations (LOINC, UCUM).
//   Scope system/DiagnosticReport.c.
// - Documents (IHE MHD ITI-65 "Provide Document Bundle"): List (SubmissionSet) + DocumentReference + Binary or inline
//   attachment. Scope system/DocumentReference.c.
// Only with an OAuth access token (src/oauth.js), never with a browser session. At most 8 MB per Bundle.
// The answer is a transaction-response: per entry "201 Created" or "200 OK" (sent before), and an OperationOutcome
// saying only whether the result went straight into the patient's file, or which slip code to print.
import {cleanPatientNumber} from '../patient-number.js';
import {CATEGORY_BY_LOINC, IngestError, prepare, store} from '../ingest.js';
import {tokenClient} from '../oauth.js';
import {MAX_DOCUMENT_BYTES} from '../documents.js';

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', {fatal: true});
const MHD_SUBMISSION = 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes';

// Senders' JSON is not trusted to have the FHIR shape: lists that are not lists count as empty, texts are cut short.
const list = value => Array.isArray(value) ? value : [];
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : typeof value === 'number' ? String(value) : null;
const textOf = concept => text(concept?.text) || text(list(concept?.coding).find(c => c?.display)?.display) || text(list(concept?.coding)[0]?.code) || '';
const loincOf = concept => list(concept?.coding).find(c => c?.system === 'http://loinc.org')?.code;
const humanName = names => {
    const n = list(names)[0];
    return n ? (text(n.text) || [...list(n.given), n.family].filter(v => typeof v === 'string').join(' ')) : '';
};

// The patient of the Bundle: name, mobile, SyriaHC number (any identifier that is a valid number) and birth year.
function patientOf(resource) {
    if (!resource) return {};
    const number = list(resource.identifier).map(i => cleanPatientNumber(i?.value)).find(Boolean) || null;
    const phone = text(list(resource.telecom).find(t => t?.system === 'phone' || t?.system === 'sms')?.value, 40);
    return {name: humanName(resource.name), phone, number, birthYear: resource.birthDate ? Number(String(resource.birthDate).slice(0, 4)) : null};
}

// Observations as {code: {system, code, display}, value, unit, ucum, interpretation, text}.
function observationOf(o) {
    const coding = list(o.code?.coding)[0] || {};
    const quantity = typeof o.valueQuantity?.value === 'number' ? o.valueQuantity.value : null;
    return {
        code: {system: text(coding.system, 200), code: text(coding.code, 100), display: text(coding.display) || text(o.code?.text)},
        value: quantity ?? text(o.valueQuantity?.value, 100) ?? text(o.valueString) ?? text(o.valueCodeableConcept?.text)
            ?? text(list(o.valueCodeableConcept?.coding)[0]?.display),
        unit: text(o.valueQuantity?.unit, 50), ucum: o.valueQuantity?.system === 'http://unitsofmeasure.org' ? text(o.valueQuantity.code, 50) : null,
        interpretation: text(list(list(o.interpretation)[0]?.coding)[0]?.code, 20),
        reference_range: text(list(o.referenceRange)[0]?.text, 200)
    };
}

// Limits per Bundle: a lab sends one result or one document at a time, rarely a handful; a report has at most
// 200 values (a large panel has about 60).
export const BUNDLE_LIMITS = {entries: 100, items: 20, observations: 200};
// Base64 of the largest allowed file, with room for line breaks: anything longer is refused before it is decoded.
const MAX_BASE64_LENGTH = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 100_000;

const attachmentFile = (attachment, binary, decoded) => {
    const data = attachment?.data || binary?.data;
    if (!data) return null;
    if (typeof data !== 'string') throw new IngestError('invalid_attachment', 'The attachment data must be base64 text.', 'presentedForm');
    if (data.length > MAX_BASE64_LENGTH) throw new IngestError('file_too_large', 'The file is larger than 5 MB.', 'presentedForm');
    // A Binary used by several entries is decoded once (and a second use is refused in itemsOf).
    const key = binary || attachment;
    if (!decoded.has(key)) decoded.set(key, Buffer.from(data, 'base64'));
    return {buffer: decoded.get(key), filename: text(attachment?.title, 200) || 'document'};
};

// Reads one transaction Bundle into items for src/ingest.js. Throws IngestError for anything missing.
export function itemsOf(bundle) {
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'transaction') throw new IngestError('not_transaction', 'Send a Bundle of type transaction.', 'Bundle.type');
    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    if (entries.length > BUNDLE_LIMITS.entries) throw new IngestError('too_many_entries', `At most ${BUNDLE_LIMITS.entries} entries per Bundle.`, 'Bundle.entry');
    const byUrl = new Map();
    for (const e of entries) {
        if (typeof e?.fullUrl === 'string') byUrl.set(e.fullUrl, e.resource);
        if (e?.resource?.resourceType && e.resource.id) byUrl.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    }
    const resolve = ref => typeof ref?.reference === 'string' ? byUrl.get(ref.reference) ?? null : null;
    const decoded = new Map(), usedBinaries = new Set();
    const items = [];
    for (const [index, entry] of entries.entries()) {
        const r = entry?.resource;
        if (r?.resourceType === 'DiagnosticReport') {
            const patient = patientOf(resolve(r.subject));
            const radiology = list(r.category).some(c => list(c?.coding).some(x => x?.code === 'RAD'));
            // Each Observation once, however often it is referenced.
            const observations = [...new Set(list(r.result).map(resolve).filter(o => o?.resourceType === 'Observation'))];
            if (observations.length > BUNDLE_LIMITS.observations) {
                throw new IngestError('too_many_observations', `At most ${BUNDLE_LIMITS.observations} values per report.`, `Bundle.entry[${index}].resource.result`);
            }
            items.push({index, kind: 'DiagnosticReport', scope: 'system/DiagnosticReport.c', patient, title: textOf(r.code),
                category: radiology ? 'imaging' : 'lab', externalId: text(list(r.identifier)[0]?.value, 100),
                file: attachmentFile(list(r.presentedForm)[0], null, decoded), observations: observations.map(observationOf)});
        } else if (r?.resourceType === 'DocumentReference') {
            const patient = patientOf(resolve(r.subject));
            const attachment = list(r.content)[0]?.attachment;
            const binary = attachment?.url ? resolve({reference: attachment.url}) : null;
            if (binary) {
                if (usedBinaries.has(binary)) throw new IngestError('binary_reused', 'Each Binary may belong to one DocumentReference only.', `Bundle.entry[${index}].resource.content`);
                usedBinaries.add(binary);
            }
            items.push({index, kind: 'DocumentReference', scope: 'system/DocumentReference.c', patient,
                title: text(r.description) || textOf(r.type) || text(attachment?.title), category: CATEGORY_BY_LOINC[loincOf(r.type)] || 'other',
                externalId: text(r.masterIdentifier?.value, 100) || text(list(r.identifier)[0]?.value, 100), file: attachmentFile(attachment, binary, decoded), observations: []});
        }
    }
    if (!items.length) throw new IngestError('nothing_to_store', 'The Bundle has no DiagnosticReport or DocumentReference.', 'Bundle.entry');
    if (items.length > BUNDLE_LIMITS.items) throw new IngestError('too_many_items', `At most ${BUNDLE_LIMITS.items} results or documents per Bundle.`, 'Bundle.entry');
    const submission = entries.find(e => e?.resource?.resourceType === 'List' && list(e.resource.code?.coding).some(c => c?.system === MHD_SUBMISSION && c?.code === 'submissionset'));
    return {items, mhd: Boolean(submission)};
}

export default function fhirWriteRoutes(app, {send, outcome}) {
    // Inside /fhir/r4 only: JSON bodies up to 8 MB (the rest of the platform keeps its small limit).
    // FHIR JSON is always UTF-8. Anything else is refused, so a name is never stored garbled (a BOM is allowed).
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser(['application/fhir+json', 'application/json'], {parseAs: 'buffer', bodyLimit: MAX_BUNDLE_BYTES}, (request, body, done) => {
        let text;
        try {
            text = UTF8.decode(body);
        } catch (_) {
            return done(Object.assign(new Error('The body is not valid UTF-8. FHIR JSON must be sent as UTF-8.'), {statusCode: 400}));
        }
        try {
            done(null, JSON.parse(text));
        } catch (_) {
            done(Object.assign(new Error('The body is not valid JSON.'), {statusCode: 400}));
        }
    });

    // Tokens only, and checked before the body is read: without a valid token nothing is parsed.
    // A browser session (cookie) can never write here.
    const tokenFirst = async (request, reply) => {
        try {
            request.apiClient = await tokenClient(app.pg, request);
        } catch (error) {
            reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
            return send(reply, error.statusCode || 401, outcome('login', error.message, 'رمز الوصول غير صالح.'));
        }
    };
    app.post('/', {bodyLimit: MAX_BUNDLE_BYTES, onRequest: tokenFirst, config: {rateLimit: {max: 600, timeWindow: '15 minutes'}}}, async (request, reply) => {
        const client = request.apiClient;
        const scope = list(request.body?.entry).some(e => e?.resource?.resourceType === 'DocumentReference') ? 'system/DocumentReference.c' : 'system/DiagnosticReport.c';
        if (!client.scopes.includes(scope)) {
            reply.header('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${scope}"`);
            return send(reply, 403, outcome('forbidden', `This needs the scope ${scope}.`, 'الصلاحية غير كافية.'));
        }
        let parsed;
        try {
            parsed = itemsOf(request.body);
            for (const item of parsed.items) {
                if (!client.scopes.includes(item.scope)) {
                    return send(reply, 403, outcome('forbidden', `This needs the scope ${item.scope}.`, 'الصلاحية غير كافية.'));
                }
            }
        } catch (error) {
            if (error instanceof IngestError) return send(reply, 400, invalid(error));
            // A Bundle whose parts are not the FHIR types (a number where a list belongs, null entries) is the sender's error.
            if (error instanceof TypeError) return send(reply, 400, invalid(new IngestError('invalid_bundle', 'The Bundle does not follow FHIR R4.', 'Bundle')));
            throw error;
        }
        // Every entry is checked before the first one is stored: a transaction is all or nothing.
        const ready = [];
        for (const item of parsed.items) {
            try {
                ready.push({item, prepared: prepare({...item, source: 'fhir'})});
            } catch (error) {
                if (error instanceof IngestError) return send(reply, 400, invalid(error, `Bundle.entry[${item.index}].resource.${error.field || ''}`));
                throw error;
            }
        }
        const responses = new Map();
        for (const {item, prepared} of ready) {
            const result = await store(app, client, prepared, {ip: request.ip});
            responses.set(item.index, {status: result.created ? '201 Created' : '200 OK', location: `${item.kind}/${result.id}`, outcome: deliveryOutcome(result)});
        }
        return send(reply, 200, {
            resourceType: 'Bundle', type: 'transaction-response',
            entry: list(request.body.entry).map((entry, i) => ({response: responses.get(i) || {status: '200 OK'}}))
        });
    });

    const invalid = (error, expression) => ({resourceType: 'OperationOutcome', issue: [{severity: 'error', code: 'invalid', details: {text: error.code},
        diagnostics: error.message, ...(expression || error.field ? {expression: [expression || error.field]} : {})}]});

    // Only "delivered" or "not delivered, print this slip code". Never anything from the patient's file.
    const deliveryOutcome = result => ({resourceType: 'OperationOutcome', issue: [{severity: 'information', code: 'informational',
        details: {text: result.delivered ? 'delivered' : 'not-delivered'},
        diagnostics: result.delivered ? 'Delivered to the patient\'s SyriaHC health file.'
            : result.code ? `Not delivered to a health file. Print this code for the patient: ${result.code} (${app.config.appOrigin}/scan#${result.code})`
                : 'Received before. Not delivered to a health file; make a new slip code in the SyriaHC app if needed.'}]});
}
