// The one list of FHIR resources, interactions and search parameters. /metadata (CapabilityStatement) is built from it,
// and unknown search parameters are refused against it, so the published contract cannot drift from the code.
import {PUBLISHED} from './terminology.js';

export const RESOURCES = {
    Practitioner: {read: true, search: {name: 'string', active: 'token'}},
    PractitionerRole: {read: true, search: {specialty: 'token', practitioner: 'reference', location: 'reference', active: 'token'}},
    Location: {read: true, search: {name: 'string', type: 'token', active: 'token'}},
    Organization: {read: true, search: {name: 'string', type: 'token', active: 'token'}},
    HealthcareService: {read: true, search: {name: 'string', category: 'token', type: 'token', active: 'token'}},
    Schedule: {read: true, search: {}},
    Slot: {read: true, search: {schedule: 'reference', start: 'date', status: 'token'}},
    CodeSystem: {read: true, search: {}},
    ValueSet: {read: true, search: {}},
    NamingSystem: {read: true, search: {}},
    Endpoint: {read: true, search: {}}
};

// The health file (stage 2b): only for a signed-in patient and only the own profiles, listed while HEALTH_FILE=on.
// Patient has no search at all: nobody can look for a person, only read a profile they already hold.
export const HEALTH_RESOURCES = {
    Patient: {read: true, search: {}, operations: [{name: 'everything', definition: 'http://hl7.org/fhir/OperationDefinition/Patient-everything'}]},
    RelatedPerson: {read: true, search: {}},
    DocumentReference: {read: true, search: {patient: 'reference', type: 'token', date: 'date'}},
    Binary: {read: true, search: {}},
    DiagnosticReport: {read: true, search: {patient: 'reference'}},
    Consent: {read: false, search: {patient: 'reference'}},
    Appointment: {read: false, search: {patient: 'reference'}}
};

// Parameters every search accepts.
export const COMMON_PARAMS = ['_count'];

export function capabilityStatement(base, {health = false} = {}) {
    return {
        resourceType: 'CapabilityStatement', status: 'active', experimental: false, date: `${PUBLISHED}T00:00:00Z`,
        publisher: 'SyriaHC', kind: 'instance',
        software: {name: 'SyriaHC platform', version: '2.0'},
        implementation: {description: 'SyriaHC public directory (IHE mCSD style), HL7 FHIR R4', url: base},
        fhirVersion: '4.0.1', format: ['json'],
        rest: [{
            mode: 'server',
            ...(health && {security: {description: 'Health file resources (Patient, RelatedPerson, DocumentReference, Binary, DiagnosticReport, ' +
                'Consent, Appointment) need a signed-in patient session and show only their own profiles. There is no patient search.'}}),
            resource: Object.entries({...RESOURCES, ...(health ? HEALTH_RESOURCES : {})}).map(([type, def]) => ({
                type,
                interaction: [...(def.read ? [{code: 'read'}] : []), ...(Object.keys(def.search).length ? [{code: 'search-type'}] : [])],
                // FHIR JSON forbids empty arrays, so resources without search parameters leave the element out.
                ...(Object.keys(def.search).length && {searchParam: Object.entries(def.search).map(([name, type]) => ({name, type}))}),
                ...(def.operations && {operation: def.operations})
            }))
        }]
    };
}
