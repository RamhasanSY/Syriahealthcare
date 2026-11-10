// OpenAPI 3.1 description of the app interface (/api), published at /api/openapi.json (stage 2.0).
// Paths, parameters and bodies come from the routes' own JSON schemas, and who may call a route comes from its
// requireRole guard, so the description cannot drift from the code. Only the one-line summaries are written here,
// and a test fails when a route has none.

// One line per route, "METHOD /path" as registered. `upload`: the body is multipart/form-data with one file.
export const SUMMARIES = {
    'GET /api/health': 'Health check: the server and its database answer.',
    'GET /api/catalog': 'Fixed lists: specialties, governorates, facility kinds and services, with English and Arabic labels.',
    'GET /api/openapi.json': 'This description.',
    // Sign-in
    'POST /api/auth/otp/request': 'Patient: ask for a sign-in code by SMS, WhatsApp or Telegram.',
    'POST /api/auth/otp/verify': 'Patient: sign in with the code sent to the phone.',
    'GET /api/auth/methods': 'Which patient sign-in methods are available now.',
    'POST /api/auth/email/request': 'Patient: ask for a sign-in code by email.',
    'POST /api/auth/email/verify': 'Patient: sign in with the code sent by email.',
    'POST /api/auth/doctor/register': 'Create a doctor account.',
    'POST /api/auth/facility/register': 'Create an account for a lab, imaging centre, hospital or clinic.',
    'POST /api/auth/login': 'Doctor, facility or administrator: sign in with email and password (administrators then get an email code).',
    'POST /api/auth/login/verify': 'Administrator: finish signing in with the email code.',
    'POST /api/auth/password/forgot': 'Ask for a password reset link by email.',
    'POST /api/auth/password/reset': 'Set a new password with the link from the email.',
    'POST /api/auth/logout': 'Sign out.',
    'GET /api/me': 'The signed-in account.',
    // Public directory and booking
    'GET /api/doctors': 'Approved doctors, filterable by specialty, governorate and name.',
    'GET /api/doctors/{id}': 'One approved doctor.',
    'GET /api/doctors/{id}/slots': 'Free appointment times of an approved doctor.',
    'GET /api/facilities': 'Approved labs, imaging centres, hospitals and clinics.',
    'POST /api/appointments': 'Patient: request an appointment.',
    'GET /api/appointments/mine': 'Patient: own appointments.',
    'POST /api/appointments/{id}/cancel': 'Patient: cancel an own appointment.',
    'POST /api/appointments/{id}/reschedule': 'Patient: move an own appointment to another free time of the same doctor (the doctor confirms again).',
    'GET /api/appointments/{id}/calendar.ics': 'Patient or doctor: the appointment as a calendar file.',
    'POST /api/waitlist': 'Patient: be told when a time with this doctor becomes free (30 days).',
    'GET /api/waitlist/mine': 'Patient: the doctors on the own waiting list.',
    'POST /api/waitlist/{id}/leave': 'Patient: leave a waiting list.',
    // Doctors
    'GET /api/doctor/profile': 'Doctor: own profile and review status.',
    'POST /api/doctor/profile': 'Doctor: update the profile (identifying fields wait for review once approved).',
    'POST /api/doctor/documents': {summary: 'Doctor: upload a licence or ID document (PDF, JPEG or PNG, up to 5 MB).', upload: true},
    'DELETE /api/doctor/documents/{id}': 'Doctor: remove a document before approval.',
    'POST /api/doctor/submit': 'Doctor: send the profile for review.',
    'GET /api/doctor/schedule': 'Doctor: opening hours, appointment length and days off.',
    'POST /api/doctor/schedule': 'Doctor: replace opening hours and booking settings.',
    'POST /api/doctor/time-off': 'Doctor: add days off.',
    'DELETE /api/doctor/time-off/{id}': 'Doctor: remove days off.',
    'GET /api/doctor/slots': 'Doctor: own free times, as patients see them.',
    'GET /api/doctor/appointments': 'Doctor: requests, upcoming and past appointments.',
    'POST /api/doctor/appointments/{id}/confirm': 'Doctor: confirm a requested appointment.',
    'POST /api/doctor/appointments/{id}/decline': 'Doctor: decline a requested appointment.',
    'POST /api/doctor/appointments/{id}/cancel': 'Doctor: cancel a confirmed appointment (with a reason).',
    'POST /api/doctor/appointments/{id}/complete': 'Doctor: mark an appointment as done.',
    'POST /api/doctor/appointments/{id}/no-show': 'Doctor: mark that the patient did not come.',
    'POST /api/doctor/results/lookup': 'Doctor: check whose result a scanned code is.',
    'POST /api/doctor/results/add': 'Doctor: add a scanned result to the own patient files.',
    'GET /api/doctor/records': 'Doctor: own patient files with scanned results.',
    'GET /api/doctor/results/{id}/file': 'Doctor: open a result from the own patient files.',
    'GET /api/doctor/results/{id}/values': 'Doctor: the measured values of a scanned result (recorded).',
    // Facilities and labs
    'GET /api/facility/profile': 'Facility: own profile and review status.',
    'POST /api/facility/profile': 'Facility: update the profile (identifying fields wait for review once approved).',
    'POST /api/facility/documents': {summary: 'Facility: upload a licence document (PDF, JPEG or PNG, up to 5 MB).', upload: true},
    'DELETE /api/facility/documents/{id}': 'Facility: remove a document before approval.',
    'POST /api/facility/submit': 'Facility: send the profile for review.',
    'GET /api/lab/results': 'Lab: search all own results by name, phone, test and date, 50 per page.',
    'POST /api/lab/results': {summary: 'Lab: upload a result for a patient and get the QR slip.', upload: true},
    'POST /api/lab/results/{id}/code': 'Lab: print a new QR code for a result (the old one stops working).',
    // Health file (stage 2b; only while HEALTH_FILE=on, otherwise 404)
    'GET /api/file': "Patient: own profile and children's profiles with their SyriaHC patient numbers.",
    'POST /api/file/profiles': "Patient: add a child's profile (under 18).",
    'POST /api/file/profiles/{id}': 'Patient: change name, birth date or sex of an own profile.',
    'POST /api/file/profiles/{id}/consent': 'Patient: agree to keeping a health file for this profile.',
    'POST /api/file/profiles/{id}/consent/withdraw': 'Patient: withdraw the agreement (no new entries).',
    'GET /api/file/profiles/{id}/items': 'Patient: the health file as a timeline, filterable by kind and date; bin=true lists the bin.',
    'POST /api/file/profiles/{id}/documents': {summary: 'Patient: upload a document, one file per page (PDF, JPEG or PNG, 5 MB each, up to 10 pages). Photos lose their location and other metadata.', upload: true},
    'GET /api/file/documents/{id}/pages/{page}': 'Patient: open one page of an entry (recorded).',
    'GET /api/file/documents/{id}/values': 'Patient: the measured values of a lab result as a table (recorded).',
    'POST /api/file/documents/{id}/delete': 'Patient: move an entry to the bin (30 days to restore).',
    'POST /api/file/documents/{id}/restore': 'Patient: bring an entry back from the bin.',
    'POST /api/file/profiles/{id}/claim': 'Patient: take a lab result into the file with the slip code and the birth year or the last 3 digits of the mobile number.',
    'POST /api/file/claim/report': "Patient: report that a result on the own slip is in someone else's file.",
    // Sharing (stage 2c; only while HEALTH_FILE=on)
    'POST /api/file/profiles/{id}/shares': 'Patient: share chosen entries with an approved doctor for 1, 30 or 90 days.',
    'POST /api/file/profiles/{id}/share-codes': 'Patient: a one-time QR code that gives the doctor who scans it 15 minutes for the chosen entries.',
    'GET /api/file/profiles/{id}/access': 'Patient: who has access (shares and scanned slips) and who opened what, without network addresses.',
    'POST /api/file/shares/{id}/revoke': 'Patient: end a share at once.',
    'POST /api/file/shares/{id}/items/{item}/revoke': 'Patient: take one entry out of a share.',
    'POST /api/file/scans/{id}/revoke': 'Patient: take a scanned lab result back from a doctor.',
    'POST /api/auth/step-up/request': 'Doctor: get an emailed code to confirm it is you before opening shared files.',
    'POST /api/auth/step-up/verify': 'Doctor: confirm with the emailed code; optionally remember this device for 30 days.',
    'POST /api/doctor/share-codes/redeem': 'Doctor: open the entries a patient shows as QR code (15 minutes).',
    'GET /api/doctor/patients': 'Doctor: My patients, from appointments, scanned slips and shares, searchable by name, mobile or patient number.',
    'GET /api/doctor/patients/{id}': 'Doctor: the entries a patient shares with you now.',
    'GET /api/doctor/shared/{id}/pages/{page}': 'Doctor: open one page of a shared entry (recorded, the patient sees it).',
    'GET /api/doctor/shared/{id}/values': 'Doctor: the measured values of a shared lab result (recorded, the patient sees it).',
    // Software connections (stage 2d)
    'GET /api/admin/api-clients': 'Administrator: software connections (OAuth clients) of facilities.',
    'POST /api/admin/api-clients': 'Administrator: create a connection for an approved facility; the secret is shown only in this answer.',
    'POST /api/admin/api-clients/{id}/revoke': 'Administrator: end a connection at once.',
    'GET /api/facility/api-clients': 'Facility: own software connections (never secrets) and the addresses to send to.',
    // Lab services: price list and home sample collection
    'GET /api/facility/tests': 'Lab: own price list.',
    'POST /api/facility/tests': 'Lab: add a test with price, time to result and a note.',
    'POST /api/facility/tests/{id}': 'Lab: change a test in the price list.',
    'POST /api/facility/tests/{id}/delete': 'Lab: remove a test from the price list.',
    'GET /api/labs/{id}': 'An approved lab with its price list and whether it collects samples at home.',
    'POST /api/home-visits': 'Patient: ask a lab to take samples at home on a day and time of day.',
    'GET /api/home-visits/mine': 'Patient: own home sample collection requests.',
    'POST /api/home-visits/{id}/cancel': 'Patient: cancel a home visit.',
    'GET /api/lab/home-visits': 'Lab: home visit requests (new, confirmed, past).',
    'POST /api/lab/home-visits/{id}/confirm': 'Lab: confirm a home visit, optionally with an arrival time.',
    'POST /api/lab/home-visits/{id}/decline': 'Lab: decline a home visit (with a reason).',
    'POST /api/lab/home-visits/{id}/cancel': 'Lab: cancel a confirmed home visit (with a reason).',
    'POST /api/lab/home-visits/{id}/done': 'Lab: mark a home visit as done.',
    'GET /api/admin/status': 'Administrator: speed and health of the platform (response times, memory, database, email queue, disk).',
    // Administrators
    'GET /api/admin/doctors': 'Administrator: doctors by review status.',
    'GET /api/admin/doctors/{id}': 'Administrator: one doctor with documents, held changes and history.',
    'GET /api/admin/documents/{id}': 'Administrator: open a licence document (recorded).',
    'POST /api/admin/doctors/{id}/approve': 'Administrator: approve a doctor.',
    'POST /api/admin/doctors/{id}/reject': 'Administrator: ask a doctor for changes.',
    'POST /api/admin/doctors/{id}/suspend': 'Administrator: suspend a doctor (hidden from the public).',
    'POST /api/admin/doctors/{id}/changes/accept': 'Administrator: accept held profile changes.',
    'POST /api/admin/doctors/{id}/changes/reject': 'Administrator: reject held profile changes.',
    'GET /api/admin/facilities': 'Administrator: facilities by review status.',
    'GET /api/admin/facilities/{id}': 'Administrator: one facility with documents, held changes and history.',
    'POST /api/admin/facilities/{id}/approve': 'Administrator: approve a facility.',
    'POST /api/admin/facilities/{id}/reject': 'Administrator: ask a facility for changes.',
    'POST /api/admin/facilities/{id}/suspend': 'Administrator: suspend a facility (hidden from the public).',
    'POST /api/admin/facilities/{id}/changes/accept': 'Administrator: accept held profile changes.',
    'POST /api/admin/facilities/{id}/changes/reject': 'Administrator: reject held profile changes.',
    'POST /api/admin/users/{id}/disable': 'Administrator: switch off a staff account (signs it out everywhere).',
    'POST /api/admin/users/{id}/enable': 'Administrator: switch a staff account on again.',
    // Notifications on the phone or computer (src/push.js)
    'GET /api/push/key': 'Whether notifications are offered, and the key a browser needs to receive them.',
    'POST /api/push/subscribe': 'Receive notifications on this device.',
    'POST /api/push/unsubscribe': 'Stop notifications on this device.',
    'POST /api/push/test': 'Send a test notification to the own devices.',
    // Blood donation calls (src/blood.js; the donor register only while HEALTH_FILE=on)
    'GET /api/blood-requests': 'Open blood donation calls, by governorate and by the blood group that can help.',
    'POST /api/blood-requests/{id}/respond': 'Donor: "I can donate" (name, phone and blood group go to this facility).',
    'GET /api/facility/blood-requests': 'Blood bank or hospital: own donation calls with how many donors were told and answered.',
    'POST /api/facility/blood-requests': 'Blood bank or hospital: publish a donation call; matching donors are told.',
    'POST /api/facility/blood-requests/{id}/close': 'Blood bank or hospital: close a donation call.',
    'GET /api/facility/blood-requests/{id}/responses': 'Blood bank or hospital: the donors who answered a call (recorded).',
    'GET /api/donor': 'Patient: own donor registration.',
    'POST /api/donor': 'Patient: register or update as a blood donor (blood group, governorate, mobile).',
    'POST /api/donor/delete': 'Patient: leave the donor list (blood group, phone and answers are removed).'
};

