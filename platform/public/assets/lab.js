// Public lab page: the lab's tests with prices and time to result, and (for labs that offer it) a request for sample
// collection at home. Prices come from the lab itself; the page asks patients to confirm them with the lab.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const id = new URLSearchParams(window.location.search).get('id') || '';
    const day = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    const price = n => n === null || n === undefined ? tr('Ask the lab', 'اسأل المخبر')
        : new Intl.NumberFormat(Shc.lang === 'ar' ? 'ar-SY' : 'en-GB').format(n) + ' ' + tr('SYP', 'ل.س');
    // Under two days in hours, from then on in days, with the Arabic number forms (يومان، 3–10 أيام، 11+ يوماً).
    const daysAr = n => n === 2 ? 'يومان' : n <= 10 ? `${n} أيام` : `${n} يوماً`;
    const hours = h => h === null || h === undefined ? '—' : h < 48 ? tr(`${h} h`, `${h} ساعة`) : tr(`${Math.round(h / 24)} days`, daysAr(Math.round(h / 24)));
    const isoDay = offset => new Date(Date.now() + offset * 86400000).toLocaleDateString('en-CA', {timeZone: 'Asia/Damascus'});

    let data = null, catalog = null, me = null, profiles = [], chosen = new Set(), subject = null;

    const [res, cat, who] = await Promise.all([api('/api/labs/' + encodeURIComponent(id)), api('/api/catalog'), api('/api/me')]);
    $('main').setAttribute('aria-busy', 'false');
    if (!res.ok) return showError('pageError', res.data.error === 'not_found' ? {error: 'not_found', message: tr('This lab was not found.', 'لم يُعثر على هذا المخبر.')} : res.data);
    data = res.data;
    catalog = cat.ok ? cat.data : null;
    me = who.ok ? who.data.user : null;
    if (me?.role === 'patient') {
        const file = await api('/api/file');
        if (file.ok) profiles = file.data.profiles;
    }
    $('content').hidden = false;

    function render() {
        const lab = data.lab;
        document.title = `${lab.facility_name} — ${tr('SyriaHC', 'صحة تك')}`;
        $('labName').textContent = lab.facility_name;
        $('labKind').textContent = catalog?.facilityKinds?.[lab.kind] ? tr(...catalog.facilityKinds[lab.kind]) : lab.kind;
        const gov = catalog?.governorates?.[lab.governorate] ? tr(...catalog.governorates[lab.governorate]) : '';
        $('labPlace').textContent = [lab.address, lab.area, gov].filter(Boolean).join(' · ');
        $('labPhoneBox').hidden = !lab.phone;
        if (lab.phone) Object.assign($('labPhone'), {href: 'tel:' + lab.phone, textContent: lab.phone});
        $('labHours').hidden = !lab.opening_hours;
        $('labHours').textContent = lab.opening_hours || '';
        renderPrices();
        renderHome();
    }

    function renderPrices() {
        const tests = data.tests, q = $('testSearch').value.trim().toLowerCase();
        $('testSearchBox').hidden = tests.length < 8;
        $('pricesNote').textContent = tests.length
            ? tr(`Prices from the lab, last changed on ${day(data.prices_updated_at)}. Please confirm the price with the lab.`,
                `الأسعار من المخبر، آخر تعديل في ${day(data.prices_updated_at)}. يرجى التأكد من السعر لدى المخبر.`)
            : tr('This lab has not published prices yet. Please call the lab.', 'لم ينشر هذا المخبر أسعاره بعد. يرجى الاتصال بالمخبر.');
        if (!tests.length) return $('pricesBox').replaceChildren();
        const kindName = key => catalog?.facilityServices?.[data.lab.kind]?.[key] ? tr(...catalog.facilityServices[data.lab.kind][key]) : '';
        const shown = tests.filter(t => !q || [t.name, kindName(t.service), t.notes].join(' ').toLowerCase().includes(q));
        const table = el('table', {className: 'values'});
        table.append(el('caption', {textContent: tr(`${shown.length} of ${tests.length} tests`, `${shown.length} من ${tests.length} تحليل`)}));
        const head = el('tr');
        const cols = [['Test', 'التحليل'], ['Price', 'السعر'], ['Result in', 'النتيجة خلال']];
        if (data.lab.home_collection) cols.unshift(['Choose', 'اختر']);
        for (const [en, ar] of cols) head.append(el('th', {scope: 'col', textContent: tr(en, ar)}));
        table.append(el('thead', {}, head), el('tbody'));
        for (const t of shown) {
            const row = el('tr');
            if (data.lab.home_collection) {
                const box = el('input', {type: 'checkbox', checked: chosen.has(t.name)});
                box.setAttribute('aria-label', tr(`Ask for ${t.name} at home`, `اطلب ${t.name} في المنزل`));
                box.addEventListener('change', () => { box.checked ? chosen.add(t.name) : chosen.delete(t.name); $('visitTests').value = [...chosen].join('، '); });
                row.append(el('td', {}, box));
            }
            const name = el('th', {scope: 'row', dir: 'auto'}, t.name);
            const extra = [kindName(t.service), t.notes].filter(Boolean).join(' · ');
            if (extra) name.append(el('br'), el('span', {className: 'muted-small', textContent: extra}));
            row.append(name, el('td', {className: 'num', textContent: price(t.price_syp)}), el('td', {textContent: hours(t.turnaround_hours)}));
            table.tBodies[0].append(row);
        }
        $('pricesBox').replaceChildren(table);
    }

    function renderHome() {
        const lab = data.lab;
        $('home').hidden = !lab.home_collection;
        if (!lab.home_collection) return;
        const patient = me?.role === 'patient';
        $('homeSignIn').hidden = patient;
        $('homeSignInLink').href = '/login?next=' + encodeURIComponent(`/lab?id=${id}#home`);
        $('homeForm').hidden = !patient || !$('homeDone').hidden;
        if (!patient) return;
        Object.assign($('visitDate'), {min: isoDay(1), max: isoDay(30)});
        if (!$('visitDate').value) $('visitDate').value = isoDay(1);
        const checked = document.querySelector('input[name="window"]:checked')?.value || 'morning';
        $('windows').replaceChildren(...Object.entries(data.windows).map(([key, labels]) => {
            const radio = el('input', {type: 'radio', name: 'window', value: key, id: 'w-' + key, checked: key === checked});
            const label = el('label', {className: 'check', htmlFor: radio.id});
            label.append(radio, el('span', {textContent: tr(...labels)}));
            return label;
        }));
        if (!$('visitPhone').value && me.phone) $('visitPhone').value = me.phone;
        const children = profiles.filter(p => p.relationship === 'child');
        $('forWhomBox').hidden = !children.length;
        $('forWhom').replaceChildren(...[{id: '', name: tr('Me', 'أنا')}, ...children].map(p => {
            const radio = el('input', {type: 'radio', name: 'forWhom', value: p.id, id: 'fw-' + (p.id || 'me'), checked: (subject || '') === p.id});
            radio.addEventListener('change', () => { subject = p.id || null; });
            const label = el('label', {className: 'check', htmlFor: radio.id});
            label.append(radio, el('bdi', {textContent: p.name}));
            return label;
        }));
    }

    $('testSearch').addEventListener('input', renderPrices);
    $('homeForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('homeError').hidden = true;
        busy($('homeButton'), true);
        const res = await api('/api/home-visits', {facility_id: data.lab.id, visit_date: $('visitDate').value,
            time_window: document.querySelector('input[name="window"]:checked')?.value, address: $('visitAddress').value, phone: $('visitPhone').value,
            ...($('visitTests').value.trim() && {tests: $('visitTests').value.trim()}), ...(subject && {subject_id: subject})});
        busy($('homeButton'), false);
        if (!res.ok) return showError('homeError', res.data);
        const v = res.data.visit;
        $('homeForm').hidden = true;
        $('homeDone').hidden = false;
        $('homeDone').textContent = tr(`Request sent for ${day(v.visit_date)} (${data.windows[v.time_window][0]}). The lab will confirm; you find it under "My appointments".`,
            `أُرسل الطلب ليوم ${day(v.visit_date)} (${data.windows[v.time_window][1]}). سيؤكد المخبر الطلب؛ تجده في «مواعيدي».`);
        $('homeDone').focus();
    });
    document.addEventListener('shc:language', render);
    render();
    if (window.location.hash === '#home' && !$('home').hidden) $('homeHeading').focus();
});
