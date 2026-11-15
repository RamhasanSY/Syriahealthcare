// A lab's own packages (src/lab-packages.js): build from the price list, change, hide, delete.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const syp = n => n === null || n === undefined ? tr('no price', 'دون سعر') : new Intl.NumberFormat(Shc.lang === 'ar' ? 'ar-SY' : 'en-GB').format(n) + ' ' + tr('SYP', 'ل.س');
    let data = null, editing = null;

    async function load() {
        const res = await api('/api/facility/packages');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff?next=/lab-packages');
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        $('noTests').hidden = data.tests.length >= data.limits.minTests;
        $('formCard').hidden = data.tests.length < data.limits.minTests;
        render();
    }

    function fillForm() {
        const topic = $('topic').value;
        $('topic').replaceChildren(el('option', {value: '', textContent: tr('No topic', 'دون موضوع')}),
            ...Object.entries(data.topics).map(([k, v]) => el('option', {value: k, textContent: tr(...v)})));
        $('topic').value = topic;
        const checked = new Set([...$('tests').querySelectorAll('input:checked')].map(i => i.value));
        $('tests').replaceChildren(...data.tests.map(t => {
            const box = el('input', {type: 'checkbox', value: t.id, id: 'pt-' + t.id, checked: checked.has(t.id)});
            box.addEventListener('change', updateSum);
            return el('label', {className: 'check', htmlFor: box.id}, box, el('span', {}, el('bdi', {textContent: t.name}), ' · ' + syp(t.price_syp)));
        }));
        updateSum();
    }
    function updateSum() {
        const ids = new Set([...$('tests').querySelectorAll('input:checked')].map(i => i.value));
        const chosen = data.tests.filter(t => ids.has(t.id));
        const total = chosen.every(t => t.price_syp !== null) ? chosen.reduce((s, t) => s + t.price_syp, 0) : null;
        $('sum').textContent = tr(`${chosen.length} tests chosen`, `${chosen.length} تحاليل مختارة`) +
            (chosen.length && total !== null ? tr(`, single prices together: ${syp(total)}`, `، مجموع الأسعار المنفردة: ${syp(total)}`) : '');
    }

    function render() {
        fillForm();
        $('announce').textContent = data.packages.length ? tr(`${data.packages.length} packages`, `${data.packages.length} باقات`) : tr('No packages yet.', 'لا توجد باقات بعد.');
        $('list').replaceChildren(...data.packages.map(k => {
            const li = el('li', {className: 'appt'});
            li.append(el('span', {className: 'pill ' + (k.active ? 'ok' : 'off'), textContent: k.active ? tr('Shown', 'ظاهرة') : tr('Hidden', 'مخفية')}),
                el('h3', {textContent: k.name, dir: 'auto'}),
                el('p', {className: 'muted-small', textContent: [syp(k.price_syp), k.saving_syp ? tr(`saves ${syp(k.saving_syp)}`, `توفير ${syp(k.saving_syp)}`) : '',
                    k.topic && data.topics[k.topic] ? tr(...data.topics[k.topic]) : ''].filter(Boolean).join(' · ')}),
                el('p', {className: 'muted-small', textContent: k.tests.map(t => t.name).join('، '), dir: 'auto'}));
            const links = el('div', {className: 'appt-links'});
            const edit = el('button', {type: 'button', className: 'link-btn', textContent: tr('Change', 'تعديل')});
            edit.onclick = () => startEdit(k);
            const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Delete', 'حذف')});
            remove.onclick = async () => {
                busy(remove, true);
                const res = await api(`/api/facility/packages/${k.id}/delete`, {});
                busy(remove, false);
                if (!res.ok) return showError('pageError', res.data);
                await load();
                $('announce').focus();
            };
            links.append(edit, remove);
            li.append(links);
            return li;
        }));
    }

    function startEdit(k) {
        editing = k;
        $('formTitle').dataset.en = 'Change package';
        $('formTitle').dataset.ar = 'تعديل الباقة';
        $('formTitle').textContent = tr('Change package', 'تعديل الباقة');
        $('name').value = k.name;
        $('topic').value = k.topic || '';
        $('price').value = k.price_syp;
        $('description').value = k.description || '';
        $('active').checked = k.active;
        const ids = new Set(k.tests.map(t => t.id));
        $('tests').querySelectorAll('input').forEach(i => { i.checked = ids.has(i.value); });
        updateSum();
        $('cancelEdit').hidden = false;
        $('formTitle').focus();
    }
    function stopEdit() {
        editing = null;
        $('form').reset();
        $('formTitle').dataset.en = 'New package';
        $('formTitle').dataset.ar = 'باقة جديدة';
        $('formTitle').textContent = tr('New package', 'باقة جديدة');
        $('cancelEdit').hidden = true;
        updateSum();
    }
    $('cancelEdit').addEventListener('click', stopEdit);

    $('form').addEventListener('submit', async event => {
        event.preventDefault();
        $('formError').hidden = true;
        busy($('save'), true);
        const body = {name: $('name').value, topic: $('topic').value || null, description: $('description').value || null,
            price_syp: $('price').value === '' ? null : Number($('price').value), active: $('active').checked,
            test_ids: [...$('tests').querySelectorAll('input:checked')].map(i => i.value)};
        if (!Number.isInteger(body.price_syp)) {
            busy($('save'), false);
            return showError('formError', {error: 'invalid_price', message: 'Enter the package price in Syrian pounds.'});
        }
        const res = await api(editing ? `/api/facility/packages/${editing.id}` : '/api/facility/packages', body);
        busy($('save'), false);
        if (!res.ok) return showError('formError', res.data);
        stopEdit();
        await load();
        $('announce').textContent = tr('Package saved.', 'تم حفظ الباقة.');
        $('announce').focus();
    });
    document.addEventListener('shc:language', () => data && render());
    load();
});
