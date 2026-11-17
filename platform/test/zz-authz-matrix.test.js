// Pentest: authorization matrix. Twelve accounts with real data; every route that takes an id is called by every
// account that has no business with that id. Any 2xx answer is printed for review.
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import {approvedDoctor, confirmSession, cookieOf, origin, pool, registerStaff, setup, signIn, signInPatientByEmail, teardown} from './helpers.js';
import {multipart, PDF} from './fixtures.js';
import {addDays, localDate} from '../src/slots.js';

let app, post, mail;
const get = (url, cookie) => app.inject({url, headers: cookie ? {cookie} : {}});
const day = n => addDays(localDate(new Date()), n);
const A = {};       // actor name -> cookie (anon: undefined)
const ids = [];     // {id, kind, allowed: [actor names]}
const X = {};      // values for valid request bodies
const own = (kind, id, ...allowed) => { assert.ok(id, kind); ids.push({kind, id: String(id), allowed}); return id; };

async function facility(email, kind, name) {
    const cookie = cookieOf(await registerStaff(post, 'facility', {name: 'Contact', email, password: 'facility password 123', consent: true, kind}));
    const {rows: [f]} = await pool.query(`UPDATE facility_profiles p SET status = 'approved', facility_name = $2, governorate = 'damascus', area = 'Mezzeh',
        address = 'Mezzeh 1', phone = '+963112223344' FROM users u WHERE u.id = p.user_id AND u.email = $1 RETURNING p.user_id`, [email, name]);
    await pool.query("UPDATE facility_profiles SET services = ARRAY['home_collection'] WHERE user_id = $1", [f.user_id]);
    return {cookie, id: f.user_id};
}
const upload = (url, cookie, fields) => {
    const form = multipart(fields, [{name: 'file', filename: 'r.pdf', type: 'application/pdf', content: PDF}]);
    return app.inject({method: 'POST', url, payload: form.body, headers: {origin, cookie, 'content-type': form.contentType}});
};
const pushKeys = () => {
    const e = createECDH('prime256v1');
    e.generateKeys();
    return {endpoint: `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString('hex')}`,
        keys: {p256dh: e.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url')}};
};
const must = async (res, what) => { assert.ok(res.statusCode < 300, `${what}: ${res.statusCode} ${res.body}`); return res.json(); };

before(async () => {
    ({app, post, mail} = await setup());
    A.anon = undefined;
    A.admin = await confirmSession(await signIn(post, 'admin', 'admin@example.org'));
    const drA = await approvedDoctor(post, 'dra@example.org', 'Dr. A', {confirmed: true});
    const drB = await approvedDoctor(post, 'drb@example.org', 'Dr. B', {confirmed: true});
    A.drA = drA.cookie; A.drB = drB.cookie;
    A.drPending = await signIn(post, 'doctor', 'pending@example.org', 'Dr. Pending');
    const labA = await facility('laba@example.org', 'lab', 'Lab A'), labB = await facility('labb@example.org', 'lab', 'Lab B');
    const bank = await facility('bank@example.org', 'blood_bank', 'Bank'), pharmacy = await facility('ph@example.org', 'pharmacy', 'Pharmacy');
    A.labA = labA.cookie; A.labB = labB.cookie; A.bank = bank.cookie; A.pharmacy = pharmacy.cookie;
    A.labPending = cookieOf(await registerStaff(post, 'facility', {name: 'Contact', email: 'labp@example.org', password: 'facility password 123', consent: true, kind: 'lab'}));
    A.lina = await signInPatientByEmail(post, mail, 'lina@example.org', 'Lina Haddad');
    A.omar = await signInPatientByEmail(post, mail, 'omar@example.org', 'Omar Stranger');

    // Lina's data.
    const self = (await get('/api/file', A.lina)).json().profiles[0];
    own('profile', self.id, 'lina', 'drA');
    await must(await post(`/api/file/profiles/${self.id}/consent`, {}, {cookie: A.lina}), 'consent');
    const {item} = await must(await upload(`/api/file/profiles/${self.id}/documents`, A.lina, {category: 'report', title: 'Cardiology report'}), 'document');
    own('document', item.id, 'lina', 'drA');
    Object.assign(X, {item: item.id, drA: drA.id, drB: drB.id});
    const {item: item2} = await must(await upload(`/api/file/profiles/${self.id}/documents`, A.lina, {category: 'report', title: 'Unshared report'}), 'document 2');
    own('document', item2.id, 'lina');
    const {profile: child} = await must(await post('/api/file/profiles', {name: 'Sami Haddad', birth_date: '2021-03-01'}, {cookie: A.lina}), 'child');
    own('profile', child.id, 'lina');
    const {share} = await must(await post(`/api/file/profiles/${self.id}/shares`, {doctor_id: drA.id, item_ids: [item.id], days: 30}, {cookie: A.lina}), 'share');
    own('share', share.id, 'lina');
    const [slot, slot2] = (await get(`/api/doctors/${drA.id}/slots?from=${day(1)}&days=1`)).json().slots;
    X.slot2 = slot2.starts_at;
    const {appointment} = await must(await post('/api/appointments', {doctor_id: drA.id, starts_at: slot.starts_at}, {cookie: A.lina}), 'appointment');
    own('appointment', appointment.id, 'lina', 'drA');
    const {rows: [past]} = await pool.query(`INSERT INTO appointments (doctor_id, patient_id, starts_at, ends_at, status)
        SELECT $1, id, now() - interval '2 days', now() - interval '2 days' + interval '30 minutes', 'completed' FROM users WHERE email = 'lina@example.org' RETURNING id`, [drA.id]);
    own('appointment', past.id, 'lina', 'drA');
    const {review} = await must(await post(`/api/appointments/${past.id}/review`, {rating: 4, comment: 'Kind'}, {cookie: A.lina}), 'review');
    own('review', review.id, 'lina', 'drA');
    const {visit} = await must(await post('/api/home-visits', {facility_id: labA.id, visit_date: day(2), time_window: 'morning', address: 'Mezzeh 12', phone: '0912345678'}, {cookie: A.lina}), 'home visit');
    own('homeVisit', visit.id, 'lina', 'labA');
    const {medication} = await must(await post('/api/medications', {profile_id: self.id, name: 'Sertraline', dose: '50 mg', times: ['08:00']}, {cookie: A.lina}), 'medication');
    own('medication', medication.id, 'lina');
    const wait = await must(await post('/api/waitlist', {doctor_id: drB.id}, {cookie: A.lina}), 'waitlist');
    own('waitlist', wait.entry?.id ?? wait.id, 'lina', 'drB');
    await must(await post('/api/push/subscribe', pushKeys(), {cookie: A.lina}), 'push');
    await must(await post('/api/donor', {blood_type: 'O-', governorate: 'damascus', phone: '0944 123 456', consent: true}, {cookie: A.lina}), 'donor');

    // Staff data.
    await must(await post('/api/doctor/time-off', {starts_on: day(5), ends_on: day(5), note: 'Conference'}, {cookie: A.drA}), 'time off');
    const {rows: [off]} = await pool.query('SELECT id FROM time_off LIMIT 1');
    own('timeOff', off.id, 'drA');
    const docForm = multipart({kind: 'licence'}, [{name: 'file', filename: 'licence.pdf', type: 'application/pdf', content: PDF}]);
    const doc = await must(await app.inject({method: 'POST', url: '/api/doctor/documents', payload: docForm.body,
        headers: {origin, cookie: A.drPending, 'content-type': docForm.contentType}}), 'licence');
    own('doctorDocument', doc.document?.id ?? doc.id, 'drPending', 'admin');
    const {result} = await must(await upload('/api/lab/results', A.labA, {patient_name: 'Lina Haddad', patient_phone: '0912 345 678', title: 'CBC', birth_year: '1990'}), 'lab result');
    own('labResult', result.id, 'labA');
    const {test: labTest} = await must(await post('/api/facility/tests', {name: 'CBC', price_syp: 1000}, {cookie: A.labA}), 'lab test');
    own('labTest', labTest.id, 'labA');
    const {test: labTest2} = await must(await post('/api/facility/tests', {name: 'HbA1c', price_syp: 2000}, {cookie: A.labA}), 'lab test 2');
    const pkg = await must(await post('/api/facility/packages', {name: 'Check-up', topic: 'checkup', price_syp: 5000, test_ids: [labTest.id, labTest2.id]}, {cookie: A.labA}), 'package');
    own('package', pkg.package?.id ?? pkg.id, 'labA');
    const blood = await must(await post('/api/facility/blood-requests', {blood_types: ['O-'], units: 2, urgency: 'urgent', needed_by: day(3)}, {cookie: A.bank}), 'blood request');
    own('bloodRequest', blood.request?.id ?? blood.id, 'bank', 'lina', 'omar');
    const duty = await must(await post('/api/pharmacy/duties', {date: day(1), from: '20:00', to: '08:00'}, {cookie: A.pharmacy}), 'duty');
    own('duty', duty.duties?.[0]?.id ?? duty.duty?.id ?? duty.id, 'pharmacy');
    for (const [name, id] of Object.entries({drA: drA.id, drB: drB.id, labA: labA.id, labB: labB.id, bank: bank.id, pharmacy: pharmacy.id})) own('user', id, name, 'admin');
});
after(() => teardown(app));

// Valid bodies, so that a request passes the schema check and reaches the access check.
const BODY = {
    '/api/file/profiles/{id}/claim': () => ({code: 'SHC-0000-0000', check: '1990'}),
    '/api/file/profiles/{id}/shares': () => ({doctor_id: X.drB, item_ids: [X.item], days: 30}),
    '/api/file/profiles/{id}/share-codes': () => ({item_ids: [X.item]}),
    '/api/file/scans/{id}/revoke': () => ({doctor_id: X.drA}),
    '/api/appointments/{id}/reschedule': () => ({starts_at: X.slot2}),
    '/api/medications/{id}/dose': () => ({scheduled_for: new Date().toISOString()}),
    '/api/appointments/{id}/review': () => ({rating: 5}),
    '/api/doctor/reviews/{id}/reply': () => ({reply: 'Thank you'}),
    '/api/doctor/reviews/{id}/report': () => ({reason: 'Not a real visit'}),
    '/api/video/{id}/signal': () => ({type: 'hello'}),
    '/api/doctor/appointments/{id}/cancel': () => ({note: 'Closed today'}),
    '/api/doctor/appointments/{id}/decline': () => ({note: 'Closed today'}),
    '/api/lab/home-visits/{id}/decline': () => ({note: 'Closed today'}),
    '/api/lab/home-visits/{id}/cancel': () => ({note: 'Closed today'}),
    '/api/home-visits/{id}/cancel': () => ({note: 'Closed today'}),
    '/api/appointments/{id}/cancel': () => ({note: 'Closed today'}),
    '/api/medications/{id}': () => ({name: 'Changed', dose: '1 mg', times: ['09:00']}),
    '/api/file/profiles/{id}': () => ({name: 'Changed Name'}),
    '/api/facility/tests/{id}': () => ({name: 'Changed', price_syp: 1}),
    '/api/facility/packages/{id}': () => ({name: 'Changed', topic: 'checkup', price_syp: 1, test_ids: []})
};
const statusCount = {}, other = [];

// Routes that are public by design.
const PUBLIC = [/^GET \/api\/doctors\/\{id\}(\/slots|\/reviews)?$/, /^GET \/api\/labs\/\{id\}$/, /^POST \/api\/blood-requests\/\{id\}\/respond$/];
const KIND = {profiles: ['profile'], patients: ['profile'], documents: ['document', 'doctorDocument'], shared: ['document', 'profile'], appointments: ['appointment'],
    video: ['appointment'], 'home-visits': ['homeVisit'], medications: ['medication'], waitlist: ['waitlist'], shares: ['share'], results: ['labResult'],
    tests: ['labTest'], packages: ['package'], 'blood-requests': ['bloodRequest'], duties: ['duty'], reviews: ['review'], 'time-off': ['timeOff'],
    doctors: ['user'], facilities: ['user'], labs: ['user'], users: ['user']};

test('no account reaches data that is not its own', async () => {
    const spec = (await get('/api/openapi.json')).json();
    const ops = Object.entries(spec.paths).flatMap(([p, v]) => Object.keys(v).filter(m => ['get', 'post', 'delete'].includes(m)).map(m => [m.toUpperCase(), p]))
        .filter(([, p]) => p.includes('{id}'))
        .sort((a, b) => (a[0] === 'GET' ? 0 : 1) - (b[0] === 'GET' ? 0 : 1));   // reads first, then writes
    const findings = [];
    let calls = 0;
    for (const [method, path] of ops) {
        if (PUBLIC.some(r => r.test(`${method} ${path}`))) continue;
        const segment = path.split('/{id}')[0].split('/').at(-1);
        const candidates = ids.filter(x => (KIND[segment] ?? Object.values(KIND).flat()).includes(x.kind));
        for (const target of candidates) {
            for (const actor of Object.keys(A)) {
                if (target.allowed.includes(actor)) continue;
                if (path.startsWith('/api/admin/') && actor === 'admin') continue;
                const url = path.replace('{id}', target.id).replace('{page}', '1').replace('{item}', target.id);
                const headers = {origin, ...(A[actor] ? {cookie: A[actor]} : {})};
                const res = await app.inject({method, url, headers, ...(method === 'POST' ? {payload: BODY[path]?.() ?? {}} : {})});
                calls++;
                const key = `${method} ${path}`;
                (statusCount[key] ??= {})[res.statusCode] = (statusCount[key][res.statusCode] ?? 0) + 1;
                if (![401, 403, 404].includes(res.statusCode) && res.statusCode >= 300) other.push(`${res.statusCode} ${actor.padEnd(9)} ${method} ${path} [${target.kind}] ${res.body.slice(0, 120)}`);
                if (res.statusCode < 300) findings.push(`${res.statusCode} ${actor.padEnd(9)} ${method} ${path}  [${target.kind} of ${target.allowed[0]}]  ${res.body.slice(0, 160)}`);
            }
        }
    }
    console.log(`\n${ops.length} routes with an id, ${calls} calls, ${findings.length} answered 2xx:`);
    for (const f of findings) console.log('  ' + f);
    console.log(`answers other than 401/403/404: ${other.length}`);
    for (const o of [...new Set(other.map(o => o.replace(/^(\d+) (\S+)\s+/, '$1 ')))]) console.log('  ' + o);
    const schemaOnly = Object.entries(statusCount).filter(([, c]) => Object.keys(c).every(code => code === '400'));
    console.log(`routes that only ever answered 400 (access check never reached): ${schemaOnly.length}`);
    for (const [route, c] of schemaOnly) console.log('  ' + route, JSON.stringify(c));
    assert.equal(findings.length, 0);
});

// Function level: routes without an id, called by roles they are not for, and by doctors and labs not yet approved.
const ROLE_OF = [[/^\/api\/admin\//, ['admin']], [/^\/api\/doctor\//, ['drA', 'drB']], [/^\/api\/(facility|lab|pharmacy)\//, ['labA', 'labB', 'bank', 'pharmacy']],
    [/^\/api\/(file|medications|donor|waitlist|reviews\/mine|appointments\/mine|home-visits\/mine)/, ['lina', 'omar']]];
test('no role reaches routes of another role, and unapproved staff cannot touch patients', async () => {
    const spec = (await get('/api/openapi.json')).json();
    const ops = Object.entries(spec.paths).flatMap(([p, v]) => Object.keys(v).filter(m => ['get', 'post'].includes(m)).map(m => [m.toUpperCase(), p]))
        .filter(([, p]) => !p.includes('{') && !/^\/api\/(auth|account)\//.test(p));
    const findings = [], pendingOk = [];
    for (const [method, path] of ops) {
        const owners = ROLE_OF.find(([r]) => r.test(path))?.[1];
        if (!owners) continue;
        for (const actor of Object.keys(A)) {
            if (owners.includes(actor)) continue;
            const res = await app.inject({method, url: path, headers: {origin, ...(A[actor] ? {cookie: A[actor]} : {})}, ...(method === 'POST' ? {payload: {}} : {})});
            if (res.statusCode >= 300) continue;
            const line = `${res.statusCode} ${actor.padEnd(10)} ${method} ${path}  ${res.body.slice(0, 140)}`;
            (['drPending', 'labPending'].includes(actor) ? pendingOk : findings).push(line);
        }
    }
    console.log(`\nwrong role answered 2xx: ${findings.length}`);
    for (const f of findings) console.log('  ' + f);
    console.log(`unapproved staff answered 2xx (own profile pages are expected): ${pendingOk.length}`);
    for (const f of pendingOk) console.log('  ' + f);
    assert.equal(findings.length, 0);
});

test('ten patients booking the same time at once: exactly one gets it', async () => {
    const {rows: [dr]} = await pool.query("SELECT id FROM users WHERE email = 'drb@example.org'");
    const slots = (await get(`/api/doctors/${dr.id}/slots?from=${day(2)}&days=1`)).json().slots;
    const slot = slots[3];
    const patients = [];
    for (let i = 0; i < 10; i++) patients.push(await signInPatientByEmail(post, mail, `race${i}@example.org`, `Race ${i}`));
    const answers = await Promise.all(patients.map(cookie => post('/api/appointments', {doctor_id: dr.id, starts_at: slot.starts_at}, {cookie})));
    const codes = answers.map(a => a.statusCode);
    console.log('booking answers:', codes.join(' '));
    assert.equal(codes.filter(c => c === 201).length, 1);
    const {rows: [n]} = await pool.query("SELECT count(*)::int AS n FROM appointments WHERE doctor_id = $1 AND starts_at = $2 AND status IN ('requested', 'confirmed')", [dr.id, slot.starts_at]);
    assert.equal(n.n, 1);
});
