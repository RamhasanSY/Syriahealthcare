import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {fileURLToPath} from 'node:url';
import authRoutes, {loadSession} from './auth.js';
import {createSms} from './sms.js';
import {createMail} from './mail.js';
import {createTelegramGateway} from './telegram.js';
import {createWhatsApp} from './whatsapp.js';
import doctorRoutes from './doctors.js';
import scheduleRoutes from './schedule.js';
import appointmentRoutes from './appointments.js';
import dashboardRoutes from './dashboard.js';
import facilityRoutes from './facilities.js';
import {createDocumentStore} from './documents.js';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp({config, pool, sms, whatsapp, telegram, mail, documents, logger = true}) {
    const app = Fastify({logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024});
    app.decorate('config', config);
    app.decorate('pg', pool);
    app.decorate('sms', sms || createSms(config, app.log));
    app.decorate('whatsapp', whatsapp === undefined ? createWhatsApp(config) : whatsapp);
    app.decorate('telegram', telegram === undefined ? createTelegramGateway(config) : telegram);
    app.decorate('mail', mail || createMail(config, app.log));
    app.decorate('documents', documents || createDocumentStore({dir: config.documentDir, keyHex: config.documentKey}));
    app.decorateRequest('user', null);

    await app.register(cookie);
    await app.register(rateLimit, {global: false});

    // Forms and scripts on other websites must not be able to act for a signed-in user.
    app.addHook('onRequest', async (request, reply) => {
        if (!UNSAFE.has(request.method)) return;
        if (request.headers.origin !== config.appOrigin) {
            reply.code(403).send({error: 'bad_origin', message: 'Request blocked.'});
            return reply;
        }
    });
    app.addHook('preHandler', loadSession);

    app.addHook('onSend', async (request, reply, payload) => {
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('X-Frame-Options', 'DENY');
        reply.header('Referrer-Policy', 'same-origin');
        reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        if (config.production) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
        if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
        return payload;
    });

    app.setErrorHandler((error, request, reply) => {
        if (error.validation) return reply.code(400).send({error: 'invalid_request', message: 'Some fields are missing or not valid.'});
        const status = error.statusCode || 500;
        if (status >= 500) request.log.error({err: error}, 'Request failed');
        reply.code(status).send({
            error: error.code && status < 500 ? error.code : status === 429 ? 'rate_limited' : 'server_error',
            message: status < 500 ? error.message : 'Something went wrong. Please try again.',
            ...(error.missing && {missing: error.missing})
        });
    });

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
    await app.register(fastifyStatic, {root: fileURLToPath(new URL('../public/', import.meta.url)), extensions: ['html']});
    return app;
}
