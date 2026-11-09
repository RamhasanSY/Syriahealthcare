// Patient files: every lab result the doctor has scanned, grouped by patient, with a quick search by name or mobile.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError} = Shc;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    const digits = s => s.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/\D/g, '');

    const res = await api('/api/doctor/records');
    $('main').setAttribute('aria-busy', 'false');
    if (res.status === 401) return window.location.assign('/staff?next=/records');
    if (!res.ok) return showError('pageError', res.data);
    const patients = res.data.patients;
    $('content').hidden = false;

    // "0912 345 678" finds +963912345678: the leading 0 of a Syrian number is dropped before matching.
    function matches(p, query) {
        const q = query.trim().toLowerCase(), n = digits(q).replace(/^0/, '');
        return !q || p.name.toLowerCase().includes(q) || (n.length >= 3 && p.phone.includes(n));
    }

    function render() {
        if (!patients.length) {
            $('count').textContent = '';
            $('list').replaceChildren(el('li', {className: 'empty-row', textContent: tr('No results yet. Scan the QR code on a lab result to add it here.', 'لا توجد نتائج بعد. امسح رمز QR على نتيجة تحليل لإضافتها هنا.')}));
            return;
        }
        const shown = patients.filter(p => matches(p, $('search').value));
        $('count').textContent = tr(`${shown.length} of ${patients.length} patients`, `${shown.length} من ${patients.length} مريض`);
        $('list').replaceChildren(...shown.map(p => {
            const li = el('li', {className: 'appt'}), head = el('div', {className: 'appt-head'});
            head.append(el('h2', {className: 'record-name', textContent: p.name, dir: 'auto'}));
            const phone = el('p', {className: 'muted-small'});
            phone.append(el('a', {href: 'tel:' + p.phone, textContent: p.phone, dir: 'ltr'}));
            const ul = el('ul', {className: 'doc-list'});
            ul.append(...p.results.map(r => {
                const row = el('li'), info = el('span');
                // <bdi> keeps a Latin lab name from reordering an Arabic line, and the other way round.
                info.append(el('strong', {textContent: r.title, dir: 'auto'}), ' · ', el('bdi', {textContent: r.lab_name}), ' · ', el('bdi', {textContent: date(r.created_at)}));
                const open = el('a', {href: `/api/doctor/results/${r.id}/file`, target: '_blank', rel: 'noopener', textContent: tr('Open', 'افتح')});
                open.setAttribute('aria-label', `${tr('Open', 'افتح')}: ${r.title}, ${date(r.created_at)}`);
                row.append(info, open);
                // Values sent by the lab's software (HL7 v2 or FHIR) as a table; every look is recorded.
                if (r.has_values) row.append(Shc.valuesButton(`/api/doctor/results/${r.id}/values`, r.title));
                return row;
            }));
            li.append(head, phone, ul);
            return li;
        }));
    }

    $('search').addEventListener('input', render);
    document.addEventListener('shc:language', render);
    render();
});
