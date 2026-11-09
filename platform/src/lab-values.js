// Measured values of a lab result (stage 2d data, shown from now on): what lab software sent as HL7 v2 OBX segments or
// FHIR Observations is stored with the result (lab_results.observations) and shown to the patient and their doctors as
// a table: test, value, unit, reference range and a flag (high, low, critical, abnormal, normal).
const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const INTERPRETATION = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';

// HL7 interpretation codes (v2 table 0078 and FHIR v3-ObservationInterpretation use the same letters for these).
export const FLAGS = {
    HH: ['Critically high', 'مرتفع جداً (حرج)'], H: ['High', 'مرتفع'], LL: ['Critically low', 'منخفض جداً (حرج)'], L: ['Low', 'منخفض'],
    A: ['Abnormal', 'غير طبيعي'], AA: ['Critically abnormal', 'غير طبيعي (حرج)'], N: ['Normal', 'طبيعي']
};

const number = value => {
    const text = String(value ?? '').trim().replace(',', '.');
    return /^[-+]?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
};

// A flag from the value and a reference range written like "12-16", "12 - 16", "<200", "<= 5", ">40". Null when unclear.
export function flagOf(value, range) {
    const v = number(value), r = String(range ?? '').trim().replace(/,/g, '.');
    if (v === null || !r) return null;
    let m = /^([-+]?\d+(?:\.\d+)?)\s*(?:-|–|to)\s*([-+]?\d+(?:\.\d+)?)$/.exec(r);
    if (m) return v < Number(m[1]) ? 'L' : v > Number(m[2]) ? 'H' : 'N';
    m = /^(<=?|≤)\s*([-+]?\d+(?:\.\d+)?)$/.exec(r);
    if (m) return (m[1] === '<' ? v < Number(m[2]) : v <= Number(m[2])) ? 'N' : 'H';
    m = /^(>=?|≥)\s*([-+]?\d+(?:\.\d+)?)$/.exec(r);
    if (m) return (m[1] === '>' ? v > Number(m[2]) : v >= Number(m[2])) ? 'N' : 'L';
    return null;
}

// Rows for the screen. The sender's own flag wins; otherwise it is worked out from the range (marked as "calculated").
export function valueRows(observations) {
    return (Array.isArray(observations) ? observations : []).map(o => {
        const sent = String(o.interpretation || '').toUpperCase();
        const flag = FLAGS[sent] ? sent : flagOf(o.value, o.reference_range);
        return {
            name: o.code?.display || o.code?.code || '',
            loinc: o.code?.system === LOINC ? o.code.code : null,
            value: o.value === null || o.value === undefined ? '' : String(o.value),
            unit: o.unit || o.ucum || '',
            range: o.reference_range || '',
            flag: flag || null,
            flag_calculated: Boolean(flag) && !FLAGS[sent]
        };
    }).filter(row => row.name || row.value);
}

// As FHIR R4 Observations, contained in the DiagnosticReport (ids obs1, obs2, ...).
export function observationResources(observations, {subject, effective}) {
    return valueRows(observations).map((row, i) => {
        const numeric = number(row.value);
        const original = observations[i] || {};
        return {
            resourceType: 'Observation', id: `obs${i + 1}`, status: 'final',
            code: {
                ...(row.loinc ? {coding: [{system: LOINC, code: row.loinc, ...(row.name && {display: row.name})}]} : {}),
                text: row.name || row.loinc || 'Value'
            },
            subject, effectiveDateTime: effective,
            ...(numeric !== null
                ? {valueQuantity: {value: numeric, ...(row.unit && {unit: row.unit}), ...(original.ucum && {system: UCUM, code: original.ucum})}}
                : {valueString: row.value || '—'}),
            ...(row.flag && {interpretation: [{coding: [{system: INTERPRETATION, code: row.flag, display: FLAGS[row.flag][0]}]}]}),
            ...(row.range && {referenceRange: [{text: row.range}]})
        };
    });
}
