// My appointments: upcoming and past, with cancelling (after a confirmation step on the card itself).
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus';
    const STATUS = {requested: ['Waiting for the doctor to confirm', 'بانتظار تأكيد الطبيب', 'wait'], confirmed: ['Confirmed', 'مؤكد', 'ok'],
        declined: ['Declined by the doctor', 'اعتذر الطبيب', 'off'], cancelled_by_patient: ['You cancelled', 'ألغيتَ الموعد', 'off'],
        cancelled_by_doctor: ['Cancelled by the doctor', 'ألغاه الطبيب', 'off'], completed: ['Completed', 'تم', 'off'], no_show: ['Missed', 'لم يتم الحضور', 'off']};
    let list = [], catalog = null, confirming = null, reviewed = new Map(), reviewDays = 60, rating = null;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const when = iso => new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ});

    async function load() {
        const res = await api('/api/appointments/mine');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/login?next=/appointments');
        if (res.status === 403) return window.location.assign('/account');
        list = res.data.appointments;
        const mine = await api('/api/reviews/mine');
        if (mine.ok) {
            reviewed = new Map(mine.data.reviews.map(r => [r.appointment_id, r.status]));
            reviewDays = mine.data.days;
        }
        render();
    }

    function card(a) {
        const expired = a.status === 'requested' && Date.parse(a.starts_at) <= Date.now();
        const li = el('li', {className: 'appt'}), [en, ar, tone] = expired ? ['Not confirmed in time', 'لم يؤكده الطبيب في الوقت', 'off'] : STATUS[a.status];
        const spec = catalog?.specialties[a.specialty] ? tr(...catalog.specialties[a.specialty]) : '';
        li.append(el('span', {className: 'pill ' + tone, textContent: tr(en, ar)}), el('h3', {textContent: when(a.starts_at)}),
            el('p', {className: 'appt-doctor', textContent: [a.doctor_name, spec].filter(Boolean).join(' · '), dir: 'auto'}),
            el('p', {className: 'muted-small', textContent: [a.clinic_name, a.clinic_address].filter(Boolean).join(' · '), dir: 'auto'}));
        if (a.mode === 'video') {
            li.append(el('p', {className: 'muted-small', textContent: tr('Video call', 'مكالمة فيديو')}));
            if (a.status === 'confirmed' && Date.parse(a.ends_at) + 2 * 3600_000 > Date.now()) {
                li.append(el('a', {className: 'btn', href: `/video?id=${encodeURIComponent(a.id)}`, textContent: tr('Join the video call', 'انضم إلى مكالمة الفيديو')}));
            }
        }
        if (a.clinic_phone) {
            const phone = el('a', {href: 'tel:' + a.clinic_phone, textContent: a.clinic_phone, dir: 'ltr'});
            const p = el('p', {className: 'muted-small'});
            p.append(tr('Clinic: ', 'العيادة: '), phone);
            li.append(p);
        }
        if (a.reason) li.append(el('p', {className: 'appt-reason', textContent: tr('Reason: ', 'السبب: ') + a.reason, dir: 'auto'}));
        if (a.status_note) li.append(el('p', {className: 'appt-reason', textContent: tr('Note: ', 'ملاحظة: ') + a.status_note, dir: 'auto'}));
        const upcoming = ['requested', 'confirmed'].includes(a.status) && Date.parse(a.starts_at) > Date.now();
        // Reviews (src/reviews.js): a completed visit of the last 60 days, once.
        if (a.status === 'completed' && reviewed.has(a.id)) {
            li.append(el('p', {className: 'muted-small', textContent: reviewed.get(a.id) === 'approved' ? tr('Your review is published. Thank you.', 'نُشر تقييمك. شكراً لك.')
                : reviewed.get(a.id) === 'rejected' ? tr('Your review was not published.', 'لم يُنشر تقييمك.') : tr('Your review is waiting for a check.', 'تقييمك بانتظار المراجعة.')}));
        } else if (a.status === 'completed' && Date.parse(a.ends_at) > Date.now() - reviewDays * 86400000) {
            if (rating?.id === a.id) li.append(reviewForm(a));
            else {
                const rate = el('button', {type: 'button', className: 'link-btn', textContent: tr('Review this visit', 'قيّم هذه الزيارة')});
                rate.onclick = () => { rating = {id: a.id}; render(); };
                li.append(rate);
            }
        }
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
                const links = el('div', {className: 'appt-links'});
                links.append(el('a', {className: 'link-btn', href: `/api/appointments/${a.id}/calendar.ics`, download: 'syriahc-appointment.ics',
                    textContent: tr('Add to calendar', 'أضف إلى التقويم')}));
                if ((a.reschedule_count || 0) < 3) {
                    links.append(el('a', {className: 'link-btn', href: `/book?doctor=${encodeURIComponent(a.doctor_id)}&move=${encodeURIComponent(a.id)}`,
                        textContent: tr('Move to another time', 'نقل إلى وقت آخر')}));
                }
                const cancel = el('button', {type: 'button', className: 'link-btn', textContent: tr('Cancel appointment', 'إلغاء الموعد')});
                cancel.onclick = () => { confirming = a.id; render(); };
                links.append(cancel);
                li.append(links);
            }
        }
        return li;
    }

    function reviewForm(a) {
        const form = el('form', {className: 'confirm-box', noValidate: true});
        const stars = el('fieldset', {className: 'plain'}, el('legend', {textContent: tr('How was the visit?', 'كيف كانت الزيارة؟')}));
        const row = el('div', {className: 'chips'});
        for (let n = 5; n >= 1; n--) {
            const input = el('input', {type: 'radio', name: 'stars-' + a.id, value: String(n), id: `stars-${a.id}-${n}`});
            row.append(el('label', {className: 'chip check-chip', htmlFor: input.id}, input, el('span', {textContent: '★'.repeat(n) + ' ' + tr(`${n} of 5`, `${n} من 5`)})));
        }
        stars.append(row);
        const comment = el('textarea', {rows: 3, maxLength: 500, dir: 'auto'});
        const commentLabel = el('label', {className: 'field'}, el('span', {textContent: tr('What should other patients know? (optional)', 'ما الذي يجب أن يعرفه المرضى الآخرون؟ (اختياري)')}), comment,
            el('small', {textContent: tr('Do not write names, phone numbers or details about your health.', 'لا تكتب أسماء أو أرقام هواتف أو تفاصيل عن صحتك.')}));
        const showName = el('input', {type: 'checkbox', id: 'show-' + a.id});
        const nameLabel = el('label', {className: 'check', htmlFor: showName.id}, showName, el('span', {textContent: tr('Show my first name and initial (otherwise "Patient")', 'أظهر اسمي الأول والحرف الأول من الكنية (وإلا «مريض»)')}));
        const send = el('button', {type: 'submit', className: 'btn', textContent: tr('Send review', 'أرسل التقييم')});
        const cancel = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Cancel', 'إلغاء')});
        cancel.onclick = () => { rating = null; render(); };
        form.append(stars, commentLabel, nameLabel, el('div', {className: 'actions'}, send, cancel));
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const value = Number(form.querySelector(`input[name="stars-${a.id}"]:checked`)?.value || 0);
            if (!value) return showError('listError', {error: 'invalid_request', message: 'Choose 1 to 5 stars.'});
            busy(send, true);
            const res = await api(`/api/appointments/${a.id}/review`, {rating: value, ...(comment.value.trim() && {comment: comment.value}), show_name: showName.checked});
            busy(send, false);
            if (!res.ok) return showError('listError', res.data);
            rating = null;
            reviewed.set(a.id, 'pending');
            render();
        });
        setTimeout(() => row.querySelector('input').focus());
        return form;
    }

    function render() {
        const now = Date.now();
        const upcoming = list.filter(a => ['requested', 'confirmed'].includes(a.status) && Date.parse(a.ends_at) > now).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
        const past = list.filter(a => !upcoming.includes(a));
        const empty = text => el('li', {className: 'empty-row', textContent: text});
        $('upcoming').replaceChildren(...(upcoming.length ? upcoming.map(card) : [empty(tr('No upcoming appointments.', 'لا توجد مواعيد قادمة.'))]));
        $('past').replaceChildren(...(past.length ? past.map(card) : [empty(tr('Nothing here yet.', 'لا يوجد شيء بعد.'))]));
    }

    // Waiting lists: doctors this patient wants to hear from when a time becomes free.
    let waiting = [];
    async function loadWaiting() {
        const res = await api('/api/waitlist/mine');
        waiting = res.ok ? res.data.entries : [];
        renderWaiting();
    }
    function renderWaiting() {
        $('waitBox').hidden = !waiting.length;
        const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', timeZone: TZ});
        $('waitList').replaceChildren(...waiting.map(w => {
            const li = el('li', {className: 'appt'});
            const spec = catalog?.specialties[w.specialty] ? tr(...catalog.specialties[w.specialty]) : '';
            li.append(el('p', {className: 'appt-doctor', textContent: [w.doctor_name, spec].filter(Boolean).join(' · '), dir: 'auto'}),
                el('p', {className: 'muted-small', textContent: tr(`We tell you when a time becomes free, until ${date(w.expires_at)}.`, `نخبرك عند توفر وقت حتى ${date(w.expires_at)}.`)}));
            const links = el('div', {className: 'appt-links'});
            links.append(el('a', {className: 'link-btn', href: `/book?doctor=${encodeURIComponent(w.doctor_id)}`, textContent: tr('See free times', 'عرض الأوقات المتاحة')}));
            const leave = el('button', {type: 'button', className: 'link-btn', textContent: tr('Remove', 'إزالة')});
            leave.onclick = async () => {
                busy(leave, true);
                const res = await api(`/api/waitlist/${w.id}/leave`, {});
                busy(leave, false);
                if (!res.ok) return showError('listError', res.data);
                await loadWaiting();
                $('waitHeading').focus();
            };
            links.append(leave);
            li.append(links);
            return li;
        }));
    }

    catalog = (await api('/api/catalog')).data;
    document.addEventListener('shc:language', () => { render(); renderWaiting(); });
    load();
    loadWaiting();
});
