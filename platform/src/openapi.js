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
    // Facilities and labs
    'GET /api/facility/profile': 'Facility: own profile and review status.',
    'POST /api/facility/profile': 'Facility: update the profile (identifying fields wait for review once approved).',
    'POST /api/facility/documents': {summary: 'Facility: upload a licence document (PDF, JPEG or PNG, up to 5 MB).', upload: true},
    'DELETE /api/facility/documents/{id}': 'Facility: remove a document before approval.',
    'POST /api/facility/submit': 'Facility: send the profile for review.',
    'GET /api/lab/results': 'Lab: search all own results by name, phone, test and date, 50 per page.',
    'POST /api/lab/results': {summary: 'Lab: upload a result for a patient and get the QR slip.', upload: true},
    'POST /api/lab/results/{id}/code': 'Lab: print a new QR code for a result (the old one stops working).',
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
    'POST /api/admin/users/{id}/enable': 'Administrator: switch a staff account on again.'
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
