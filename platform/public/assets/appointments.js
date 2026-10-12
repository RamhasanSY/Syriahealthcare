// My appointments: upcoming and past, with cancelling (after a confirmation step on the card itself).
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus';
    const STATUS = {requested: ['Waiting for the doctor to confirm', 'بانتظار تأكيد الطبيب', 'wait'], confirmed: ['Confirmed', 'مؤكد', 'ok'],
        declined: ['Declined by the doctor', 'اعتذر الطبيب', 'off'], cancelled_by_patient: ['You cancelled', 'ألغيتَ الموعد', 'off'],
        cancelled_by_doctor: ['Cancelled by the doctor', 'ألغاه الطبيب', 'off'], completed: ['Completed', 'تم', 'off'], no_show: ['Missed', 'لم يتم الحضور', 'off']};
    let list = [], catalog = null, confirming = null;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const when = iso => new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ});

    async function load() {
        const res = await api('/api/appointments/mine');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/login?next=/appointments');
        if (res.status === 403) return window.location.assign('/account');
        list = res.data.appointments;
        render();
    }

    function card(a) {
        const li = el('li', {className: 'appt'}), [en, ar, tone] = STATUS[a.status];
        const spec = catalog?.specialties[a.specialty] ? tr(...catalog.specialties[a.specialty]) : '';
        li.append(el('span', {className: 'pill ' + tone, textContent: tr(en, ar)}), el('h3', {textContent: when(a.starts_at)}),
            el('p', {className: 'appt-doctor', textContent: [a.doctor_name, spec].filter(Boolean).join(' · '), dir: 'auto'}),
            el('p', {className: 'muted-small', textContent: [a.clinic_name, a.clinic_address].filter(Boolean).join(' · '), dir: 'auto'}));
        if (a.clinic_phone) {
            const phone = el('a', {href: 'tel:' + a.clinic_phone, textContent: a.clinic_phone, dir: 'ltr'});
            const p = el('p', {className: 'muted-small'});
            p.append(tr('Clinic: ', 'العيادة: '), phone);
            li.append(p);
        }
        if (a.reason) li.append(el('p', {className: 'appt-reason', textContent: tr('Reason: ', 'السبب: ') + a.reason, dir: 'auto'}));
        if (a.status_note) li.append(el('p', {className: 'appt-reason', textContent: tr('Note: ', 'ملاحظة: ') + a.status_note, dir: 'auto'}));
        const upcoming = ['requested', 'confirmed'].includes(a.status) && Date.parse(a.starts_at) > Date.now();
        if (upcoming) {
            if (confirming === a.id) {
                const box = el('div', {className: 'confirm-box'});
                const yes = el('button', {type: 'button', className: 'btn danger', textContent: tr('Yes, cancel it', 'نعم، ألغِ الموعد')});
                const no = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Keep it', 'أبقِه')});
                yes.onclick = async () => {
                    busy(yes, true);
                    const res = await api(`/api/appointments/${a.id}/cancel`, {});
                    busy(yes, false);
                    confirming = null;
                    if (!res.ok) showError('listError', res.data);
                    await load();
                };
                no.onclick = () => { confirming = null; render(); };
                box.append(el('p', {textContent: tr('Cancel this appointment? The time becomes free for other patients.', 'إلغاء هذا الموعد؟ سيصبح الوقت متاحاً لمرضى آخرين.')}), el('div', {className: 'actions'}));
                box.lastChild.append(yes, no);
                li.append(box);
                setTimeout(() => no.focus());
            } else {
                const cancel = el('button', {type: 'button', className: 'link-btn', textContent: tr('Cancel appointment', 'إلغاء الموعد')});
                cancel.onclick = () => { confirming = a.id; render(); };
                li.append(cancel);
            }
        }
        return li;
    }

    function render() {
        const now = Date.now();
        const upcoming = list.filter(a => ['requested', 'confirmed'].includes(a.status) && Date.parse(a.ends_at) > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        const past = list.filter(a => !upcoming.includes(a));
        const empty = text => el('li', {className: 'empty-row', textContent: text});
        $('upcoming').replaceChildren(...(upcoming.length ? upcoming.map(card) : [empty(tr('No upcoming appointments.', 'لا توجد مواعيد قادمة.'))]));
        $('past').replaceChildren(...(past.length ? past.map(card) : [empty(tr('Nothing here yet.', 'لا يوجد شيء بعد.'))]));
    }

    catalog = (await api('/api/catalog')).data;
    document.addEventListener('shc:language', render);
    load();
});
