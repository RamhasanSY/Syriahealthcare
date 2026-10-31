// Sign-in codes by Telegram (Telegram Gateway API), between WhatsApp and SMS.
import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, cookieOf, setup, teardown} from './helpers.js';
import {createTelegramGateway} from '../src/telegram.js';
import {addDays, localDate} from '../src/slots.js';

let app, sms, whatsapp, telegram, post;
const start = async options => {
    await app?.close();
    ({app, sms, whatsapp, telegram, post} = await setup(options));
};
beforeEach(() => start({telegram: true}));
after(() => teardown(app));

const SYRIAN = '0912345678', SYRIAN_E164 = '+963912345678', GERMAN = '+4915123456789';
const requestCode = (phone, extra = {}) => post('/api/auth/otp/request', {phone, ...extra});

describe('sign-in codes by Telegram', () => {
    test('a Syrian number with Telegram gets the code there, valid as long as the code, and it signs in', async () => {
        const res = await requestCode(SYRIAN);
        assert.equal(res.statusCode, 202);
        assert.equal(res.json().channel, 'telegram');
        assert.equal(sms.sent.length, 0);
        const [message] = telegram.sent;
        assert.equal(message.to, SYRIAN_E164);
        assert.match(message.code, /^\d{6}$/);
        assert.equal(message.ttlSeconds, 300, 'Telegram drops the message when the code expires');
        const ok = await post('/api/auth/otp/verify', {phone: SYRIAN, code: message.code, name: 'Lina Haddad', consent: true});
        assert.equal(ok.statusCode, 200);
        assert.ok(cookieOf(ok));
    });

    test('a number without Telegram gets SMS', async () => {
        telegram.unreachable.add(SYRIAN_E164);
        const res = await requestCode(SYRIAN);
        assert.equal(res.json().channel, 'sms');
        assert.equal(telegram.sent.length, 0);
        assert.equal(sms.sent[0].to, SYRIAN_E164);
    });

    test('"send by SMS instead" skips Telegram', async () => {
        await requestCode(SYRIAN);
        assert.equal((await requestCode(SYRIAN, {channel: 'sms'})).json().channel, 'sms');
        assert.equal(telegram.sent.length, 1);
        assert.equal(sms.sent.length, 1);
    });

    test('with WhatsApp too: WhatsApp where Meta delivers, Telegram for Syrian numbers', async () => {
        await start({whatsapp: true, telegram: true});
        assert.equal((await requestCode(GERMAN)).json().channel, 'whatsapp');
        assert.equal((await requestCode(SYRIAN)).json().channel, 'telegram');
        assert.equal(whatsapp.sent.length, 1);
        assert.equal(telegram.sent.length, 1);
        assert.equal(sms.sent.length, 0);
    });

    test('appointment updates never go by Telegram, which carries codes only', async () => {
        const doctor = await approvedDoctor(post, 'dr@example.org', 'Dr. Sara Haddad');
        await requestCode(SYRIAN);
        const patient = cookieOf(await post('/api/auth/otp/verify', {phone: SYRIAN, code: telegram.sent[0].code, name: 'Lina', consent: true}));
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const [slot] = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${day}&days=1`})).json().slots;
        const {id} = (await post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at}, {cookie: patient})).json().appointment;
        await post(`/api/doctor/appointments/${id}/confirm`, {}, {cookie: doctor.cookie});
        assert.equal(telegram.sent.length, 1, 'only the sign-in code');
        assert.match(sms.sent.at(-1).message, /تم تأكيد موعدك/);
    });
});

describe('Telegram Gateway API request', () => {
    async function withFetch(answers, fn) {
        const calls = [], realFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            calls.push({url, options, body: JSON.parse(options.body)});
            const [status, body] = answers.shift();
            return new Response(JSON.stringify(body), {status});
        };
        try {
            await fn();
        } finally {
            globalThis.fetch = realFetch;
        }
        return calls;
    }
    const gateway = () => createTelegramGateway({telegram: {provider: 'gateway', token: 'gw-token'}});

    test('checks the number first, then sends our own code under the same request (charged once)', async () => {
        const calls = await withFetch([
            [200, {ok: true, result: {request_id: 'req-1', phone_number: SYRIAN_E164, request_cost: 0.01}}],
            [200, {ok: true, result: {request_id: 'req-1', phone_number: SYRIAN_E164, request_cost: 0}}]
        ], () => gateway().sendCode(SYRIAN_E164, '123456', 300));
        assert.equal(calls[0].url, 'https://gatewayapi.telegram.org/checkSendAbility');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer gw-token');
        assert.deepEqual(calls[0].body, {phone_number: SYRIAN_E164});
        assert.equal(calls[1].url, 'https://gatewayapi.telegram.org/sendVerificationMessage');
        assert.deepEqual(calls[1].body, {phone_number: SYRIAN_E164, request_id: 'req-1', code: '123456', ttl: 300});
    });

    test('a number Telegram cannot reach is reported and nothing is sent', async () => {
        let error;
        const calls = await withFetch([[200, {ok: false, error: 'PHONE_NUMBER_NOT_AVAILABLE'}]],
            () => gateway().sendCode(SYRIAN_E164, '123456', 300).catch(e => { error = e; }));
        assert.equal(calls.length, 1);
        assert.match(error.message, /PHONE_NUMBER_NOT_AVAILABLE/);
    });

    test('not used without a token', () => {
        assert.equal(createTelegramGateway({telegram: {provider: ''}}), null);
        assert.throws(() => createTelegramGateway({telegram: {provider: 'gateway'}}), /TELEGRAM_GATEWAY_TOKEN/);
    });
});
