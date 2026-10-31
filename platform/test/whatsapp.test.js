// Patients reached by WhatsApp (Meta's official Cloud API) where Meta delivers, by SMS everywhere else.
import {after, afterEach, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {approvedDoctor, config, cookieOf, setup, teardown} from './helpers.js';
import {DEFAULT_BLOCKED_PREFIXES, createWhatsApp} from '../src/whatsapp.js';
import {addDays, localDate} from '../src/slots.js';

let app, sms, whatsapp, post;
beforeEach(async () => {
    await app?.close();
    ({app, sms, whatsapp, post} = await setup({whatsapp: true}));
});
afterEach(() => { config.whatsapp.blockedPrefixes = DEFAULT_BLOCKED_PREFIXES; });
after(() => teardown(app));

const GERMAN = '+4915123456789', SYRIAN = '0912345678';
const requestCode = (phone, extra = {}) => post('/api/auth/otp/request', {phone, ...extra});

describe('sign-in codes', () => {
    test('a number Meta delivers to gets the code by WhatsApp, in the chosen language, and it signs in', async () => {
        const res = await requestCode(GERMAN, {language: 'en'});
        assert.equal(res.statusCode, 202);
        assert.equal(res.json().channel, 'whatsapp');
        assert.equal(sms.sent.length, 0);
        const [message] = whatsapp.sent;
        assert.equal(message.to, GERMAN);
        assert.equal(message.name, 'shc_login_code');
        assert.equal(message.language, 'en');
        assert.match(message.params[0], /^\d{6}$/);
        assert.equal(message.copyCode, message.params[0], 'the "Copy code" button carries the same code');
        const ok = await post('/api/auth/otp/verify', {phone: GERMAN, code: message.params[0], name: 'Omar Saleh', consent: true});
        assert.equal(ok.statusCode, 200);
        assert.ok(cookieOf(ok));
    });

    test('Syrian numbers get SMS, because Meta does not deliver to +963 yet', async () => {
        const res = await requestCode(SYRIAN);
        assert.equal(res.json().channel, 'sms');
        assert.equal(whatsapp.sent.length, 0);
        assert.equal(sms.sent[0].to, '+963912345678');
    });

    test('when Meta opens Syria, removing +963 from the blocked prefixes is enough', async () => {
        config.whatsapp.blockedPrefixes = DEFAULT_BLOCKED_PREFIXES.filter(p => p !== '+963');
        assert.equal((await requestCode(SYRIAN)).json().channel, 'whatsapp');
        assert.equal(whatsapp.sent[0].to, '+963912345678');
        assert.equal(whatsapp.sent[0].language, 'ar', 'Arabic unless the patient chose English');
    });

    test('"send by SMS instead" sends a new code by SMS, and only the newest code works', async () => {
        await requestCode(GERMAN);
        const first = whatsapp.sent[0].params[0];
        const res = await requestCode(GERMAN, {channel: 'sms'});
        assert.equal(res.json().channel, 'sms');
        const second = sms.sent[0].message.match(/\d{6}/)[0];
        if (first !== second) {
            const old = await post('/api/auth/otp/verify', {phone: GERMAN, code: first, name: 'Omar Saleh', consent: true});
            assert.equal(old.json().error, 'wrong_code');
        }
        assert.equal((await post('/api/auth/otp/verify', {phone: GERMAN, code: second, name: 'Omar Saleh', consent: true})).statusCode, 200);
    });

    test('if WhatsApp refuses the message, the code goes out by SMS', async () => {
        app.whatsapp.sendTemplate = async () => { throw new Error('WhatsApp API returned HTTP 400'); };
        const res = await requestCode(GERMAN);
        assert.equal(res.statusCode, 202);
        assert.equal(res.json().channel, 'sms');
        assert.equal(sms.sent[0].to, GERMAN);
    });

    test('WhatsApp and SMS codes share the limit of three per 15 minutes', async () => {
        await requestCode(GERMAN);
        await requestCode(GERMAN, {channel: 'sms'});
        await requestCode(GERMAN);
        assert.equal((await requestCode(GERMAN, {channel: 'sms'})).statusCode, 429);
    });
});

describe('appointment updates', () => {
    async function bookedBy(phone, language, doctorEmail = 'dr@example.org') {
        const doctor = await approvedDoctor(post, doctorEmail, 'Dr. Sara Haddad');
        await requestCode(phone, {language});
        const code = (whatsapp.sent.at(-1)?.to === normalized(phone) ? whatsapp.sent.at(-1).params[0] : sms.sent.at(-1).message.match(/\d{6}/)[0]);
        const patient = cookieOf(await post('/api/auth/otp/verify', {phone, code, name: 'Lina Patient', consent: true, language}));
        const day = addDays(localDate(Date.now(), 'Asia/Damascus'), 1);
        const [slot] = (await app.inject({url: `/api/doctors/${doctor.id}/slots?from=${day}&days=1`})).json().slots;
        const res = await post('/api/appointments', {doctor_id: doctor.id, starts_at: slot.starts_at, reason: 'Cough'}, {cookie: patient});
        whatsapp.sent.length = 0;
        sms.sent.length = 0;
        return {doctor, id: res.json().appointment.id};
    }
    const normalized = phone => phone.startsWith('+') ? phone : '+963' + phone.slice(1);
    const act = (doctor, id, action, body = {}) => post(`/api/doctor/appointments/${id}/${action}`, body, {cookie: doctor.cookie});

    test('confirmation by WhatsApp with doctor, time and address, in the patient\'s language', async () => {
        const {doctor, id} = await bookedBy(GERMAN, 'en');
        await act(doctor, id, 'confirm');
        const [message] = whatsapp.sent;
        assert.equal(message.name, 'shc_appointment_confirmed');
        assert.equal(message.language, 'en');
        assert.equal(message.params[0], 'Dr. Sara Haddad');
        assert.match(message.params[1], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        assert.equal(message.params[2], 'Mezzeh Highway 12');
        assert.equal(sms.sent.length, 0);
    });

    test('declining and cancelling pass the doctor\'s reason, or say none was given', async () => {
        const {doctor, id} = await bookedBy(GERMAN, 'ar');
        await act(doctor, id, 'decline');
        assert.equal(whatsapp.sent[0].name, 'shc_appointment_declined');
        assert.equal(whatsapp.sent[0].params[2], 'دون ذكر سبب');
        const second = await bookedBy(GERMAN.replace(/9$/, '8'), 'en', 'second@example.org');
        await act(second.doctor, second.id, 'confirm');
        await act(second.doctor, second.id, 'cancel', {note: 'The clinic is closed that day'});
        assert.equal(whatsapp.sent.at(-1).name, 'shc_appointment_cancelled');
        assert.equal(whatsapp.sent.at(-1).params[2], 'The clinic is closed that day');
    });

    test('Syrian patients still get the SMS text', async () => {
        const {doctor, id} = await bookedBy(SYRIAN, 'ar');
        await act(doctor, id, 'confirm');
        assert.equal(whatsapp.sent.length, 0);
        assert.match(sms.sent[0].message, /تم تأكيد موعدك/);
    });
});

describe('Meta Cloud API request', () => {
    test('sends an approved template with cleaned values and the copy-code button', async () => {
        const calls = [], realFetch = globalThis.fetch;
        globalThis.fetch = async (url, options) => {
            calls.push({url, options});
            return new Response('{"messages":[{"id":"wamid.1"}]}', {status: 200});
        };
        try {
            const cloud = createWhatsApp({whatsapp: {provider: 'cloud', phoneNumberId: '1234567890', token: 'secret-token', apiVersion: 'v24.0'}});
            await cloud.sendTemplate('+4915123456789', {name: 'shc_login_code', language: 'ar', params: ['123456'], copyCode: '123456'});
            await cloud.sendTemplate('+4915123456789', {name: 'shc_appointment_declined', language: 'en', params: ['Dr. X', '2026-11-02 10:00', 'Line one\n\n\tline two']});
        } finally {
            globalThis.fetch = realFetch;
        }
        assert.equal(calls[0].url, 'https://graph.facebook.com/v24.0/1234567890/messages');
        assert.equal(calls[0].options.headers.Authorization, 'Bearer secret-token');
        const code = JSON.parse(calls[0].options.body);
        assert.equal(code.to, '4915123456789');
        assert.deepEqual(code.template.components, [
            {type: 'body', parameters: [{type: 'text', text: '123456'}]},
            {type: 'button', sub_type: 'url', index: '0', parameters: [{type: 'text', text: '123456'}]}
        ]);
        const declined = JSON.parse(calls[1].options.body);
        assert.equal(declined.template.components.length, 1);
        assert.equal(declined.template.components[0].parameters[2].text, 'Line one line two', 'no line breaks or tabs, as Meta requires');
    });

    test('an error from Meta is reported, so the caller can fall back to SMS', async () => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = async () => new Response('{"error":{"code":131026}}', {status: 400});
        try {
            const cloud = createWhatsApp({whatsapp: {provider: 'cloud', phoneNumberId: '1', token: 't', apiVersion: 'v24.0'}});
            await assert.rejects(cloud.sendTemplate('+491', {name: 'x', language: 'ar', params: []}), /HTTP 400 \(code 131026\)/);
        } finally {
            globalThis.fetch = realFetch;
        }
    });

    test('refuses to start without a phone number ID and token', () => {
        assert.throws(() => createWhatsApp({whatsapp: {provider: 'cloud'}}), /WHATSAPP_PHONE_NUMBER_ID/);
        assert.equal(createWhatsApp({whatsapp: {provider: ''}}), null, 'not set up: SMS only');
    });
});
