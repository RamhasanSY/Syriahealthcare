// My medicines (src/medications.js): today's doses to tick, the list, and adding or changing a medicine.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus';
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const hour = iso => new Date(iso).toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit', timeZone: TZ});
    const WEEKDAYS = [['Sun', 'الأحد'], ['Mon', 'الإثنين'], ['Tue', 'الثلاثاء'], ['Wed', 'الأربعاء'], ['Thu', 'الخميس'], ['Fri', 'الجمعة'], ['Sat', 'السبت']];
    let data = null, profileId = null, editing = null;

    async function load() {
        const res = await api('/api/medications');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/login?next=/medications');
        if (res.status === 404) return showError('pageError', {error: 'not_found', message: 'This is not available yet.'});
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        if (!profileId || !data.profiles.some(p => p.id === profileId)) profileId = data.profiles[0]?.id || null;
        render();
    }
    const profile = () => data.profiles.find(p => p.id === profileId);

    function render() {
        const p = profile();
        $('whoBox').hidden = data.profiles.length < 2;
        $('who').replaceChildren(...data.profiles.map(x => {
            const radio = el('input', {type: 'radio', name: 'who', value: x.id, id: 'who-' + x.id, checked: x.id === profileId});
            radio.addEventListener('change', () => { profileId = x.id; stopEdit(); render(); });
            return el('label', {className: 'check', htmlFor: radio.id}, radio, el('bdi', {textContent: x.relationship === 'self' ? tr('Me', 'أنا') : x.name}));
        }));
        $('noConsent').hidden = !p || p.consent;
        $('formCard').hidden = !p || !p.consent;
        if (!p) return;
        $('today').replaceChildren(...(p.today.length ? p.today.map(d => {
            const done = el('button', {type: 'button', className: d.taken ? 'btn ghost' : 'btn', textContent: d.taken ? tr('Taken ✓', 'أُخذ ✓') : tr('Mark as taken', 'سجّل الأخذ')});
            done.setAttribute('aria-pressed', String(d.taken));
            done.onclick = async () => {
                busy(done, true);
                const res = await api(`/api/medications/${d.medication_id}/dose`, {scheduled_for: d.scheduled_for, taken: !d.taken});
                busy(done, false);
                if (!res.ok) return showError('pageError', res.data);
                d.taken = res.data.taken;
                render();
            };
            return el('li', {className: 'appt'}, el('h3', {textContent: hour(d.scheduled_for)}),
                el('p', {className: 'appt-doctor', dir: 'auto', textContent: [d.name, d.dose].filter(Boolean).join(' · ')}), done);
        }) : [el('li', {className: 'empty-row', textContent: tr('Nothing to take today.', 'لا أدوية اليوم.')})]));
        $('list').replaceChildren(...(p.medications.length ? p.medications.map(m => {
            const days = m.weekdays.length ? m.weekdays.map(i => tr(...WEEKDAYS[i])).join('، ') : tr('every day', 'كل يوم');
            const li = el('li', {className: 'appt'},
                el('span', {className: 'pill ' + (m.active ? 'ok' : 'off'), textContent: m.active ? tr('Reminders on', 'التذكير مفعّل') : tr('Paused', 'متوقف')}),
                el('h3', {dir: 'auto', textContent: [m.name, m.dose].filter(Boolean).join(' · ')}),
                el('p', {className: 'muted-small', dir: 'ltr', textContent: m.times.join(' · ')}),
                el('p', {className: 'muted-small', textContent: days + (m.end_date ? tr(` · until ${m.end_date}`, ` · حتى ${m.end_date}`) : '')}));
            if (m.notes) li.append(el('p', {className: 'appt-reason', dir: 'auto', textContent: m.notes}));
            const links = el('div', {className: 'appt-links'});
            const change = el('button', {type: 'button', className: 'link-btn', textContent: tr('Change', 'تعديل')});
            change.onclick = () => startEdit(m);
            const pause = el('button', {type: 'button', className: 'link-btn', textContent: m.active ? tr('Pause reminders', 'إيقاف التذكير') : tr('Resume reminders', 'استئناف التذكير')});
            pause.onclick = async () => {
                busy(pause, true);
                const res = await api(`/api/medications/${m.id}`, {active: !m.active});
                busy(pause, false);
                if (!res.ok) return showError('pageError', res.data);
                await load();
            };
            const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Delete', 'حذف')});
            remove.onclick = async () => {
                busy(remove, true);
                const res = await api(`/api/medications/${m.id}/delete`, {});
                busy(remove, false);
                if (!res.ok) return showError('pageError', res.data);
                await load();
                $('todayHeading').focus();
            };
            links.append(change, pause, remove);
            li.append(links);
            return li;
        }) : [el('li', {className: 'empty-row', textContent: tr('No medicines yet.', 'لا توجد أدوية بعد.')})]));
        renderDays();
    }

    // Times: one time field per dose, up to the limit.
    function addTime(value = '08:00') {
        if ($('times').childElementCount >= (data?.limits.timesPerDay || 6)) return;
        const input = el('input', {type: 'time', value, required: true});
        input.setAttribute('aria-label', tr('Time', 'الوقت'));
        const remove = el('button', {type: 'button', className: 'link-btn', textContent: '×'});
        remove.setAttribute('aria-label', tr('Remove this time', 'احذف هذا الوقت'));
        const box = el('span', {className: 'time-row'}, input, remove);
        remove.onclick = () => { if ($('times').childElementCount > 1) box.remove(); };
        $('times').append(box);
    }
    function renderDays() {
        const ticked = new Set([...$('days').querySelectorAll('input:checked')].map(i => Number(i.value)));
        $('days').replaceChildren(...WEEKDAYS.map((names, i) => {
            const box = el('input', {type: 'checkbox', value: String(i), id: 'day-' + i, checked: ticked.has(i)});
            return el('label', {className: 'chip check-chip', htmlFor: box.id}, box, el('span', {textContent: tr(...names)}));
        }));
    }
    function setDays(list) {
        renderDays();
        $('days').querySelectorAll('input').forEach(i => { i.checked = list.includes(Number(i.value)); });
    }
    function startEdit(m) {
        editing = m;
        $('formTitle').dataset.en = 'Change medicine';
        $('formTitle').dataset.ar = 'تعديل الدواء';
        $('formTitle').textContent = tr('Change medicine', 'تعديل الدواء');
        $('name').value = m.name;
        $('dose').value = m.dose || '';
        $('times').replaceChildren();
        m.times.forEach(t => addTime(t));
        setDays(m.weekdays);
        $('start').value = m.start_date;
        $('end').value = m.end_date || '';
        $('notes').value = m.notes || '';
        $('showName').checked = m.show_name;
        $('cancelEdit').hidden = false;
        $('formTitle').focus();
    }
    function stopEdit() {
        editing = null;
        $('form').reset();
        $('formTitle').dataset.en = 'Add a medicine';
        $('formTitle').dataset.ar = 'أضف دواءً';
        $('formTitle').textContent = tr('Add a medicine', 'أضف دواءً');
        $('times').replaceChildren();
        addTime();
        setDays([]);
        $('start').value = new Date().toLocaleDateString('en-CA', {timeZone: TZ});
        $('cancelEdit').hidden = true;
    }
    $('addTime').addEventListener('click', () => { addTime('20:00'); $('times').lastElementChild.querySelector('input').focus(); });
    $('cancelEdit').addEventListener('click', stopEdit);
    $('form').addEventListener('submit', async event => {
        event.preventDefault();
        $('formError').hidden = true;
        busy($('save'), true);
        const body = {name: $('name').value, dose: $('dose').value || null,
            times: [...$('times').querySelectorAll('input')].map(i => i.value).filter(Boolean),
            weekdays: [...$('days').querySelectorAll('input:checked')].map(i => Number(i.value)),
            start_date: $('start').value || null, end_date: $('end').value || null, notes: $('notes').value || null, show_name: $('showName').checked};
        const res = await api(editing ? `/api/medications/${editing.id}` : '/api/medications', editing ? body : {...body, profile_id: profileId});
        busy($('save'), false);
        if (!res.ok) return showError('formError', res.data);
        stopEdit();
        await load();
        $('todayHeading').focus();
    });

    // Reminders need notifications on this device.
    const push = await Shc.pushState();
    $('pushHint').hidden = push === 'on' || push === 'unavailable';
    document.addEventListener('shc:language', () => data && render());
    stopEdit();
    await load();
});
