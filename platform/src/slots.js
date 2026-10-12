// Free appointment slots from weekly opening hours, days off and existing bookings.
// Pure functions (no database), so the rules are easy to test.

const MINUTE = 60_000, DAY = 86_400_000;

// Offset of a time zone from UTC at a given instant, in milliseconds (handles daylight saving).
function offsetAt(instant, timeZone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(instant).map(p => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(instant / 1000) * 1000;
}

// "2026-10-14" + "10:30" in Asia/Damascus -> UTC milliseconds.
export function localToUtc(date, time, timeZone) {
    const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const first = guess - offsetAt(guess, timeZone);
    return guess - offsetAt(first, timeZone);
}

// Calendar date (YYYY-MM-DD) of an instant in a time zone.
export function localDate(instant, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(instant);
}

export const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const weekdayOf = date => new Date(date + 'T00:00:00Z').getUTCDay();
const minutes = time => {
    const [h, m] = time.split(':').map(Number);
    return h * 60 + m;
};

/**
 * schedule: {timezone, slot_minutes, booking_window_days, min_notice_hours}
 * hours:    [{weekday, starts_at: 'HH:MM', ends_at: 'HH:MM'}]
 * timeOff:  [{starts_on: 'YYYY-MM-DD', ends_on: 'YYYY-MM-DD'}]
 * busy:     [{starts_at: ms, ends_at: ms}]  (booked appointments, step 4)
 * Returns [{date, time, starts_at, ends_at}] with UTC ISO timestamps, from `from` for `days` days.
 */
export function freeSlots({schedule, hours, timeOff = [], busy = [], from, days, now = Date.now()}) {
    const tz = schedule.timezone, length = schedule.slot_minutes;
    const earliest = now + schedule.min_notice_hours * 60 * MINUTE;
    const lastDate = addDays(localDate(now, tz), schedule.booking_window_days);
    const slots = [];
    for (let i = 0; i < days; i++) {
        const date = addDays(from, i);
        if (date > lastDate) break;
        if (timeOff.some(t => date >= t.starts_on && date <= t.ends_on)) continue;
        for (const range of hours.filter(h => h.weekday === weekdayOf(date)).sort((a, b) => a.starts_at.localeCompare(b.starts_at))) {
            for (let m = minutes(range.starts_at); m + length <= minutes(range.ends_at); m += length) {
                const time = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
                const start = localToUtc(date, time, tz), end = start + length * MINUTE;
                if (start < earliest) continue;
                if (busy.some(b => start < b.ends_at && end > b.starts_at)) continue;
                slots.push({date, time, starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString()});
            }
        }
    }
    return slots;
}

// Checks a doctor's weekly hours: valid times, at least one slot long, no overlaps, at most 3 ranges per day.
export function hoursProblem(hours, slotMinutes) {
    const byDay = new Map();
    for (const h of hours) {
        if (!Number.isInteger(h.weekday) || h.weekday < 0 || h.weekday > 6) return 'invalid_weekday';
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(h.starts_at) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(h.ends_at)) return 'invalid_time';
        if (minutes(h.ends_at) - minutes(h.starts_at) < slotMinutes) return 'range_too_short';
        byDay.set(h.weekday, [...(byDay.get(h.weekday) || []), h]);
    }
    for (const ranges of byDay.values()) {
        if (ranges.length > 3) return 'too_many_ranges';
        const sorted = [...ranges].sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        for (let i = 1; i < sorted.length; i++) if (sorted[i].starts_at < sorted[i - 1].ends_at) return 'overlapping_hours';
    }
    return null;
}
