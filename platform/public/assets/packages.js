// Lab packages of all approved labs (src/lab-packages.js), cheapest first, by governorate and topic.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const syp = n => new Intl.NumberFormat(Shc.lang === 'ar' ? 'ar-SY' : 'en-GB').format(n) + ' ' + tr('SYP', 'ل.س');
    const catalog = (await api('/api/catalog')).data;
    let data = null, ticket = 0;
    const params = new URLSearchParams(window.location.search);

    function fill() {
        const gov = $('gov').value || params.get('governorate') || '', topic = $('topic').value || params.get('topic') || '';
        $('gov').replaceChildren(el('option', {value: '', textContent: tr('All governorates', 'كل المحافظات')}),
            ...Object.entries(catalog.governorates).map(([k, v]) => el('option', {value: k, textContent: tr(...v)})));
        $('topic').replaceChildren(el('option', {value: '', textContent: tr('All topics', 'كل المواضيع')}),
            ...Object.entries(catalog.packageTopics).map(([k, v]) => el('option', {value: k, textContent: tr(...v)})));
        $('gov').value = gov;
        $('topic').value = topic;
    }

    async function load() {
        const t = ++ticket, query = new URLSearchParams();
        if ($('gov').value) query.set('governorate', $('gov').value);
        if ($('topic').value) query.set('topic', $('topic').value);
        const res = await api('/api/lab-packages?' + query);
        if (t !== ticket) return;
        $('main').setAttribute('aria-busy', 'false');
        if (!res.ok) return showError('listError', res.data);
        data = res.data;
        render();
    }

    function render() {
        fill();
        $('count').textContent = data.packages.length ? tr(`${data.packages.length} packages`, `${data.packages.length} باقة`) : tr('No packages here yet.', 'لا توجد باقات هنا بعد.');
        $('list').replaceChildren(...data.packages.map(k => {
            const li = el('li', {className: 'appt'});
            const place = [k.lab.area, catalog.governorates[k.lab.governorate] ? tr(...catalog.governorates[k.lab.governorate]) : ''].filter(Boolean).join(' · ');
            li.append(el('span', {className: 'pill ok', textContent: syp(k.price_syp)}), el('h3', {textContent: k.name, dir: 'auto'}));
            if (k.saving_syp) li.append(el('p', {className: 'muted-small', textContent: tr(`Single prices together ${syp(k.single_total_syp)}: you save ${syp(k.saving_syp)}`,
                `مجموع الأسعار المنفردة ${syp(k.single_total_syp)}: توفير ${syp(k.saving_syp)}`)}));
            if (k.description) li.append(el('p', {textContent: k.description, dir: 'auto'}));
            li.append(el('p', {className: 'muted-small', dir: 'auto', textContent: tr(`${k.tests.length} tests: `, `${k.tests.length} تحاليل: `) + k.tests.map(t => t.name).join('، ')}),
                el('p', {}, el('a', {href: `/lab?id=${encodeURIComponent(k.lab.id)}`, textContent: k.lab.name, dir: 'auto'}), place ? ' · ' + place : '',
                    k.lab.home_collection ? ' · ' + tr('also at home', 'متاح في المنزل أيضاً') : ''));
            return li;
        }));
    }

    fill();
    $('gov').addEventListener('change', load);
    $('topic').addEventListener('change', load);
    document.addEventListener('shc:language', () => data && render());
    load();
});
