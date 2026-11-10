// HL7 FHIR R4 writing for lab and clinic software (stage 2d): a transaction Bundle POSTed to /fhir/r4.
// - Lab results: Patient + DiagnosticReport (presentedForm with the PDF or image) + optional Observations (LOINC, UCUM).
//   Scope system/DiagnosticReport.c.
// - Documents (IHE MHD ITI-65 "Provide Document Bundle"): List (SubmissionSet) + DocumentReference + Binary or inline
//   attachment. Scope system/DocumentReference.c.
// Only with an OAuth access token (src/oauth.js), never with a browser session. At most 8 MB per Bundle.
// The answer is a transaction-response: per entry "201 Created" or "200 OK" (sent before), and an OperationOutcome
// saying only whether the result went straight into the patient's file, or which slip code to print.
import {cleanPatientNumber} from '../patient-number.js';
import {CATEGORY_BY_LOINC, ingest, IngestError} from '../ingest.js';
import {tokenClient} from '../oauth.js';

export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MHD_SUBMISSION = 'https://profiles.ihe.net/ITI/MHD/CodeSystem/MHDlistTypes';

const textOf = concept => concept?.text || concept?.coding?.find(c => c.display)?.display || concept?.coding?.[0]?.code || '';
const loincOf = concept => concept?.coding?.find(c => c.system === 'http://loinc.org')?.code;
const humanName = names => {
    const n = (names || [])[0];
    return n ? (n.text || [...(n.given || []), n.family].filter(Boolean).join(' ')) : '';
};

// The patient of the Bundle: name, mobile, SyriaHC number (any identifier that is a valid number) and birth year.
function patientOf(resource) {
    if (!resource) return {};
    const number = (resource.identifier || []).map(i => cleanPatientNumber(i.value)).find(Boolean) || null;
    const phone = (resource.telecom || []).find(t => t.system === 'phone' || t.system === 'sms')?.value;
    return {name: humanName(resource.name), phone, number, birthYear: resource.birthDate ? Number(String(resource.birthDate).slice(0, 4)) : null};
}

// Observations as {code: {system, code, display}, value, unit, ucum, interpretation, text}.
function observationOf(o) {
    const coding = o.code?.coding?.[0] || {};
    return {
        code: {system: coding.system || null, code: coding.code || null, display: coding.display || o.code?.text || null},
        value: o.valueQuantity?.value ?? o.valueString ?? o.valueCodeableConcept?.text ?? o.valueCodeableConcept?.coding?.[0]?.display ?? null,
        unit: o.valueQuantity?.unit ?? null, ucum: o.valueQuantity?.system === 'http://unitsofmeasure.org' ? o.valueQuantity.code ?? null : null,
        interpretation: o.interpretation?.[0]?.coding?.[0]?.code ?? null,
        reference_range: o.referenceRange?.[0]?.text ?? null
    };
}

// Limits per Bundle: a lab sends one result or one document at a time, rarely a handful.
export const BUNDLE_LIMITS = {entries: 100, items: 20};

const attachmentFile = (attachment, binary, decoded) => {
    const data = attachment?.data || binary?.data;
    if (!data) return null;
    // A Binary used by several entries is decoded once (and a second use is refused in itemsOf).
    const key = binary || attachment;
    if (!decoded.has(key)) decoded.set(key, Buffer.from(data, 'base64'));
    return {buffer: decoded.get(key), filename: attachment?.title || 'document'};
};

