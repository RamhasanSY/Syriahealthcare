// Opening hours: appointment settings, weekly time ranges, days off and a preview of free slots.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    // Saturday first, as Syrian calendars usually show the week. weekday: 0 = Sunday … 6 = Saturday.
    const DAYS = [[6, 'Saturday', 'السبت'], [0, 'Sunday', 'الأحد'], [1, 'Monday', 'الاثنين'], [2, 'Tuesday', 'الثلاثاء'],
        [3, 'Wednesday', 'الأربعاء'], [4, 'Thursday', 'الخميس'], [5, 'Friday', 'الجمعة']];
    const SLOT = [10, 15, 20, 30, 45, 60], WINDOW = [7, 14, 30, 60, 90], NOTICE = [0, 1, 2, 4, 12, 24, 48];
    const PROBLEMS_AR = {range_too_short: 'يجب أن تتسع كل فترة لموعد واحد على الأقل.', too_many_ranges: 'حتى 3 فترات في اليوم.',
        overlapping_hours: 'يجب ألا تتداخل فترات اليوم نفسه.', invalid_time: 'أدخل الأوقات بصيغة 09:00.', end_before_start: 'لا يمكن أن يكون اليوم الأخير قبل الأول.',
        in_the_past: 'يجب أن تبدأ الإجازة اليوم أو لاحقاً.', invalid_date: 'أدخل تاريخاً صحيحاً.', too_far: 'يمكن تخطيط الإجازات حتى سنة مقدماً.'};
    let data = null, ranges = {};  // ranges: weekday -> [{starts_at, ends_at}], absent = closed

    const res = await api('/api/doctor/schedule');
    $('main').setAttribute('aria-busy', 'false');
    if (!res.ok) return window.location.assign(res.status === 401 ? '/staff' : '/account');
    data = res.data;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const error = (id, d) => showError(id, Shc.lang === 'ar' && PROBLEMS_AR[d.error] ? {...d, message: PROBLEMS_AR[d.error], error: 'x'} : d);

    function loadRanges() {
        ranges = {};
        for (const h of data.hours) (ranges[h.weekday] ||= []).push({starts_at: h.starts_at, ends_at: h.ends_at});
    }

    function renderSettings() {
        const fill = (select, values, label, current) => {
            select.replaceChildren(...values.map(v => new Option(label(v), v)));
            select.value = String(current);
        };
        // Arabic counted nouns: 1 and 2 have their own forms, 3–10 take the plural, 11+ the singular.
        const count = (n, one, two, few, many) => n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
        fill($('slotMinutes'), SLOT, v => tr(`${v} minutes`, count(v, 'دقيقة واحدة', 'دقيقتان', 'دقائق', 'دقيقة')), $('slotMinutes').value || data.settings.slot_minutes);
        fill($('windowDays'), WINDOW, v => tr(`${v} days ahead`, count(v, 'يوم واحد', 'يومان', 'أيام', 'يوماً')), $('windowDays').value || data.settings.booking_window_days);
        fill($('noticeHours'), NOTICE, v => v === 0 ? tr('No minimum', 'بلا حد أدنى') : v === 1 ? tr('1 hour before', 'ساعة واحدة قبل الموعد') :
            tr(`${v} hours before`, count(v, 'ساعة', 'ساعتان', 'ساعات', 'ساعة') + ' قبل الموعد'), $('noticeHours').value || data.settings.min_notice_hours);
    }

    function renderDays() {
        $('days').replaceChildren(...DAYS.map(([weekday, en, ar]) => {
            const row = el('div', {className: 'day-row'}), open = Boolean(ranges[weekday]?.length);
            const toggle = el('label', {className: 'check day-toggle'});
            const box = el('input', {type: 'checkbox', checked: open});
            box.setAttribute('aria-label', tr(`Open on ${en}`, `دوام يوم ${ar}`));
            box.onchange = () => {
                ranges[weekday] = box.checked ? [{starts_at: '09:00', ends_at: '14:00'}] : [];
                renderDays();
                if (box.checked) $('days').querySelector(`[data-day="${weekday}"] input[type=time]`)?.focus();
            };
            toggle.append(box, el('strong', {textContent: tr(en, ar)}));
            const list = el('div', {className: 'ranges'});
            list.dataset.day = weekday;
            if (!open) list.append(el('span', {className: 'muted-small', textContent: tr('Closed', 'مغلق')}));
            (ranges[weekday] || []).forEach((r, i) => {
                const line = el('div', {className: 'range'});
                const start = el('input', {type: 'time', value: r.starts_at, step: 300});
                const end = el('input', {type: 'time', value: r.ends_at, step: 300});
                start.setAttribute('aria-label', tr(`${en}, period ${i + 1}, from`, `${ar}، الفترة ${i + 1}، من`));
                end.setAttribute('aria-label', tr(`${en}, period ${i + 1}, until`, `${ar}، الفترة ${i + 1}، حتى`));
                start.onchange = () => { r.starts_at = start.value; };
                end.onchange = () => { r.ends_at = end.value; };
                line.append(start, el('span', {textContent: '–', ariaHidden: 'true'}), end);
                const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Remove', 'حذف')});
                remove.setAttribute('aria-label', tr(`Remove ${en} period ${i + 1}`, `حذف فترة ${ar} ${i + 1}`));
                remove.onclick = () => { ranges[weekday].splice(i, 1); renderDays(); };
                line.append(remove);
                list.append(line);
            });
            if (open && ranges[weekday].length < 3) {
                const add = el('button', {type: 'button', className: 'link-btn', textContent: tr('+ Add another time', '+ أضف فترة أخرى')});
                add.onclick = () => {
                    const last = ranges[weekday].at(-1);
                    ranges[weekday].push({starts_at: last.ends_at < '17:00' ? '17:00' : last.ends_at, ends_at: last.ends_at < '17:00' ? '20:00' : '23:00'});
                    renderDays();
                };
                list.append(add);
            }
            row.append(toggle, list);
            return row;
        }));
    }

    function renderTimeOff() {
        const fmt = d => new Date(d + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
        $('offList').replaceChildren(...(data.timeOff.length ? data.timeOff.map(t => {
            const li = el('li'), info = el('span');
            info.append(el('strong', {textContent: t.starts_on === t.ends_on ? fmt(t.starts_on) : `${fmt(t.starts_on)} – ${fmt(t.ends_on)}`}));
            if (t.note) info.append(document.createTextNode(' · ' + t.note));
            const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Remove', 'حذف')});
            remove.onclick = async () => {
                const r = await fetch('/api/doctor/time-off/' + t.id, {method: 'DELETE', credentials: 'same-origin'});
                if (r.ok) {
                    data = await r.json();
                    renderTimeOff();
                    renderPreview();
                }
            };
            li.append(info, remove);
            return li;
        }) : [el('li', {className: 'empty-row', textContent: tr('No days off planned.', 'لا توجد إجازات مخطط لها.')})]));
    }

    async function renderPreview() {
        const p = await api('/api/doctor/slots?days=7');
        if (!p.ok) return;
        const byDate = new Map();
        p.data.slots.forEach(s => byDate.set(s.date, [...(byDate.get(s.date) || []), s]));
        $('previewHint').textContent = tr(`Free ${p.data.slot_minutes}-minute appointments in the next 7 days: ${p.data.slots.length}.`,
            `المواعيد المتاحة (${p.data.slot_minutes} دقيقة) خلال الأيام السبعة القادمة: ${p.data.slots.length}.`);
        if (!byDate.size) {
            $('preview').replaceChildren(el('p', {className: 'empty-row', textContent: tr('No free appointments yet. Add opening hours and save.', 'لا توجد مواعيد متاحة بعد. أضف أوقات الدوام واحفظها.')}));
            return;
        }
        $('preview').replaceChildren(...[...byDate].map(([date, slots]) => {
            const day = el('div', {className: 'preview-day'});
            day.append(el('h3', {textContent: new Date(date + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'})}));
            const chips = el('div', {className: 'chips'});
            slots.forEach(s => chips.append(el('span', {className: 'chip', textContent: s.time})));
            day.append(chips);
            return day;
        }));
    }

    $('copyHours').addEventListener('click', () => {
        const first = DAYS.map(d => d[0]).find(d => ranges[d]?.length);
        if (first === undefined) return;
        for (const [d] of DAYS) if (ranges[d]?.length) ranges[d] = ranges[first].map(r => ({...r}));
        renderDays();
    });

    $('scheduleForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('scheduleError').hidden = true;
        $('scheduleSaved').textContent = '';
        const hours = Object.entries(ranges).flatMap(([weekday, list]) => list.map(r => ({weekday: Number(weekday), ...r})));
        busy($('saveSchedule'), true);
        const r = await api('/api/doctor/schedule', {slot_minutes: Number($('slotMinutes').value), booking_window_days: Number($('windowDays').value),
            min_notice_hours: Number($('noticeHours').value), hours});
        busy($('saveSchedule'), false);
        if (!r.ok) return error('scheduleError', r.data);
        data = r.data;
        loadRanges();
        renderDays();
        renderPreview();
        $('scheduleSaved').textContent = tr('Saved.', 'تم الحفظ.');
    });

    $('offForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('offError').hidden = true;
        if (!$('offFrom').value) return error('offError', {error: 'invalid_date', message: 'Enter a valid date.'});
        busy($('addOff'), true);
        const r = await api('/api/doctor/time-off', {starts_on: $('offFrom').value, ends_on: $('offTo').value || $('offFrom').value, note: $('offNote').value});
        busy($('addOff'), false);
        if (!r.ok) return error('offError', r.data);
        data = r.data;
        $('offForm').reset();
        renderTimeOff();
        renderPreview();
    });
    $('offFrom').addEventListener('change', () => { if (!$('offTo').value || $('offTo').value < $('offFrom').value) $('offTo').value = $('offFrom').value; });

    document.addEventListener('shc:language', () => { renderSettings(); renderDays(); renderTimeOff(); renderPreview(); });
    loadRanges();
    renderSettings();
    renderDays();
    renderTimeOff();
    renderPreview();
});
