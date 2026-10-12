import {describe, test} from 'node:test';
import assert from 'node:assert/strict';
import {freeSlots, hoursProblem, localToUtc} from '../src/slots.js';

const schedule = {timezone: 'Asia/Damascus', slot_minutes: 30, booking_window_days: 30, min_notice_hours: 0};
// 2026-10-18 is a Sunday (weekday 0).
const sundayMorning = [{weekday: 0, starts_at: '09:00', ends_at: '11:00'}];
const early = Date.parse('2026-10-01T00:00:00Z');

describe('time zones', () => {
    test('Damascus is UTC+3', () => {
        assert.equal(new Date(localToUtc('2026-10-18', '09:00', 'Asia/Damascus')).toISOString(), '2026-10-18T06:00:00.000Z');
    });
    test('handles daylight saving where it exists', () => {
        assert.equal(new Date(localToUtc('2026-07-01', '09:00', 'Europe/Berlin')).toISOString(), '2026-07-01T07:00:00.000Z');
        assert.equal(new Date(localToUtc('2026-12-01', '09:00', 'Europe/Berlin')).toISOString(), '2026-12-01T08:00:00.000Z');
    });
});

describe('free slots', () => {
    test('splits opening hours into appointments of the chosen length', () => {
        const slots = freeSlots({schedule, hours: sundayMorning, from: '2026-10-18', days: 1, now: early});
        assert.deepEqual(slots.map(s => s.time), ['09:00', '09:30', '10:00', '10:30']);
        assert.equal(slots[0].starts_at, '2026-10-18T06:00:00.000Z');
        assert.equal(slots[0].ends_at, '2026-10-18T06:30:00.000Z');
    });

    test('an appointment that would run past closing time is not offered', () => {
        const slots = freeSlots({schedule: {...schedule, slot_minutes: 45}, hours: sundayMorning, from: '2026-10-18', days: 1, now: early});
        assert.deepEqual(slots.map(s => s.time), ['09:00', '09:45']);
    });

    test('several ranges per day, only on the right weekdays', () => {
        const hours = [{weekday: 0, starts_at: '17:00', ends_at: '18:00'}, ...sundayMorning, {weekday: 2, starts_at: '09:00', ends_at: '09:30'}];
        const slots = freeSlots({schedule, hours, from: '2026-10-18', days: 3, now: early});
        assert.deepEqual(slots.map(s => `${s.date} ${s.time}`), [
            '2026-10-18 09:00', '2026-10-18 09:30', '2026-10-18 10:00', '2026-10-18 10:30', '2026-10-18 17:00', '2026-10-18 17:30', '2026-10-20 09:00']);
    });

    test('respects minimum notice', () => {
        const now = Date.parse('2026-10-18T06:10:00Z');  // 09:10 in Damascus
        const slots = freeSlots({schedule: {...schedule, min_notice_hours: 1}, hours: sundayMorning, from: '2026-10-18', days: 1, now});
        assert.deepEqual(slots.map(s => s.time), ['10:30'], 'only slots starting at least an hour from now');
    });

    test('stops at the end of the booking window', () => {
        const everyDay = [0, 1, 2, 3, 4, 5, 6].map(weekday => ({weekday, starts_at: '09:00', ends_at: '09:30'}));
        const slots = freeSlots({schedule: {...schedule, booking_window_days: 2}, hours: everyDay, from: '2026-10-01', days: 10, now: early});
        assert.deepEqual(slots.map(s => s.date), ['2026-10-01', '2026-10-02', '2026-10-03']);
    });

    test('skips days off and booked times', () => {
        const hours = [0, 1].map(weekday => ({weekday, starts_at: '09:00', ends_at: '10:00'}));
        const busy = [{starts_at: Date.parse('2026-10-19T06:00:00Z'), ends_at: Date.parse('2026-10-19T06:30:00Z')}];
        const slots = freeSlots({schedule, hours, timeOff: [{starts_on: '2026-10-18', ends_on: '2026-10-18'}], busy, from: '2026-10-18', days: 2, now: early});
        assert.deepEqual(slots.map(s => `${s.date} ${s.time}`), ['2026-10-19 09:30']);
    });
});

describe('checking opening hours', () => {
    test('accepts normal hours', () => assert.equal(hoursProblem([...sundayMorning, {weekday: 0, starts_at: '17:00', ends_at: '20:00'}], 30), null));
    test('rejects overlaps, short ranges, bad times and too many ranges', () => {
        assert.equal(hoursProblem([...sundayMorning, {weekday: 0, starts_at: '10:30', ends_at: '12:00'}], 30), 'overlapping_hours');
        assert.equal(hoursProblem([{weekday: 1, starts_at: '09:00', ends_at: '09:10'}], 30), 'range_too_short');
        assert.equal(hoursProblem([{weekday: 1, starts_at: '9:00', ends_at: '10:00'}], 30), 'invalid_time');
        assert.equal(hoursProblem([{weekday: 7, starts_at: '09:00', ends_at: '10:00'}], 30), 'invalid_weekday');
        const four = ['08:00', '10:00', '12:00', '14:00'].map(t => ({weekday: 3, starts_at: t, ends_at: t.replace(/^(\d\d)/, (_, h) => String(+h + 1).padStart(2, '0'))}));
        assert.equal(hoursProblem(four, 30), 'too_many_ranges');
    });
});
