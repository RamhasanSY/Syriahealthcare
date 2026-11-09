// Master data codes as HL7 FHIR R4 CodeSystems, ValueSets and NamingSystems, built from src/catalog.js.
// Every code has its English display and an Arabic designation, so other systems can show either language.
import {documentCategories, documentSources, facilityKinds, facilityServices, governorates, specialties} from '../catalog.js';

export const CANONICAL = 'https://syriahc.com/fhir';
export const PUBLISHED = '2026-11-08';
const PUBLISHER = 'SyriaHC';

// Governorates <-> ISO 3166-2:SY subdivision codes.
export const GOVERNORATE_ISO = {
    damascus: 'SY-DI', rif_dimashq: 'SY-RD', aleppo: 'SY-HL', homs: 'SY-HI', hama: 'SY-HM', latakia: 'SY-LA', tartus: 'SY-TA',
    idlib: 'SY-ID', daraa: 'SY-DR', suwayda: 'SY-SU', quneitra: 'SY-QU', deir_ez_zor: 'SY-DY', raqqa: 'SY-RA', hasakah: 'SY-HA'
};

// One facility service code per kind and service, e.g. "lab.blood_count": the same service key exists under several kinds.
export const serviceCode = (kind, key) => `${kind}.${key}`;

const concept = (code, [en, ar], extra = {}) => ({
    code, display: en, designation: [{language: 'ar', value: ar}], ...extra
});

const CODE_SYSTEMS = [
    {id: 'specialty', title: 'Medical specialties', description: 'Specialties of doctors listed on SyriaHC.',
        concepts: () => Object.entries(specialties).map(([code, labels]) => concept(code, labels))},
    {id: 'facility-kind', title: 'Kinds of health facilities', description: 'Laboratories, imaging centres, hospitals and clinics.',
        concepts: () => Object.entries(facilityKinds).map(([code, labels]) => concept(code, labels))},
    {id: 'facility-service', title: 'Services of health facilities', description: 'What a facility offers, grouped by kind of facility.',
        concepts: () => Object.entries(facilityServices).map(([kind, services]) => concept(kind, facilityKinds[kind], {
            concept: Object.entries(services).map(([key, labels]) => concept(serviceCode(kind, key), labels))
        }))},
    {id: 'governorate', title: 'Governorates of Syria', description: 'The 14 governorates, with their ISO 3166-2:SY codes.',
        concepts: () => Object.entries(governorates).map(([code, labels]) => concept(code, labels, {
            property: [{code: 'iso3166-2', valueCode: GOVERNORATE_ISO[code]}]
        })),
        property: [{code: 'iso3166-2', uri: 'urn:iso:std:iso:3166:-2', description: 'ISO 3166-2 subdivision code', type: 'code'}]},
    {id: 'document-category', title: 'Kinds of health file entries', description: 'What an entry of a health file is (stage 2b).',
        concepts: () => Object.entries(documentCategories).map(([code, c]) => concept(code, c.label))},
    {id: 'document-source', title: 'Sources of health file entries', description: 'Where an entry of a health file came from (stage 2b).',
        concepts: () => Object.entries(documentSources).map(([code, labels]) => concept(code, labels))}
];

export const codeSystemUrl = id => `${CANONICAL}/CodeSystem/${id}`;
export const coding = (id, code, labels) => ({system: codeSystemUrl(id), code, display: labels[0]});

const count = concepts => concepts.reduce((n, c) => n + 1 + (c.concept ? count(c.concept) : 0), 0);

export function codeSystems() {
    return CODE_SYSTEMS.map(cs => {
        const concepts = cs.concepts();
        return {
            resourceType: 'CodeSystem', id: cs.id, url: codeSystemUrl(cs.id), version: PUBLISHED,
            name: cs.title.replace(/[^A-Za-z]/g, ''), title: cs.title, status: 'active', experimental: false, date: PUBLISHED,
            publisher: PUBLISHER, description: cs.description, caseSensitive: true, valueSet: `${CANONICAL}/ValueSet/${cs.id}`,
            ...(cs.id === 'facility-service' && {hierarchyMeaning: 'grouped-by'}),
            content: 'complete', count: count(concepts), ...(cs.property && {property: cs.property}), concept: concepts
        };
    });
}

// Each ValueSet holds every code of its CodeSystem, already expanded so a client needs no terminology server.
export function valueSets() {
    return codeSystems().map(cs => {
        const flat = [];
        const walk = list => list.forEach(c => {
            if (!(cs.id === 'facility-service' && c.concept)) flat.push({system: cs.url, code: c.code, display: c.display});
            if (c.concept) walk(c.concept);
        });
        walk(cs.concept);
        return {
            resourceType: 'ValueSet', id: cs.id, url: `${CANONICAL}/ValueSet/${cs.id}`, version: PUBLISHED, name: cs.name,
            title: cs.title, status: 'active', experimental: false, date: PUBLISHED, publisher: PUBLISHER, description: cs.description,
            compose: {include: [{system: cs.url}]},
            expansion: {identifier: `urn:uuid:${expansionId(cs.id)}`, timestamp: `${PUBLISHED}T00:00:00Z`, total: flat.length, contains: flat}
        };
    });
}

// Stable expansion identifiers (one fixed UUID per ValueSet).
const expansionId = id => ({
    specialty: '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e01', 'facility-kind': '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e02',
    'facility-service': '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e03', governorate: '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e04',
    'document-category': '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e05', 'document-source': '6f7a5d0e-1c2b-4d3e-9f40-5a6b7c8d9e06'
}[id]);

// Identifiers SyriaHC issues. The patient number is used from stage 2b on.
export function namingSystems() {
    return [{
        resourceType: 'NamingSystem', id: 'patient-number', name: 'SyriaHCPatientNumber', status: 'active', kind: 'identifier',
        date: PUBLISHED, publisher: PUBLISHER, responsible: PUBLISHER,
        description: 'SyriaHC patient number SHC-XXXX-XXXX-X: one per person, with a check character. Never a phone number.',
        type: {coding: [{system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR', display: 'Medical record number'}]},
        uniqueId: [{type: 'uri', value: `${CANONICAL}/sid/patient-number`, preferred: true}]
    }];
}
