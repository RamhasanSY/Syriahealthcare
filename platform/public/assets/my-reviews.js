// A doctor's reviews (src/reviews.js): read, answer publicly, report.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    let data = null, open = null;  // open: id and kind ('reply' | 'report') of the form shown

    async function load() {
        const res = await api('/api/doctor/reviews');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff?next=/my-reviews');
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        render();
    }

    function form(r, kind) {
        const box = el('form', {className: 'confirm-box', noValidate: true});
        const text = el('textarea', {rows: 3, maxLength: kind === 'reply' ? 500 : 300, dir: 'auto', value: kind === 'reply' ? r.reply || '' : ''});
        const label = el('label', {className: 'field'}, el('span', {textContent: kind === 'reply' ? tr('Your public answer', 'ردك العلني') : tr('Why should our team check it again?', 'لماذا يجب أن يراجعه فريقنا مجدداً؟')}), text);
        const send = el('button', {type: 'submit', className: 'btn', textContent: kind === 'reply' ? tr('Publish answer', 'نشر الرد') : tr('Report', 'إبلاغ')});
        const cancel = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Cancel', 'إلغاء')});
        cancel.onclick = () => { open = null; render(); };
        box.append(label, el('div', {className: 'actions'}, send, cancel));
        box.addEventListener('submit', async event => {
            event.preventDefault();
            busy(send, true);
            const res = kind === 'reply' ? await api(`/api/doctor/reviews/${r.id}/reply`, {reply: text.value}) : await api(`/api/doctor/reviews/${r.id}/report`, {reason: text.value});
            busy(send, false);
            if (!res.ok) return showError('pageError', res.data);
            open = null;
            await load();
            $('summary').focus();
        });
        setTimeout(() => text.focus());
        return box;
    }

    function render() {
        const s = data.summary;
        $('summary').textContent = !s.count ? tr('No reviews yet.', 'لا توجد تقييمات بعد.')
            : s.average !== null ? tr(`${s.average} of 5 from ${s.count} reviews`, `${s.average} من 5 من ${s.count} تقييمات`)
                : tr(`${s.count} reviews (the average shows from 3 reviews on)`, `${s.count} تقييمات (يظهر المتوسط ابتداءً من 3 تقييمات)`);
        $('list').replaceChildren(...data.reviews.map(r => {
            const li = el('li', {className: 'appt'});
            const stars = el('p', {className: 'stars', textContent: '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating)});
            stars.setAttribute('role', 'img');
            stars.setAttribute('aria-label', tr(`${r.rating} of 5 stars`, `${r.rating} من 5 نجوم`));
            li.append(stars, el('p', {className: 'muted-small', textContent: `${r.author || tr('Patient', 'مريض')} · ${day(r.created_at)}`}));
            if (r.comment) li.append(el('p', {dir: 'auto', textContent: r.comment}));
            if (r.reply) li.append(el('p', {className: 'appt-reason', dir: 'auto', textContent: tr('Your answer: ', 'ردك: ') + r.reply}));
            if (open?.id === r.id) {
                li.append(form(r, open.kind));
            } else {
                const links = el('div', {className: 'appt-links'});
                const answer = el('button', {type: 'button', className: 'link-btn', textContent: r.reply ? tr('Change answer', 'تعديل الرد') : tr('Answer', 'رد')});
                answer.onclick = () => { open = {id: r.id, kind: 'reply'}; render(); };
                const report = el('button', {type: 'button', className: 'link-btn', textContent: tr('Report', 'إبلاغ')});
                report.onclick = () => { open = {id: r.id, kind: 'report'}; render(); };
                links.append(answer, report);
                li.append(links);
            }
            return li;
        }));
    }
    document.addEventListener('shc:language', () => data && render());
    load();
});
