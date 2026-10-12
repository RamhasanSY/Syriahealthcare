// Find a doctor: approved doctors, filtered by name, specialty and governorate.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const params = new URLSearchParams(window.location.search);
    const catalog = (await api('/api/catalog')).data;
    let doctors = [], timer = null;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const label = (group, key) => catalog?.[group]?.[key] ? tr(...catalog[group][key]) : '';

    function fill(select, group, allEn, allAr, value) {
        const entries = Object.entries(catalog[group]).sort((a, b) => tr(...a[1]).localeCompare(tr(...b[1]), Shc.lang));
        select.replaceChildren(new Option(tr(allEn, allAr), ''), ...entries.map(([k, l]) => new Option(tr(...l), k)));
        select.value = value || '';
    }
    function renderFilters() {
        fill($('specialty'), 'specialties', 'All specialties', 'كل الاختصاصات', $('specialty').value || params.get('specialty'));
        fill($('governorate'), 'governorates', 'All governorates', 'كل المحافظات', $('governorate').value || params.get('governorate'));
    }

    async function search() {
        const query = new URLSearchParams();
        for (const k of ['q', 'specialty', 'governorate']) if ($(k).value.trim()) query.set(k, $(k).value.trim());
        history.replaceState(null, '', query.size ? '?' + query : location.pathname);
        $('results').setAttribute('aria-busy', 'true');
        const res = await api('/api/doctors?' + query);
        $('results').setAttribute('aria-busy', 'false');
        doctors = res.ok ? res.data.doctors : [];
        render();
    }

    function render() {
        $('count').textContent = !doctors.length ? '' : doctors.length === 1 ? tr('1 doctor', 'طبيب واحد') : tr(`${doctors.length} doctors`, doctors.length === 2 ? 'طبيبان' : doctors.length <= 10 ? `${doctors.length} أطباء` : `${doctors.length} طبيباً`);
        if (!doctors.length) {
            $('results').replaceChildren(el('li', {className: 'empty-row', textContent: tr('No doctors match yet. Try another specialty or governorate.', 'لا يوجد أطباء مطابقون بعد. جرّب اختصاصاً أو محافظة أخرى.')}));
            return;
        }
        $('results').replaceChildren(...doctors.map(d => {
            const li = el('li', {className: 'doctor-card'});
            const name = el('h2', {textContent: d.name, dir: 'auto'});
            li.append(el('p', {className: 'specialty', textContent: label('specialties', d.specialty)}), name,
                el('p', {className: 'muted-small', textContent: [d.clinic_name, d.area, label('governorates', d.governorate)].filter(Boolean).join(' · '), dir: 'auto'}));
            if (d.bio) li.append(el('p', {className: 'bio', textContent: d.bio, dir: 'auto'}));
            const book = el('a', {className: 'btn', href: '/book?doctor=' + encodeURIComponent(d.id), textContent: tr('See free times', 'الأوقات المتاحة')});
            book.setAttribute('aria-label', tr('See free times for ', 'الأوقات المتاحة لدى ') + d.name);
            li.append(book);
            return li;
        }));
    }

    $('q').value = params.get('q') || '';
    renderFilters();
    $('filters').addEventListener('submit', e => { e.preventDefault(); search(); });
    $('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
    $('specialty').addEventListener('change', search);
    $('governorate').addEventListener('change', search);
    document.addEventListener('shc:language', () => { renderFilters(); render(); });
    search();
});
