// Pharmacies on duty (src/pharmacy-duty.js): now, or on one of the next days, by governorate.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError} = Shc;
    const TZ = 'Asia/Damascus';
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const hour = iso => new Date(iso).toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit', timeZone: TZ});
    const dayName = date => new Date(date + 'T12:00:00Z').toLocaleDateString(locale(), {weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC'});
    const localDay = ms => new Date(ms).toLocaleDateString('en-CA', {timeZone: TZ});
    const catalog = (await api('/api/catalog')).data;
    let data = null, ticket = 0;
    // Remember the governorate on this device: people look for the same place again and again.
    let savedGov = '';
    try { savedGov = localStorage.getItem('shc-duty-gov') || ''; } catch (_) {}

    function fill() {
        const gov = $('gov').value || savedGov, when = $('when').value;
        $('gov').replaceChildren(el('option', {value: '', textContent: tr('All governorates', 'كل المحافظات')}),
            ...Object.entries(catalog.governorates).map(([k, v]) => el('option', {value: k, textContent: tr(...v)})));
        const days = Array.from({length: 7}, (_, i) => localDay(Date.now() + i * 86400000));
        $('when').replaceChildren(el('option', {value: '', textContent: tr('Now', 'الآن')}), ...days.map(d => el('option', {value: d, textContent: dayName(d)})));
        $('gov').value = gov;
        $('when').value = when;
    }

    function card(p) {
        const li = el('li', {className: 'appt'});
        const place = [p.address, p.area, catalog.governorates[p.governorate] ? tr(...catalog.governorates[p.governorate]) : ''].filter(Boolean).join(' · ');
        if (p.starts_at) li.append(el('span', {className: 'pill ok', textContent: tr(`${hour(p.starts_at)} to ${hour(p.ends_at)}`, `من ${hour(p.starts_at)} إلى ${hour(p.ends_at)}`)}));
        li.append(el('h3', {textContent: p.name, dir: 'auto'}), el('p', {className: 'muted-small', textContent: place, dir: 'auto'}));
        if (p.phone) li.append(el('p', {className: 'muted-small'}, tr('Phone: ', 'الهاتف: '), el('a', {href: 'tel:' + p.phone, dir: 'ltr', textContent: p.phone})));
        if (p.note) li.append(el('p', {className: 'appt-reason', textContent: p.note, dir: 'auto'}));
        return li;
    }

    async function load() {
        const t = ++ticket, params = new URLSearchParams();
        if ($('gov').value) params.set('governorate', $('gov').value);
        if ($('when').value) params.set('date', $('when').value);
        const res = await api('/api/pharmacies/on-duty?' + params);
        if (t !== ticket) return;
        $('main').setAttribute('aria-busy', 'false');
        if (!res.ok) return showError('listError', res.data);
        data = res.data;
        render();
    }

    function render() {
        fill();
        const empty = text => [el('li', {className: 'empty-row', textContent: text})];
        $('dutyHeading').textContent = data.date ? tr(`On duty on ${dayName(data.date)}`, `مناوبة ${dayName(data.date)}`) : tr('On duty now', 'مناوبة الآن');
        $('duty').replaceChildren(...(data.on_duty.length ? data.on_duty.map(card)
            : empty(tr('No pharmacy has entered a duty for this time yet.', 'لم تُدخل أي صيدلية مناوبة لهذا الوقت بعد.'))));
        $('laterBox').hidden = !data.later.length;
        $('later').replaceChildren(...data.later.map(card));
        $('allDayBox').hidden = !data.open_24h.length;
        $('allDay').replaceChildren(...data.open_24h.map(card));
        const n = data.on_duty.length + data.open_24h.length;
        $('count').textContent = tr(`${n} pharmacies open`, `${n} صيدلية مفتوحة`);
    }

    fill();
    $('gov').addEventListener('change', () => {
        try { localStorage.setItem('shc-duty-gov', $('gov').value); } catch (_) {}
        load();
    });
    $('when').addEventListener('change', load);
    document.addEventListener('shc:language', () => data && render());
    load();
});
