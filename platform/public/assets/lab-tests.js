// A lab's price list: add, change and remove tests with price, time to result and a note for patients.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const price = n => n === null ? tr('ask the lab', 'اسأل المخبر') : new Intl.NumberFormat(Shc.lang === 'ar' ? 'ar-SY' : 'en-GB').format(n) + ' ' + tr('SYP', 'ل.س');
    let tests = [], services = {}, editing = null, me = null;

    const who = await api('/api/me');
    if (who.status === 401) return window.location.assign('/staff?next=/lab-tests');
    me = who.ok ? who.data.user : null;
    async function load() {
        const res = await api('/api/facility/tests');
        $('main').setAttribute('aria-busy', 'false');
        if (!res.ok) return showError('pageError', res.data);
        tests = res.data.tests;
        services = res.data.services;
        $('content').hidden = false;
        $('publicLink').href = `/lab?id=${me.id}`;
        render();
    }

    function render() {
        const current = $('testService').value;
        $('testService').replaceChildren(el('option', {value: '', textContent: tr('— no kind —', '— بدون نوع —')}),
            ...Object.entries(services).filter(([key]) => key !== 'home_collection').map(([key, labels]) => el('option', {value: key, textContent: tr(...labels)})));
        $('testService').value = current;
        $('formHeading').textContent = editing ? tr(`Change: ${editing.name}`, `تعديل: ${editing.name}`) : tr('Add a test', 'أضف تحليلاً');
        $('saveButton').textContent = editing ? tr('Save changes', 'احفظ التعديلات') : tr('Add to the price list', 'أضف إلى قائمة الأسعار');
        $('cancelEdit').hidden = !editing;
        $('count').textContent = tr(`${tests.length} tests`, `${tests.length} تحليل`);
        $('list').replaceChildren(...(tests.length ? tests.map(t => {
            const li = el('li', {className: 'appt'});
            const info = [services[t.service] ? tr(...services[t.service]) : '', t.turnaround_hours !== null ? tr(`result within ${t.turnaround_hours} h`, `النتيجة خلال ${t.turnaround_hours} ساعة`) : '', t.notes]
                .filter(Boolean).join(' · ');
            li.append(el('div', {className: 'appt-head'}, el('h3', {}, el('bdi', {textContent: t.name})), el('strong', {textContent: price(t.price_syp)})));
            if (info) li.append(el('p', {className: 'muted-small', textContent: info, dir: 'auto'}));
            const change = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Change', 'تعديل')});
            change.setAttribute('aria-label', `${tr('Change', 'تعديل')}: ${t.name}`);
            change.addEventListener('click', () => edit(t));
            const remove = el('button', {type: 'button', className: 'btn danger', textContent: tr('Remove', 'احذف')});
            remove.setAttribute('aria-label', `${tr('Remove', 'احذف')}: ${t.name}`);
            remove.addEventListener('click', async () => {
                if (!window.confirm(tr(`Remove ${t.name} from the price list?`, `حذف ${t.name} من قائمة الأسعار؟`))) return;
                busy(remove, true);
                const res = await api(`/api/facility/tests/${t.id}/delete`, {});
                busy(remove, false);
                if (!res.ok) return showError('pageError', res.data);
                tests = tests.filter(x => x.id !== t.id);
                render();
                $('count').focus();
            });
            li.append(el('div', {className: 'actions'}, change, remove));
            return li;
        }) : [el('li', {className: 'empty-row', textContent: tr('No tests yet. Add your first test above.', 'لا توجد تحاليل بعد. أضيفوا أول تحليل أعلاه.')})]));
    }

    function edit(t) {
        editing = t;
        $('testName').value = t.name;
        $('testService').value = t.service || '';
        $('testPrice').value = t.price_syp ?? '';
        $('testHours').value = t.turnaround_hours ?? '';
        $('testNotes').value = t.notes || '';
        render();
        $('formHeading').focus();
    }
    function clear() {
        editing = null;
        $('testForm').reset();
        render();
    }

    $('testForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('formError').hidden = true;
        const number = id => $(id).value === '' ? null : Math.round(Number($(id).value));
        const body = {name: $('testName').value, service: $('testService').value || null, price_syp: number('testPrice'), turnaround_hours: number('testHours'),
            notes: $('testNotes').value || null};
        busy($('saveButton'), true);
        const res = editing ? await api(`/api/facility/tests/${editing.id}`, body) : await api('/api/facility/tests', body);
        busy($('saveButton'), false);
        if (!res.ok) return showError('formError', res.data);
        tests = editing ? tests.map(t => t.id === res.data.test.id ? res.data.test : t) : [...tests, res.data.test];
        tests.sort((a, b) => a.name.localeCompare(b.name));
        clear();
        $('testName').focus();
    });
    $('cancelEdit').addEventListener('click', clear);
    document.addEventListener('shc:language', render);
    await load();
});
