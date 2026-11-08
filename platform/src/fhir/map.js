// Pure functions that turn platform rows into HL7 FHIR R4 resources. Only public fields go in: never a licence number,
// email, contact person, review note or document. The directory resources follow IHE mCSD (Mobile Care Services Discovery).
import {facilityKinds, facilityServices, governorates, specialties} from '../catalog.js';
import {coding, GOVERNORATE_ISO, serviceCode} from './terminology.js';

const V3_ROLE = 'http://terminology.hl7.org/CodeSystem/v3-RoleCode';
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const instant = value => new Date(value).toISOString();
const latest = (...values) => instant(Math.max(...values.filter(Boolean).map(v => new Date(v).getTime())));
const phone = value => value ? [{system: 'phone', value, use: 'work'}] : undefined;

// Removes empty fields, so resources never carry null or [] (FHIR forbids empty elements).
export function prune(value) {
    if (Array.isArray(value)) {
        const items = value.map(prune).filter(v => v !== undefined);
        return items.length ? items : undefined;
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const kept = prune(v);
            if (kept !== undefined) out[k] = kept;
        }
        return Object.keys(out).length ? out : undefined;
    }
    return value === null || value === '' ? undefined : value;
}

function address({text, area, governorate}) {
    const state = governorates[governorate];
    return {
        use: 'work', type: 'physical', text: [text, area, state?.[0]].filter(Boolean).join(', ') || undefined,
        district: area, state: state?.[0], country: 'SY',
        // The Arabic name and the ISO 3166-2 code travel along, so other systems can match the governorate either way.
        _state: state ? {extension: [
            {url: 'http://hl7.org/fhir/StructureDefinition/translation', extension: [{url: 'lang', valueCode: 'ar'}, {url: 'content', valueString: state[1]}]},
            {url: 'http://hl7.org/fhir/StructureDefinition/iso21090-SC-coding', valueCoding: {system: 'urn:iso:std:iso:3166:-2', code: GOVERNORATE_ISO[governorate]}}
        ]} : undefined
    };
}

// ---- Doctors: Practitioner (the person), PractitionerRole (specialty, hours), Location (the practice) ----

export const practitioner = d => prune({
    resourceType: 'Practitioner', id: d.id, meta: {lastUpdated: instant(d.updated_at)}, active: true, name: [{text: d.name}]
});

// Opening hours per weekday, merged into one entry per time range, e.g. Sun–Thu 09:00–13:00.
export function availableTime(hours = []) {
    const ranges = new Map();
    for (const h of hours) {
        const key = `${h.starts_at}-${h.ends_at}`;
        if (!ranges.has(key)) ranges.set(key, {days: new Set(), start: h.starts_at, end: h.ends_at});
        ranges.get(key).days.add(h.weekday);
    }
    return [...ranges.values()]
        .sort((a, b) => a.start.localeCompare(b.start))
        .map(r => ({daysOfWeek: [...r.days].sort().map(d => WEEKDAYS[d]), availableStartTime: r.start + ':00', availableEndTime: r.end + ':00'}));
}

const specialtyConcept = key => specialties[key] ? [{coding: [coding('specialty', key, specialties[key])], text: specialties[key][0]}] : undefined;

export const practitionerRole = d => prune({
    resourceType: 'PractitionerRole', id: d.id, meta: {lastUpdated: latest(d.updated_at, d.schedule_updated_at)}, active: true,
    practitioner: {reference: `Practitioner/${d.id}`, display: d.name},
    location: [{reference: `Location/${d.id}`, display: d.clinic_name || d.name}],
    specialty: specialtyConcept(d.specialty),
    telecom: phone(d.clinic_phone),
    availableTime: availableTime(d.hours)
});

export const practiceLocation = d => prune({
    resourceType: 'Location', id: d.id, meta: {lastUpdated: instant(d.updated_at)}, status: 'active', mode: 'instance',
    name: d.clinic_name || d.name, description: d.bio,
    type: [{coding: [{system: V3_ROLE, code: 'OF', display: 'Outpatient facility'}]}],
    telecom: phone(d.clinic_phone),
    address: address({text: d.clinic_address, area: d.area, governorate: d.governorate})
});

