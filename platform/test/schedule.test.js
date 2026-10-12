import {after, beforeEach, describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {origin, pool, setup, signIn, teardown} from './helpers.js';
import {addDays, localDate} from '../src/slots.js';

let app, post;
beforeEach(async () => {
    await app?.close();
    ({app, post} = await setup());
});
after(() => teardown(app));

const everyDay = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, starts_at: '09:00', ends_at: '12:00'}));
const week = {slot_minutes: 30, booking_window_days: 14, min_notice_hours: 0, hours: everyDay};
const today = () => localDate(Date.now(), 'Asia/Damascus');
const doctorId = async email => (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;

describe('opening hours', () => {
    test('new doctors get sensible defaults and no hours', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const res = await app.inject({url: '/api/doctor/schedule', headers: {cookie}});
        assert.equal(res.json().settings.slot_minutes, 20);
        assert.equal(res.json().settings.timezone, 'Asia/Damascus');
        assert.deepEqual(res.json().hours, []);
        assert.equal(res.json().configured, false);
    });

    test('saving replaces all hours and settings', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await post('/api/doctor/schedule', week, {cookie})).statusCode, 200);
        const saved = await post('/api/doctor/schedule', {...week, slot_minutes: 15, hours: [{weekday: 0, starts_at: '17:00', ends_at: '19:30'}]}, {cookie});
        assert.equal(saved.json().settings.slot_minutes, 15);
        assert.deepEqual(saved.json().hours, [{weekday: 0, starts_at: '17:00', ends_at: '19:30'}]);
    });

    test('invalid hours are refused with a clear reason', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        const overlap = await post('/api/doctor/schedule', {...week, hours: [{weekday: 1, starts_at: '09:00', ends_at: '12:00'}, {weekday: 1, starts_at: '11:00', ends_at: '13:00'}]}, {cookie});
        assert.equal(overlap.json().error, 'overlapping_hours');
        assert.equal((await post('/api/doctor/schedule', {...week, slot_minutes: 25}, {cookie})).statusCode, 400);
        assert.equal((await post('/api/doctor/schedule', {...week, booking_window_days: 400}, {cookie})).statusCode, 400);
    });

    test('the preview shows free slots, respecting days off', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        await post('/api/doctor/schedule', week, {cookie});
        const tomorrow = addDays(today(), 1);
        const before = await app.inject({url: `/api/doctor/slots?from=${tomorrow}&days=1`, headers: {cookie}});
        assert.equal(before.json().slots.length, 6);
        assert.equal((await post('/api/doctor/time-off', {starts_on: tomorrow, ends_on: tomorrow, note: 'Conference'}, {cookie})).statusCode, 201);
        const after = await app.inject({url: `/api/doctor/slots?from=${tomorrow}&days=1`, headers: {cookie}});
        assert.equal(after.json().slots.length, 0);
    });

    test('days off must be in order, not in the past, and can be removed', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        assert.equal((await post('/api/doctor/time-off', {starts_on: addDays(today(), 3), ends_on: addDays(today(), 2)}, {cookie})).json().error, 'end_before_start');
        assert.equal((await post('/api/doctor/time-off', {starts_on: '2020-01-01', ends_on: '2020-01-02'}, {cookie})).json().error, 'in_the_past');
        assert.equal((await post('/api/doctor/time-off', {starts_on: '2026-02-30', ends_on: '2026-03-01'}, {cookie})).json().error, 'invalid_date');
        const added = await post('/api/doctor/time-off', {starts_on: addDays(today(), 5), ends_on: addDays(today(), 6)}, {cookie});
        const id = added.json().timeOff[0].id;
        const other = await signIn(post, 'doctor', 'other@example.org');
        assert.equal((await app.inject({method: 'DELETE', url: `/api/doctor/time-off/${id}`, headers: {origin, cookie: other}})).statusCode, 404);
        assert.deepEqual((await app.inject({method: 'DELETE', url: `/api/doctor/time-off/${id}`, headers: {origin, cookie}})).json().timeOff, []);
    });

    test('suspended doctors cannot change their hours', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        await pool.query("UPDATE doctor_profiles SET status = 'suspended'");
        assert.equal((await post('/api/doctor/schedule', week, {cookie})).statusCode, 403);
    });
});

describe('public slots', () => {
    test('only approved doctors show free slots to the public', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        await post('/api/doctor/schedule', week, {cookie});
        const id = await doctorId('dr@example.org');
        const url = `/api/doctors/${id}/slots?from=${addDays(today(), 1)}&days=2`;
        assert.equal((await app.inject({url})).statusCode, 404, 'not approved yet');
        await pool.query("UPDATE doctor_profiles SET status = 'approved'");
        const res = await app.inject({url});
        assert.equal(res.statusCode, 200);
        assert.equal(res.json().slots.length, 12);
        assert.deepEqual(Object.keys(res.json().slots[0]).sort(), ['date', 'ends_at', 'starts_at', 'time'], 'no private details');
        await pool.query("UPDATE doctor_profiles SET status = 'suspended'");
        assert.equal((await app.inject({url})).statusCode, 404);
    });

    test('dates in the past start from today', async () => {
        const cookie = await signIn(post, 'doctor', 'dr@example.org');
        await post('/api/doctor/schedule', week, {cookie});
        const res = await app.inject({url: '/api/doctor/slots?from=2020-01-01&days=1', headers: {cookie}});
        assert.equal(res.json().from, today());
    });
});