const ROLE_TAGS = {patient: 'Patients', doctor: 'Doctors', facility: 'Facilities', admin: 'Administrators'};
const openapiPath = url => url.replace(/:([A-Za-z_]+)/g, '{$1}');

// Registers an onRoute hook; call before the routes are added. Returns the live list of /api routes.
export function collectRoutes(app) {
    const routes = [];
    app.addHook('onRoute', route => {
        if (!route.url.startsWith('/api/')) return;
        for (const method of [].concat(route.method)) {
            if (method === 'HEAD') continue;
            const guards = [].concat(route.preHandler || []).filter(fn => Array.isArray(fn?.roles));
            routes.push({method, path: openapiPath(route.url), schema: route.schema || {}, roles: guards.flatMap(g => g.roles)});
        }
    });
    return routes;
}

const parameters = (schema, where) => Object.entries(schema?.properties || {}).map(([name, s]) => ({
    name, in: where, required: where === 'path' || (schema.required || []).includes(name), schema: s
}));

const ERROR = {description: 'Error', content: {'application/json': {schema: {$ref: '#/components/schemas/Error'}}}};

export function openapiDocument(routes, origin) {
    const paths = {};
    for (const route of routes) {
        const doc = SUMMARIES[`${route.method} ${route.path}`];
        const {summary, upload} = typeof doc === 'string' ? {summary: doc} : doc || {};
        const operation = {
            summary: summary || route.path,
            tags: route.roles.length ? route.roles.map(r => ROLE_TAGS[r] || r) : ['Public'],
            parameters: [...parameters(route.schema.params, 'path'), ...parameters(route.schema.querystring, 'query')],
            responses: {200: {description: 'OK'}, 400: ERROR, ...(route.roles.length && {401: ERROR, 403: ERROR}), 404: ERROR, 429: ERROR}
        };
        if (route.roles.length) operation.security = [{session: []}];
        if (upload) {
            operation.requestBody = {required: true, content: {'multipart/form-data': {schema: {type: 'object', properties: {file: {type: 'string', contentMediaType: 'application/octet-stream'}}}}}};
        } else if (route.schema.body) {
            operation.requestBody = {required: true, content: {'application/json': {schema: route.schema.body}}};
        }
        if (!operation.parameters.length) delete operation.parameters;
        (paths[route.path] ||= {})[route.method.toLowerCase()] = operation;
    }
    return {
        openapi: '3.1.0',
        info: {
            title: 'SyriaHC app interface', version: '2.0',
            description: 'The interface the SyriaHC web app uses. Public routes need nothing; the others need the session cookie set at sign-in. ' +
                'Every state-changing request must carry the Origin header of the platform. Standard health data is offered separately as HL7 FHIR R4 at /fhir/r4. ' +
                'Errors are JSON {error, message}.'
        },
        servers: [{url: origin}],
        tags: [{name: 'Public'}, ...Object.values(ROLE_TAGS).map(name => ({name}))],
        paths,
        components: {
            securitySchemes: {session: {type: 'apiKey', in: 'cookie', name: 'shc_session'}},
            schemas: {Error: {type: 'object', required: ['error', 'message'], properties: {error: {type: 'string'}, message: {type: 'string'}}}}
        }
    };
}

export default async function openapiRoutes(app, {routes}) {
    let cached;
    app.get('/api/openapi.json', async () => (cached ||= openapiDocument(routes, app.config.appOrigin)));
}
