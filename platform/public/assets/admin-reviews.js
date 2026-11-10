// Admin page: reviews waiting for a check (src/reviews.js), reported ones first. Loaded when the section is opened.
document.addEventListener('DOMContentLoaded', () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Damascus'});
    let reviews = null;

    async function load() {
        const res = await api('/api/admin/reviews?status=pending');
        if (!res.ok) return showError('reviewsError', res.data);
        reviews = res.data.reviews;
        render();
    }

    function render() {
        $('reviewsCount').textContent = reviews.length ? tr(`${reviews.length} reviews to check`, `${reviews.length} تقييمات للمراجعة`) : tr('Nothing to check.', 'لا شيء للمراجعة.');
        $('reviewsList').replaceChildren(...reviews.map(r => {
            const li = el('li', {className: 'appt'});
            if (r.reported_at) li.append(el('span', {className: 'pill wait', textContent: tr('Reported by the doctor', 'أبلغ عنه الطبيب')}));
            li.append(el('h3', {dir: 'auto', textContent: `${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)} · ${r.doctor_name}`}),
                el('p', {className: 'muted-small', dir: 'auto', textContent: `${r.patient_name}${r.author ? ` (${tr('shown as', 'يظهر باسم')} ${r.author})` : ''} · ${tr('appointment', 'موعد')} ${day(r.appointment_at)}`}));
            if (r.comment) li.append(el('p', {dir: 'auto', textContent: r.comment}));
            if (r.report_reason) li.append(el('p', {className: 'appt-reason', dir: 'auto', textContent: tr('Doctor: ', 'الطبيب: ') + r.report_reason}));
            const note = el('input', {type: 'text', maxLength: 300, dir: 'auto'});
            const noteLabel = el('label', {className: 'field'}, el('span', {textContent: tr('Reason (needed to reject)', 'السبب (مطلوب للرفض)')}), note);
            const decide = (action, button) => async () => {
                busy(button, true);
                const res = await api(`/api/admin/reviews/${r.id}/${action}`, note.value.trim() ? {note: note.value} : {});
                busy(button, false);
                if (!res.ok) return showError('reviewsError', res.data);
                await load();
                $('reviewsCount').focus();
            };
            const approve = el('button', {type: 'button', className: 'btn', textContent: tr('Publish', 'نشر')});
            const reject = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Reject', 'رفض')});
            approve.onclick = decide('approve', approve);
            reject.onclick = decide('reject', reject);
            li.append(noteLabel, el('div', {className: 'actions'}, approve, reject));
            return li;
        }));
    }

    $('reviewsBox').addEventListener('toggle', () => { if ($('reviewsBox').open && !reviews) load(); });
    document.addEventListener('shc:language', () => reviews && render());
});