export const schedule = d => prune({
    resourceType: 'Schedule', id: d.id, meta: {lastUpdated: latest(d.updated_at, d.schedule_updated_at)}, active: true,
    specialty: specialtyConcept(d.specialty),
    actor: [{reference: `Practitioner/${d.id}`, display: d.name}, {reference: `PractitionerRole/${d.id}`}, {reference: `Location/${d.id}`}],
    comment: `${d.slot_minutes || 20}-minute appointments, bookable online at app.syriahc.com.`
});

// A free time, computed from the opening hours (never stored). The id carries the doctor and the start minute.
export const slotId = (doctorId, startsAt) => `${doctorId}.${Math.round(new Date(startsAt).getTime() / 60000)}`;
export function parseSlotId(id) {
    const match = /^([0-9a-f-]{36})\.(\d{1,10})$/.exec(id);
    return match ? {doctorId: match[1], startsAt: new Date(Number(match[2]) * 60000).toISOString()} : null;
}
export const slot = (doctorId, s) => ({
    resourceType: 'Slot', id: slotId(doctorId, s.starts_at), schedule: {reference: `Schedule/${doctorId}`},
    status: 'free', start: s.starts_at, end: s.ends_at
});

// ---- Facilities: Organization, Location, HealthcareService ----

const kindConcept = kind => ({coding: [coding('facility-kind', kind, facilityKinds[kind])], text: facilityKinds[kind][0]});
const facilityName = f => f.facility_name || facilityKinds[f.kind][0];

export const organization = f => prune({
    resourceType: 'Organization', id: f.id, meta: {lastUpdated: instant(f.updated_at)}, active: true,
    type: [{coding: [{system: 'http://terminology.hl7.org/CodeSystem/organization-type', code: 'prov', display: 'Healthcare Provider'}]}, kindConcept(f.kind)],
    name: facilityName(f), telecom: phone(f.phone),
    address: [address({text: f.address, area: f.area, governorate: f.governorate})]
});

const LOCATION_TYPE = {
    hospital: {code: 'HOSP', display: 'Hospital'}, lab: {code: 'MBL', display: 'medical laboratory'},
    imaging: {code: 'RADDX', display: 'Radiology diagnostics or therapeutics unit'}, clinic: {code: 'OF', display: 'Outpatient facility'}
};

export const facilityLocation = f => prune({
    resourceType: 'Location', id: f.id, meta: {lastUpdated: instant(f.updated_at)}, status: 'active', mode: 'instance',
    name: facilityName(f), description: f.description,
    type: [
        {coding: [{system: V3_ROLE, ...LOCATION_TYPE[f.kind]}]},
        f.emergency ? {coding: [{system: V3_ROLE, code: 'ER', display: 'Emergency room'}]} : undefined,
        kindConcept(f.kind)
    ],
    telecom: phone(f.phone),
    address: address({text: f.address, area: f.area, governorate: f.governorate}),
    managingOrganization: {reference: `Organization/${f.id}`, display: facilityName(f)},
    availabilityExceptions: f.opening_hours
});

export const healthcareService = f => prune({
    resourceType: 'HealthcareService', id: f.id, meta: {lastUpdated: instant(f.updated_at)}, active: true,
    providedBy: {reference: `Organization/${f.id}`, display: facilityName(f)},
    category: [kindConcept(f.kind)],
    type: (f.services || []).filter(key => facilityServices[f.kind]?.[key])
        .map(key => ({coding: [coding('facility-service', serviceCode(f.kind, key), facilityServices[f.kind][key])], text: facilityServices[f.kind][key][0]})),
    location: [{reference: `Location/${f.id}`}],
    name: facilityName(f), comment: f.description, telecom: phone(f.phone),
    availabilityExceptions: f.opening_hours
});

// ---- The platform itself ----

export const endpoint = base => ({
    resourceType: 'Endpoint', id: 'fhir-r4', status: 'active', name: 'SyriaHC FHIR R4',
    connectionType: {system: 'http://terminology.hl7.org/CodeSystem/endpoint-connection-type', code: 'hl7-fhir-rest', display: 'HL7 FHIR'},
    payloadType: [{coding: [{system: 'http://terminology.hl7.org/CodeSystem/endpoint-payload-type', code: 'any', display: 'Any'}]}],
    payloadMimeType: ['application/fhir+json'], address: base
});
