// The audit trail (audit_log) as HL7 FHIR R4 AuditEvent, following IHE BALP (Basic Audit Log Patterns).
// Stage 2a only maps; stage 2c shows patients "who opened my file" from these resources, always without network addresses.
import {prune} from './map.js';

const REST = 'http://terminology.hl7.org/CodeSystem/audit-event-type';
const INTERACTION = 'http://hl7.org/fhir/restful-interaction';
const DCM = 'http://dicom.nema.org/resources/ontology/DCM';
const ENTITY_TYPE = 'http://terminology.hl7.org/CodeSystem/audit-entity-type';
const OBJECT_ROLE = 'http://terminology.hl7.org/CodeSystem/object-role';
const PARTICIPATION = 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType';
const SOURCE_TYPE = 'http://terminology.hl7.org/CodeSystem/security-source-type';

// What the record is about, by the first part of the action ("result.viewed" → DiagnosticReport).
const TARGET_TYPE = {
    result: 'DiagnosticReport', appointment: 'Appointment', document: 'DocumentReference', doctor: 'Practitioner',
    facility: 'Organization', patient: 'Patient', schedule: 'Schedule', health_document: 'DocumentReference', health_file: 'Patient'
};
// Actions whose target is not what the first part says: a share is a Consent; codes and slips have no FHIR resource.
const ACTION_TARGET = {
    'health_file.shared': 'Consent', 'health_file.share_revoked': 'Consent', 'health_file.share_code_used': 'Consent',
    'health_file.share_code_created': null, 'health_file.scan_revoked': null, 'health_file.opened': 'Patient'
};
// Who acted, by account role. Administrators have no FHIR resource and appear by identifier only.
const ACTOR_TYPE = {doctor: 'Practitioner', facility: 'Organization', patient: 'Patient'};
const ACCOUNT_SYSTEM = 'https://syriahc.com/fhir/sid/account-id';

// The FHIR action code (C, R, U, D, E) and the event type for one audit action.
export function eventKind(action) {
    const [, verb = ''] = action.split('.');
    if (action.startsWith('login.')) {
        return {action: 'E', type: {system: DCM, code: '110114', display: 'User Authentication'}, subtype: {system: DCM, code: '110122', display: 'Login'}};
    }
    if (verb === 'searched') return {action: 'E', type: {system: REST, code: 'rest', display: 'Restful Operation'}, subtype: {system: INTERACTION, code: 'search-type'}};
    if (verb === 'exported') return {action: 'R', type: {system: REST, code: 'rest', display: 'Restful Operation'}, subtype: {system: INTERACTION, code: 'operation'}};
    const code = /^(viewed|opened|read)$/.test(verb) ? 'read'
        : /^(uploaded|registered|requested|created|added|code_sent|claimed|profile_created|consent_given|shared|share_code_created|share_code_used)$/.test(verb) ? 'create'
            : /^(deleted|removed)$/.test(verb) ? 'delete' : 'update';
    return {action: {read: 'R', create: 'C', delete: 'D', update: 'U'}[code],
        type: {system: REST, code: 'rest', display: 'Restful Operation'}, subtype: {system: INTERACTION, code}};
}

const reference = (type, id, display) => type ? {reference: `${type}/${id}`, display} : {identifier: {system: ACCOUNT_SYSTEM, value: id}, display};

// row: {id, action, actor_id, actor_role, actor_name, target_id, ip, created_at}.
// withNetwork: false for patients, who see who opened their file but never the network address.
export function auditEvent(row, {withNetwork = true} = {}) {
    const kind = eventKind(row.action);
    const targetType = row.action in ACTION_TARGET ? ACTION_TARGET[row.action] : TARGET_TYPE[row.action.split('.')[0]];
    return prune({
        resourceType: 'AuditEvent', id: String(row.id),
        meta: {lastUpdated: new Date(row.created_at).toISOString()},
        type: kind.type, subtype: [kind.subtype], action: kind.action,
        recorded: new Date(row.created_at).toISOString(), outcome: '0', outcomeDesc: row.action,
        agent: [{
            type: {coding: [{system: PARTICIPATION, code: 'IRCP', display: 'information recipient'}]},
            who: row.actor_id ? reference(ACTOR_TYPE[row.actor_role], row.actor_id, row.actor_name) : {display: 'SyriaHC system'},
            requestor: true,
            network: withNetwork && row.ip ? {address: String(row.ip), type: '2'} : undefined
        }],
        source: {observer: {display: 'SyriaHC platform'}, type: [{system: SOURCE_TYPE, code: '4', display: 'Application Server'}]},
        entity: [
            ...(row.target_id ? [{
                what: targetType ? {reference: `${targetType}/${row.target_id}`} : {identifier: {system: ACCOUNT_SYSTEM, value: row.target_id}},
                type: {system: ENTITY_TYPE, code: '2', display: 'System Object'},
                role: targetType === 'Patient' ? {system: OBJECT_ROLE, code: '1', display: 'Patient'} : {system: OBJECT_ROLE, code: '4', display: 'Domain Resource'}
            }] : []),
            // IHE BALP patient-centric: the patient whose file was touched, when it is not the target itself.
            ...(row.details?.patient_id && !(targetType === 'Patient' && row.target_id === row.details.patient_id) ? [{
                what: {reference: `Patient/${row.details.patient_id}`},
                type: {system: ENTITY_TYPE, code: '1', display: 'Person'},
                role: {system: OBJECT_ROLE, code: '1', display: 'Patient'}
            }] : [])
        ]
    });
}
