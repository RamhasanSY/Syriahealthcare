// "My appointments" page: the patient's home sample collection requests, with cancelling.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long'});
    const STATUS = {requested: ['Waiting for the lab to confirm', 'بانتظار تأكيد المخبر', 'wait'], confirmed: ['Confirmed', 'مؤكد', 'ok'],
        declined: ['The lab cannot come', 'اعتذر المخبر', 'off'], cancelled_by_patient: ['You cancelled', 'ألغيتَ الطلب', 'off'],
        cancelled_by_lab: ['Cancelled by the lab', 'ألغاه المخبر', 'off'], done: ['Samples taken', 'تم سحب العينات', 'off']};
    let data = null;

    async function load() {
        const res = await api('/api/home-visits/mine');
        if (!res.ok) return;  // not a patient, or not signed in: appointments.js handles that
        data = res.data;
        $('visitsBox').hidden = !data.visits.length;
        render();
    }

    function render() {
        if (!data) return;
        const today = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});
        $('visitsList').replaceChildren(...data.visits.map(v => {
            const [en, ar, tone] = STATUS[v.status];
            const li = el('li', {className: 'appt'});
            li.append(el('span', {className: 'pill ' + tone, textContent: tr(en, ar)}),
                el('h3', {textContent: `${day(v.visit_date)} · ${tr(...data.windows[v.time_window])}${v.arrival_time ? ' · ' + tr('arrives', 'الوصول') + ' ' + v.arrival_time : ''}`}),
                el('p', {className: 'appt-doctor'}, el('bdi', {textContent: v.lab_name})));
            if (v.subject_name && v.subject_name !== v.patient_name) li.append(el('p', {className: 'muted-small', textContent: tr('For ', 'لـ ') + v.subject_name, dir: 'auto'}));
            if (v.lab_phone) li.append(el('p', {className: 'muted-small'}, el('a', {href: 'tel:' + v.lab_phone, textContent: v.lab_phone, dir: 'ltr'})));
            if (v.lab_note) li.append(el('p', {className: 'appt-reason', textContent: v.lab_note, dir: 'auto'}));
            if (['requested', 'confirmed'].includes(v.status) && v.visit_date >= today) {
                const cancel = el('button', {type: 'button', className: 'btn danger', textContent: tr('Cancel this visit', 'ألغِ هذه الزيارة')});
                cancel.setAttribute('aria-label', `${tr('Cancel this visit', 'ألغِ هذه الزيارة')}: ${v.lab_name}, ${day(v.visit_date)}`);
                cancel.addEventListener('click', async () => {
                    if (!window.confirm(tr('Cancel this home visit?', 'إلغاء هذه الزيارة المنزلية؟'))) return;
                    busy(cancel, true);
                    const res = await api(`/api/home-visits/${v.id}/cancel`, {});
                    busy(cancel, false);
                    if (!res.ok) return showError('visitsError', res.data);
                    await load();
                    $('visitsHeading').focus();
                });
                li.append(el('div', {className: 'actions'}, cancel));
            }
            return li;
        }));
    }

    document.addEventListener('shc:language', render);
    await load();
});
