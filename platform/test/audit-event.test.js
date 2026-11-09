import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, pool, setup, signIn, teardown} from './helpers.js';
import {auditEvent, eventKind} from '../src/fhir/audit.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
});
after(() => teardown(app));

const row = (over = {}) => ({id: 7, action: 'result.viewed', actor_id: '11111111-1111-4111-8111-111111111111', actor_role: 'doctor',
    actor_name: 'Dr. Approved', target_id: '22222222-2222-4222-8222-222222222222', ip: '203.0.113.9', created_at: new Date('2026-11-09T10:00:00Z'), ...over});

describe('audit trail as FHIR AuditEvent (IHE BALP)', () => {
    test('a doctor opening a result is a RESTful read of a DiagnosticReport by a Practitioner', () => {
        const e = auditEvent(row());
        assert.equal(e.resourceType, 'AuditEvent');
        assert.equal(e.id, '7');
        assert.deepEqual(e.type, {system: 'http://terminology.hl7.org/CodeSystem/audit-event-type', code: 'rest', display: 'Restful Operation'});
        assert.deepEqual(e.subtype, [{system: 'http://hl7.org/fhir/restful-interaction', code: 'read'}]);
        assert.equal(e.action, 'R');
        assert.equal(e.recorded, '2026-11-09T10:00:00.000Z');
        assert.equal(e.outcome, '0');
        assert.equal(e.agent[0].who.reference, 'Practitioner/11111111-1111-4111-8111-111111111111');
        assert.equal(e.agent[0].requestor, true);
        assert.deepEqual(e.agent[0].network, {address: '203.0.113.9', type: '2'});
        assert.equal(e.entity[0].what.reference, 'DiagnosticReport/22222222-2222-4222-8222-222222222222');
        assert.equal(e.source.observer.display, 'SyriaHC platform');
    });

    test('patients never see the network address', () => {
        const e = auditEvent(row(), {withNetwork: false});
        assert.equal(e.agent[0].network, undefined);
        assert.doesNotMatch(JSON.stringify(e), /203\.0\.113\.9/);
    });

    test('actions map to create, update, delete and login', () => {
        assert.equal(eventKind('result.uploaded').action, 'C');
        assert.equal(eventKind('appointment.requested').action, 'C');
        assert.equal(eventKind('doctor.approved').action, 'U');
        assert.equal(eventKind('document.deleted').action, 'D');
        const login = eventKind('login.second_factor');
        assert.equal(login.action, 'E');
        assert.equal(login.type.code, '110114');
        assert.equal(login.subtype.code, '110122');
    });

    test('administrators and the system appear without a FHIR resource of their own', () => {
        const byAdmin = auditEvent(row({action: 'account.disabled', actor_role: 'admin'}));
        assert.equal(byAdmin.agent[0].who.reference, undefined);
        assert.equal(byAdmin.agent[0].who.identifier.value, '11111111-1111-4111-8111-111111111111');
        assert.equal(byAdmin.entity[0].what.identifier.value, '22222222-2222-4222-8222-222222222222', 'an account is not a FHIR resource');
        const bySystem = auditEvent(row({action: 'admin.created_from_cli', actor_id: null, ip: null}));
        assert.equal(bySystem.agent[0].who.display, 'SyriaHC system');
    });

    test('every row the platform writes maps without empty elements', async () => {
        await approvedDoctor(post);
        const admin = await signIn(post, 'admin', 'admin@example.org');
        await app.inject({url: '/api/admin/doctors?status=approved', headers: {cookie: admin}});
        const {rows} = await pool.query(`SELECT a.*, u.role::text AS actor_role, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id`);
        assert.ok(rows.length >= 2);
        for (const r of rows) {
            const text = JSON.stringify(auditEvent(r));
            assert.doesNotMatch(text, /null|\[\]|\{\}|""/, r.action);
        }
    });
});
