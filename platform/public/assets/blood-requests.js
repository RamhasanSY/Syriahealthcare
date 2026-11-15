// A blood bank's or hospital's own donation calls (src/blood.js): publish, see who answered, close.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long'});
    const time = iso => new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Damascus'});
    let data = null;
    const donors = new Map();  // call id -> answers, once opened

    async function load() {
        const res = await api('/api/facility/blood-requests');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff?next=/blood-requests');
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        if ($('typeBoxes').childElementCount === 0) {
            $('typeBoxes').append(...data.blood_types.map(t => {
                const box = el('input', {type: 'checkbox', value: t, id: 'type-' + t});
                return el('label', {className: 'chip check-chip', htmlFor: box.id}, box, el('span', {dir: 'ltr', textContent: t}));
            }));
            const today = new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});
            $('neededBy').min = today;
            $('neededBy').max = new Date(Date.parse(today) + data.limits.daysAhead * 86400000).toISOString().slice(0, 10);
            $('phone').placeholder = data.default_phone || '';
        }
        $('newCard').hidden = false;
        render();
    }

    function card(r) {
        const li = el('li', {className: 'appt'});
        const open = r.status === 'open' && r.needed_by >= new Date().toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});
        li.append(el('span', {className: 'pill ' + (open ? (r.urgency === 'urgent' ? 'wait' : 'ok') : 'off'),
            textContent: open ? (r.urgency === 'urgent' ? tr('Open · urgent', 'مفتوح · عاجل') : tr('Open', 'مفتوح')) : tr('Closed', 'مغلق')}),
            el('h3', {dir: 'ltr', textContent: r.blood_types.join(' · ')}),
            el('p', {className: 'muted-small', textContent: [tr(`Needed by ${day(r.needed_by)}`, `مطلوب قبل ${day(r.needed_by)}`), r.units ? tr(`${r.units} units`, `${r.units} وحدة`) : ''].filter(Boolean).join(' · ')}),
            el('p', {className: 'muted-small', textContent: tr(`${r.notified} donors told · ${r.responses} answered`, `أُبلغ ${r.notified} متبرعاً · استجاب ${r.responses}`)}));
        if (r.note) li.append(el('p', {className: 'appt-reason', textContent: r.note, dir: 'auto'}));
        const links = el('div', {className: 'appt-links'});
        if (r.responses) {
            const show = el('button', {type: 'button', className: 'link-btn', textContent: donors.has(r.id) ? tr('Hide donors', 'إخفاء المتبرعين') : tr('Show donors', 'عرض المتبرعين')});
            show.setAttribute('aria-expanded', String(donors.has(r.id)));
            show.onclick = async () => {
                if (donors.has(r.id)) {
                    donors.delete(r.id);
                    return render();
                }
                busy(show, true);
                const res = await api(`/api/facility/blood-requests/${r.id}/responses`);
                busy(show, false);
                if (!res.ok) return showError('pageError', res.data);
                donors.set(r.id, res.data.responses);
                render();
            };
            links.append(show);
        }
        if (r.status === 'open') {
            const close = el('button', {type: 'button', className: 'link-btn', textContent: tr('Close this call', 'إغلاق هذا النداء')});
            close.onclick = async () => {
                busy(close, true);
                const res = await api(`/api/facility/blood-requests/${r.id}/close`, {});
                busy(close, false);
                if (!res.ok) return showError('pageError', res.data);
                await load();
                $('announce').focus();
            };
            links.append(close);
        }
        li.append(links);
        if (donors.has(r.id)) {
            const table = el('table', {className: 'values'});
            table.append(el('caption', {textContent: tr('Donors who can come', 'المتبرعون القادرون على الحضور')}));
            const head = el('tr');
            for (const [en, ar] of [['Name', 'الاسم'], ['Mobile', 'الجوال'], ['Blood group', 'الزمرة'], ['Answered', 'وقت الاستجابة']]) head.append(el('th', {scope: 'col', textContent: tr(en, ar)}));
            table.append(el('thead', {}, head), el('tbody', {}, ...donors.get(r.id).map(d => el('tr', {},
                el('th', {scope: 'row', dir: 'auto', textContent: d.name}), el('td', {}, el('a', {href: 'tel:' + d.phone, dir: 'ltr', textContent: d.phone})),
                el('td', {dir: 'ltr', textContent: d.blood_type}), el('td', {textContent: time(d.created_at)})))));
            li.append(table);
        }
        return li;
    }

    function render() {
        $('announce').textContent = data.requests.length ? tr(`${data.requests.length} calls`, `${data.requests.length} نداءات`) : tr('No calls yet.', 'لا توجد نداءات بعد.');
        $('list').replaceChildren(...data.requests.map(card));
    }

    $('newForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('formError').hidden = true;
        const types = [...$('typeBoxes').querySelectorAll('input:checked')].map(i => i.value);
        if (!types.length) return showError('formError', {error: 'choose_blood_type', message: 'Choose at least one blood group.'});
        busy($('publish'), true);
        const res = await api('/api/facility/blood-requests', {blood_types: types, needed_by: $('neededBy').value, urgency: $('urgency').value,
            units: $('units').value ? Number($('units').value) : null, ...($('phone').value.trim() && {contact_phone: $('phone').value}),
            ...($('note').value.trim() && {note: $('note').value})});
        busy($('publish'), false);
        if (!res.ok) return showError('formError', res.data);
        $('newForm').reset();
        await load();
        $('announce').textContent = tr(`Published. ${res.data.request.notified} donors were told.`, `نُشر النداء. أُبلغ ${res.data.request.notified} متبرعاً.`);
        $('announce').focus();
    });
    document.addEventListener('shc:language', () => data && render());
    load();
});
