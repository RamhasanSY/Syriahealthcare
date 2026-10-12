// Doctor dashboard: requests to confirm or decline, upcoming appointments by day, and the past 60 days.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus';
    const TABS = {requests: ['Requests', 'الطلبات'], upcoming: ['Upcoming', 'القادمة'], past: ['Past', 'السابقة']};
    const STATUS = {requested: ['Not confirmed in time', 'لم يُؤكَّد في الوقت', 'off'], confirmed: ['Confirmed', 'مؤكد', 'ok'], declined: ['Declined', 'مُعتذر عنه', 'off'],
        cancelled_by_patient: ['Cancelled by patient', 'ألغاه المريض', 'off'], cancelled_by_doctor: ['Cancelled by you', 'ألغيتَه', 'off'],
        completed: ['Done', 'تم', 'ok'], no_show: ['Missed', 'لم يحضر', 'wait']};
    let scope = 'requests', data = null, open = null;  // open: {id, action} for an expanded decline/cancel form
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const time = iso => new Date(iso).toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit', timeZone: TZ});
    const day = iso => new Date(iso).toLocaleDateString(locale(), {weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ});
    const dayKey = iso => new Intl.DateTimeFormat('en-CA', {timeZone: TZ}).format(new Date(iso));

    async function load(focusList = false) {
        const res = await api('/api/doctor/appointments?scope=' + scope);
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff');
        if (res.status === 403) return window.location.assign('/account');
        const before = data?.counts.requests;
        data = res.data;
        render();
        if (before !== undefined && data.counts.requests > before) $('announce').textContent = tr('New appointment request.', 'طلب موعد جديد.');
        if (focusList) $('list').querySelector('button')?.focus();
    }

    async function act(a, action, button, note) {
        $('actionError').hidden = true;
        busy(button, true);
        const res = await api(`/api/doctor/appointments/${a.id}/${action}`, note === undefined ? {} : {note});
        busy(button, false);
        if (!res.ok) return showError('actionError', res.data);
        open = null;
        const done = {confirm: ['Confirmed. The patient gets an SMS.', 'تم التأكيد. سيتلقى المريض رسالة.'], decline: ['Declined. The patient gets an SMS.', 'تم الاعتذار. سيتلقى المريض رسالة.'],
            cancel: ['Cancelled. The patient gets an SMS.', 'تم الإلغاء. سيتلقى المريض رسالة.'], complete: ['Marked as done.', 'سُجّل كمنجز.'], 'no-show': ['Marked as missed.', 'سُجّل كغياب.']}[action];
        $('announce').textContent = tr(...done);
        await load(true);
    }

    function noteForm(a, action) {
        const required = action === 'cancel', box = el('div', {className: 'confirm-box'});
        const label = el('label', {className: 'field'});
        const area = el('textarea', {maxLength: 300, rows: 2, dir: 'auto'});
        label.append(el('span', {textContent: required ? tr('Reason for the patient (required, sent by SMS)', 'السبب للمريض (إلزامي، يُرسل برسالة)')
            : tr('Message for the patient (optional)', 'رسالة للمريض (اختيارية)')}), area);
        const yes = el('button', {type: 'button', className: 'btn danger', textContent: required ? tr('Cancel appointment', 'إلغاء الموعد') : tr('Decline request', 'الاعتذار عن الطلب')});
        const no = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Back', 'رجوع')});
        yes.onclick = () => act(a, action, yes, area.value.trim() || undefined);
        no.onclick = () => { open = null; render(); };
        const row = el('div', {className: 'actions'});
        row.append(yes, no);
        box.append(label, row);
        setTimeout(() => area.focus());
        return box;
    }

    function card(a) {
        const li = el('li', {className: 'appt'}), started = Date.parse(a.starts_at) <= Date.now();
        const head = el('div', {className: 'appt-head'});
        head.append(el('strong', {className: 'appt-time', textContent: `${time(a.starts_at)} – ${time(a.ends_at)}`}));
        if (scope !== 'upcoming' || started) head.append(el('span', {className: 'muted-small', textContent: day(a.starts_at)}));
        if (scope === 'past') head.append(el('span', {className: 'pill ' + STATUS[a.status][2], textContent: tr(...STATUS[a.status])}));
        li.append(head, el('p', {className: 'appt-doctor', textContent: a.patient_name, dir: 'auto'}));
        const phone = el('p', {className: 'muted-small'});
        phone.append(el('a', {href: 'tel:' + a.patient_phone, textContent: a.patient_phone, dir: 'ltr'}));
        li.append(phone);
        if (a.reason) li.append(el('p', {className: 'appt-reason', textContent: tr('Reason: ', 'السبب: ') + a.reason, dir: 'auto'}));
        if (a.status_note && scope === 'past') li.append(el('p', {className: 'appt-reason', textContent: tr('Note: ', 'ملاحظة: ') + a.status_note, dir: 'auto'}));
        const buttons = el('div', {className: 'actions'});
        const add = (action, text, cls = 'btn') => {
            const b = el('button', {type: 'button', className: cls, textContent: text});
            b.setAttribute('aria-label', `${text}: ${a.patient_name}, ${day(a.starts_at)} ${time(a.starts_at)}`);
            b.onclick = ['decline', 'cancel'].includes(action) ? () => { open = {id: a.id, action}; render(); } : () => act(a, action, b);
            buttons.append(b);
        };
        if (open?.id === a.id) li.append(noteForm(a, open.action));
        else if (scope === 'requests') { add('confirm', tr('Confirm', 'تأكيد')); add('decline', tr('Decline', 'اعتذار'), 'btn danger'); }
        else if (scope === 'upcoming' && !started) add('cancel', tr('Cancel…', 'إلغاء…'), 'btn danger');
        else if (scope === 'upcoming' && started) { add('complete', tr('Done', 'تم')); add('no-show', tr('Patient did not come', 'لم يحضر المريض'), 'btn ghost'); }
        if (buttons.children.length) li.append(buttons);
        return li;
    }

    function render() {
        document.querySelectorAll('#tabs button').forEach(b => {
            const n = b.dataset.scope === 'past' ? '' : ` (${data?.counts[b.dataset.scope] ?? 0})`;
            b.textContent = tr(...TABS[b.dataset.scope]) + n;
            b.setAttribute('aria-selected', String(b.dataset.scope === scope));
        });
        if (!data) return;
        const items = data.appointments;
        if (!items.length) {
            const empty = {requests: ['No new requests. You will see them here as soon as patients book.', 'لا توجد طلبات جديدة. ستظهر هنا فور حجز المرضى.'],
                upcoming: ['No confirmed appointments coming up.', 'لا توجد مواعيد مؤكدة قادمة.'], past: ['Nothing in the last 60 days.', 'لا شيء خلال آخر 60 يوماً.']}[scope];
            $('list').replaceChildren(el('p', {className: 'empty-row', textContent: tr(...empty)}));
            return;
        }
        if (scope !== 'upcoming') {
            const ul = el('ul', {className: 'appt-list'});
            ul.append(...items.map(card));
            $('list').replaceChildren(ul);
            return;
        }
        // Upcoming: grouped by day, today first.
        const groups = new Map(), today = dayKey(new Date().toISOString());
        items.forEach(a => groups.set(dayKey(a.starts_at), [...(groups.get(dayKey(a.starts_at)) || []), a]));
        $('list').replaceChildren(...[...groups].map(([key, list]) => {
            const section = el('section', {className: 'day-group'});
            section.append(el('h2', {textContent: (key === today ? tr('Today · ', 'اليوم · ') : '') + day(list[0].starts_at) + ` (${list.length})`}));
            const ul = el('ul', {className: 'appt-list'});
            ul.append(...list.map(card));
            section.append(ul);
            return section;
        }));
    }

    document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => { scope = b.dataset.scope; open = null; load(); }));
    document.addEventListener('shc:language', render);
    // Check for new requests every minute, but never while the doctor is typing a reason.
    setInterval(() => { if (!open && document.visibilityState === 'visible') load(); }, 60_000);
    render();
    load();
});
