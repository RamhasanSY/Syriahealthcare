import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import pageRoutes, {assetCacheControl} from './pages.js';
import {rateLimitKey} from './security.js';
import {createMetrics} from './metrics.js';
import {fileURLToPath} from 'node:url';
import authRoutes, {HttpError, loadSession} from './auth.js';
import {createSms} from './sms.js';
import {createMail} from './mail.js';
import {createTelegramGateway} from './telegram.js';
import {createWhatsApp} from './whatsapp.js';
import doctorRoutes from './doctors.js';
import scheduleRoutes from './schedule.js';
import appointmentRoutes from './appointments.js';
import dashboardRoutes from './dashboard.js';
import facilityRoutes from './facilities.js';
import resultRoutes from './results.js';
import {createDocumentStore} from './documents.js';
import fhirRoutes from './fhir/index.js';
import accountRoutes from './accounts.js';
import healthFileRoutes from './healthfile.js';
import sharingRoutes from './sharing.js';
import oauthRoutes from './oauth.js';
import hl7v2Routes from './hl7v2.js';
import labServiceRoutes from './lab-services.js';
import statusRoutes from './status.js';
import pushRoutes, {createPush} from './push.js';
import appointmentComfortRoutes from './appointment-comfort.js';
import bloodRoutes from './blood.js';
import pharmacyDutyRoutes from './pharmacy-duty.js';
import labPackageRoutes from './lab-packages.js';
import medicationRoutes from './medications.js';
import reviewRoutes from './reviews.js';
import videoRoutes from './video.js';
import openapiRoutes, {collectRoutes} from './openapi.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// Lab and clinic software (stage 2d) authenticates with a client secret or a Bearer token, never with the session cookie,
// so these paths need no Origin check (a forged form from another website has no token to send).
const TOKEN_ONLY = /^\/(oauth\/token|fhir\/r4\/?|hl7v2)(\?|$)/;

export async function buildApp({config, pool, sms, whatsapp, telegram, mail, documents, push, logger = true}) {
    // Request logs show the path only: searches like ?q=<patient name or phone> never end up in a log file.
    const quietLogger = logger === true ? {serializers: {req: request => ({method: request.method, url: String(request.url).split('?')[0], remoteAddress: request.ip})}} : logger;
    const app = Fastify({logger: quietLogger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024});
    app.decorate('config', config);
    app.decorate('pg', pool);
    app.decorate('sms', sms || createSms(config, app.log));
    app.decorate('whatsapp', whatsapp === undefined ? createWhatsApp(config) : whatsapp);
    app.decorate('telegram', telegram === undefined ? createTelegramGateway(config) : telegram);
    app.decorate('mail', mail || createMail(config, app.log));
    app.decorate('documents', documents || createDocumentStore({dir: config.documentDir, keyHex: config.documentKey}));
    app.decorate('push', push || createPush(config, app.log));
    app.decorateRequest('user', null);
    app.decorateRequest('startedAt', 0n);
    app.decorate('metrics', createMetrics());

    await app.register(cookie);
    // Limits count an IPv6 /64 network as one client (src/security.js rateLimitKey), for every limited route.
    await app.register(rateLimit, {global: false, keyGenerator: request => rateLimitKey(request.ip)});

    // Forms and scripts on other websites must not be able to act for a signed-in user.
    app.addHook('onRequest', async (request, reply) => {
        if (!UNSAFE.has(request.method) || TOKEN_ONLY.test(request.url)) return;
        if (request.headers.origin !== config.appOrigin) {
            reply.code(403).send({error: 'bad_origin', message: 'Request blocked.'});
            return reply;
        }
    });
    app.addHook('preHandler', loadSession);
    app.addHook('onRequest', async request => { request.startedAt = process.hrtime.bigint(); });
    // Response times per route for the administrators' status page (src/metrics.js).
    app.addHook('onResponse', async (request, reply) => {
        app.metrics.record(request.method, request.routeOptions?.url || 'unmatched', reply.statusCode, Number(process.hrtime.bigint() - request.startedAt) / 1e6);
    });

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'same-origin');
        // Camera and microphone only on the video call page (src/video.js).
        const camera = config.video?.enabled && String(request.url).split('?')[0] === '/video';
        reply.header('Permissions-Policy', camera ? 'camera=(self), microphone=(self), geolocation=()' : 'camera=(), microphone=(), geolocation=()');
        // A route may set a stricter policy of its own (patients' files are sent in a sandbox, src/healthfile.js).
        if (!reply.getHeader('Content-Security-Policy')) {
            reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        }
        if (config.production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        // Personal answers are never stored; a few public lists say themselves how long they may be kept (config.cache).
        // Decided on the matched route ("/%61pi/me" is /api/me too); anything unmatched under /api stays unstored as well.
        const route = request.routeOptions?.url || '';
        if (route.startsWith('/api/') || request.url.startsWith('/api/')) reply.header('Cache-Control', request.routeOptions?.config?.cache || 'no-store');
        if (route.startsWith('/assets/') || (route === '/*' && request.url.startsWith('/assets/'))) {
            if (reply.statusCode === 200) reply.header('Cache-Control', assetCacheControl(request.url));
        }
        // How long the server worked on this answer, for the browser's network panel (no personal data).
        if (request.startedAt) reply.header('Server-Timing', `app;dur=${(Number(process.hrtime.bigint() - request.startedAt) / 1e6).toFixed(1)}`);
        return payload;
    });

    app.setErrorHandler((error, request, reply) => {
        if (error.validation) return reply.code(400).send({error: 'invalid_request', message: 'Some fields are missing or not valid.'});
        const status = error.statusCode || 500;
        if (status >= 500) request.log.error({err: error}, 'Request failed');
        // Our own errors (HttpError) always carry a message meant for the user, also for 502/503 such as "the SMS or
        // email could not be sent". Anything unexpected only says that something went wrong.
        const ours = error instanceof HttpError;
        reply.code(status).send({
            error: error.code && (ours || status < 500) ? error.code : status === 429 ? 'rate_limited' : 'server_error',
            message: ours || status < 500 ? error.message : 'Something went wrong. Please try again.',
            ...(error.missing && {missing: error.missing})
        });
    });

    // Every /api route, for the OpenAPI description (/api/openapi.json). Must come before the routes.
    const routes = collectRoutes(app);
    app.get('/api/health', async () => {
        await pool.query('SELECT 1');
        return {ok: true};
    });
    await app.register(authRoutes);
    await app.register(doctorRoutes);
    await app.register(scheduleRoutes);
    await app.register(appointmentRoutes);
    await app.register(dashboardRoutes);
    await app.register(facilityRoutes);
    await app.register(resultRoutes);
    await app.register(accountRoutes);
    await app.register(healthFileRoutes);
    await app.register(sharingRoutes);
    await app.register(oauthRoutes);
    await app.register(hl7v2Routes);
    await app.register(labServiceRoutes);
    await app.register(statusRoutes);
    await app.register(pushRoutes);
    await app.register(appointmentComfortRoutes);
    await app.register(bloodRoutes);
    await app.register(pharmacyDutyRoutes);
    await app.register(labPackageRoutes);
    await app.register(medicationRoutes);
    await app.register(reviewRoutes);
    await app.register(videoRoutes);
    await app.register(openapiRoutes, {routes});
    await app.register(fhirRoutes, {prefix: '/fhir/r4'});
    const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
    await app.register(fastifyStatic, {root: publicDir, index: false});
    // Pages from memory with versioned asset links (src/pages.js).
    await app.register(pageRoutes, {publicDir});
    return app;
}