// Reads one transaction Bundle into items for src/ingest.js. Throws IngestError for anything missing.
export function itemsOf(bundle) {
    if (bundle?.resourceType !== 'Bundle' || bundle.type !== 'transaction') throw new IngestError('not_transaction', 'Send a Bundle of type transaction.', 'Bundle.type');
    const entries = Array.isArray(bundle.entry) ? bundle.entry : [];
    if (entries.length > BUNDLE_LIMITS.entries) throw new IngestError('too_many_entries', `At most ${BUNDLE_LIMITS.entries} entries per Bundle.`, 'Bundle.entry');
    const byUrl = new Map();
    for (const e of entries) {
        if (e?.fullUrl) byUrl.set(e.fullUrl, e.resource);
        if (e?.resource?.resourceType && e.resource.id) byUrl.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
    }
    const resolve = ref => typeof ref?.reference === 'string' ? byUrl.get(ref.reference) ?? null : null;
    const decoded = new Map(), usedBinaries = new Set();
    const items = [];
    for (const [index, entry] of entries.entries()) {
        const r = entry.resource;
        if (r?.resourceType === 'DiagnosticReport') {
            const patient = patientOf(resolve(r.subject));
            const radiology = (r.category || []).some(c => c.coding?.some(x => x.code === 'RAD'));
            items.push({index, kind: 'DiagnosticReport', scope: 'system/DiagnosticReport.c', patient, title: textOf(r.code),
                category: radiology ? 'imaging' : 'lab', externalId: r.identifier?.[0]?.value,
                file: attachmentFile(r.presentedForm?.[0], null, decoded), observations: (r.result || []).map(resolve).filter(o => o?.resourceType === 'Observation').map(observationOf)});
        } else if (r?.resourceType === 'DocumentReference') {
            const patient = patientOf(resolve(r.subject));
            const attachment = r.content?.[0]?.attachment;
            const binary = attachment?.url ? resolve({reference: attachment.url}) : null;
            if (binary) {
                if (usedBinaries.has(binary)) throw new IngestError('binary_reused', 'Each Binary may belong to one DocumentReference only.', `Bundle.entry[${index}].resource.content`);
                usedBinaries.add(binary);
            }
            items.push({index, kind: 'DocumentReference', scope: 'system/DocumentReference.c', patient,
                title: r.description || textOf(r.type) || attachment?.title, category: CATEGORY_BY_LOINC[loincOf(r.type)] || 'other',
                externalId: r.masterIdentifier?.value || r.identifier?.[0]?.value, file: attachmentFile(attachment, binary, decoded), observations: []});
        }
    }
    if (!items.length) throw new IngestError('nothing_to_store', 'The Bundle has no DiagnosticReport or DocumentReference.', 'Bundle.entry');
    if (items.length > BUNDLE_LIMITS.items) throw new IngestError('too_many_items', `At most ${BUNDLE_LIMITS.items} results or documents per Bundle.`, 'Bundle.entry');
    const submission = entries.find(e => e.resource?.resourceType === 'List' && e.resource.code?.coding?.some(c => c.system === MHD_SUBMISSION && c.code === 'submissionset'));
    return {items, mhd: Boolean(submission)};
}

export default function fhirWriteRoutes(app, {send, outcome}) {
    // Inside /fhir/r4 only: JSON bodies up to 8 MB (the rest of the platform keeps its small limit).
    app.removeContentTypeParser('application/json');
    app.addContentTypeParser(['application/fhir+json', 'application/json'], {parseAs: 'string', bodyLimit: MAX_BUNDLE_BYTES}, (request, body, done) => {
        try {
            done(null, JSON.parse(body));
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
        const scope = (request.body?.entry || []).some(e => e?.resource?.resourceType === 'DocumentReference') ? 'system/DocumentReference.c' : 'system/DiagnosticReport.c';
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
            throw error;
        }
        const responses = new Map();
        for (const item of parsed.items) {
            try {
                const result = await ingest(app, client, {...item, source: 'fhir'}, {ip: request.ip});
                responses.set(item.index, {status: result.created ? '201 Created' : '200 OK', location: `${item.kind}/${result.id}`, outcome: deliveryOutcome(result)});
            } catch (error) {
                if (error instanceof IngestError) return send(reply, 400, invalid(error, `Bundle.entry[${item.index}].resource.${error.field || ''}`));
                throw error;
            }
        }
        return send(reply, 200, {
            resourceType: 'Bundle', type: 'transaction-response',
            entry: (request.body.entry || []).map((entry, i) => ({response: responses.get(i) || {status: '200 OK'}}))
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
