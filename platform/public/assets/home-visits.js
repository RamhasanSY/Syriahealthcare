// The lab's home sample collection requests: new requests, confirmed visits and the past, with the decisions.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long'});
    const STATUS = {requested: ['New request', 'طلب جديد', 'wait'], confirmed: ['Confirmed', 'مؤكد', 'ok'], declined: ['Declined', 'معتذر عنه', 'off'],
        cancelled_by_patient: ['Cancelled by the patient', 'ألغاه المريض', 'off'], cancelled_by_lab: ['Cancelled by you', 'ألغيتموه', 'off'], done: ['Done', 'تم', 'off']};
    let scope = 'open', data = null, ticket = 0;

    async function load() {
        const t = ++ticket;
        const res = await api('/api/lab/home-visits?scope=' + scope);
        if (t !== ticket) return;
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff?next=/home-visits');
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        $('tabs').hidden = false;
        $('notOffered').hidden = data.offers_home_collection;
        render();
    }

    function act(visit, action, button, body = {}) {
        return async () => {
            busy(button, true);
            const res = await api(`/api/lab/home-visits/${visit.id}/${action}`, body);
            busy(button, false);
            if (!res.ok) return showError('pageError', res.data);
            await load();
            $('announce').focus();
        };
    }

    function card(v) {
        const [en, ar, tone] = STATUS[v.status];
        const li = el('li', {className: 'appt'});
        li.append(el('span', {className: 'pill ' + tone, textContent: tr(en, ar)}),
            el('h3', {textContent: `${day(v.visit_date)} · ${tr(...data.windows[v.time_window])}${v.arrival_time ? ' · ' + v.arrival_time : ''}`}),
            el('p', {className: 'appt-doctor'}, el('bdi', {textContent: v.subject_name && v.subject_name !== v.patient_name ? `${v.subject_name} (${tr('booked by', 'بطلب من')} ${v.patient_name})` : v.patient_name})),
            el('p', {className: 'muted-small'}, el('a', {href: 'tel:' + v.phone, textContent: v.phone, dir: 'ltr'})),
            el('p', {dir: 'auto', textContent: v.address}));
        if (v.tests) li.append(el('p', {className: 'appt-reason', dir: 'auto', textContent: tr('Tests: ', 'التحاليل: ') + v.tests}));
        if (v.lab_note) li.append(el('p', {className: 'muted-small', dir: 'auto', textContent: tr('Your note: ', 'ملاحظتكم: ') + v.lab_note}));
        const actions = el('div', {className: 'actions'});
        const note = el('input', {type: 'text', maxLength: 300, dir: 'auto'});
        const noteField = el('label', {className: 'field'}, el('span', {textContent: tr('Note for the patient (needed to decline or cancel)', 'ملاحظة للمريض (ضرورية عند الاعتذار أو الإلغاء)')}), note);
        if (v.status === 'requested') {
            const time = el('input', {type: 'time', dir: 'ltr'});
            const timeField = el('label', {className: 'field'}, el('span', {textContent: tr('Arrival time (optional)', 'موعد الوصول (اختياري)')}), time);
            const confirm = el('button', {type: 'button', className: 'btn', textContent: tr('Confirm', 'تأكيد')});
            confirm.addEventListener('click', () => act(v, 'confirm', confirm, {...(time.value && {arrival_time: time.value}), ...(note.value.trim() && {note: note.value.trim()})})());
            const decline = el('button', {type: 'button', className: 'btn danger', textContent: tr('Decline', 'اعتذار')});
            decline.addEventListener('click', () => act(v, 'decline', decline, {note: note.value})());
            li.append(timeField, noteField);
            actions.append(confirm, decline);
        } else if (v.status === 'confirmed') {
            const done = el('button', {type: 'button', className: 'btn', textContent: tr('Samples taken', 'تم سحب العينات')});
            done.addEventListener('click', () => act(v, 'done', done)());
            const cancel = el('button', {type: 'button', className: 'btn danger', textContent: tr('Cancel visit', 'إلغاء الزيارة')});
            cancel.addEventListener('click', () => act(v, 'cancel', cancel, {note: note.value})());
            li.append(noteField);
            actions.append(done, cancel);
        }
        if (actions.childNodes.length) li.append(actions);
        return li;
    }

    function render() {
        for (const [key, en, ar] of [['open', 'New requests', 'طلبات جديدة'], ['upcoming', 'Confirmed', 'مؤكدة'], ['past', 'Past', 'سابقة']]) {
            const n = data.counts[key];
            const tab = $('tab-' + key);
            tab.textContent = tr(en, ar) + (n ? ` (${n})` : '');
            tab.setAttribute('aria-selected', String(key === scope));
            tab.classList.toggle('active', key === scope);
        }
        $('announce').textContent = tr(`${data.visits.length} visits`, `${data.visits.length} زيارة`);
        $('list').replaceChildren(...(data.visits.length ? data.visits.map(card)
            : [el('li', {className: 'empty-row', textContent: tr('Nothing here.', 'لا يوجد شيء هنا.')})]));
    }

    document.querySelectorAll('#tabs [role="tab"]').forEach(tab => tab.addEventListener('click', () => { scope = tab.dataset.scope; load(); }));
    document.addEventListener('shc:language', () => data && render());
    await load();
});
