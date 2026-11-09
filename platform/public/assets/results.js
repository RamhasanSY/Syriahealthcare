// Lab results (laboratories and imaging centres): upload a result for a patient and print the QR code they take to their doctor.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    let state = null, shown = null;  // shown: the QR slip on screen, as the server returned it
    let query = {};                  // the search on screen: q, from, to

    const listUrl = cursor => '/api/lab/results?' + new URLSearchParams(Object.entries({...query, cursor}).filter(([, v]) => v)).toString();

    const res = await api(listUrl());
    $('main').setAttribute('aria-busy', 'false');
    if (res.status === 401) return window.location.assign('/staff?next=/results');
    if (!res.ok) return showError('pageError', res.data);
    state = res.data;
    $('content').hidden = false;
    $('recent').hidden = false;

    // A new search replaces the list; "Show more" adds the next 50.
    async function load(more) {
        $('listError').hidden = true;
        const button = more ? $('moreButton') : $('searchButton');
        busy(button, true);
        const next = await api(listUrl(more ? state.next_cursor : undefined));
        busy(button, false);
        if (!next.ok) return showError('listError', next.data);
        state = {...next.data, results: more ? [...state.results, ...next.data.results] : next.data.results};
        renderList();
    }

    function renderSlip() {
        if (!shown) return;
        $('slip').hidden = false;
        $('slipLab').textContent = shown.lab_name;
        $('slipQr').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(shown.qr_svg);
        $('slipQr').alt = tr('QR code for ', 'رمز QR لـ ') + shown.result.patient_name;
        $('slipCode').textContent = shown.code;
        $('slipPatient').textContent = shown.result.patient_name;
        $('slipTitle').textContent = shown.result.title;
        $('slipDate').textContent = date(shown.result.created_at);
        $('slipValid').textContent = tr('Code valid until ', 'الرمز صالح حتى ') + date(shown.result.code_expires_at);
        // With the health file on, the slip also tells the patient how to add the result to their own file. Printed in both
        // languages, whatever the language of the screen. Without a birth year only the mobile number's last digits work.
        const file = shown.health_file;
        $('slipFileAr').hidden = $('slipFileEn').hidden = !file;
        if (!file) return;
        const address = file.url.replace(/^https?:\/\//, ''), phoneOnly = file.check === 'phone';
        $('slipFileAr').replaceChildren('أضف هذه النتيجة إلى ملفك الصحي في صحة تك: افتح ', el('bdi', {textContent: address, dir: 'ltr'}),
            phoneOnly ? ' وأدخل هذا الرمز وآخر 3 أرقام من رقم جوالك.' : ' وأدخل هذا الرمز وسنة ميلادك (أو آخر 3 أرقام من رقم جوالك).');
        $('slipFileEn').textContent = `Add this result to your SyriaHC health file: open ${address}, enter this code and ` +
            (phoneOnly ? 'the last 3 digits of your mobile number.' : 'your birth year (or the last 3 digits of your mobile number).');
    }

    function renderList() {
        const searching = Object.values(query).some(Boolean);
        $('moreButton').hidden = !state.next_cursor;
        const n = state.results.length, plus = state.next_cursor ? '+' : '';
        $('listStatus').textContent = searching
            ? tr(`${n}${plus} ${n === 1 && !plus ? 'result' : 'results'} for this search.`, `عدد النتائج لهذا البحث: ${n}${plus}.`)
            : '';
        if (!state.results.length) {
            $('list').replaceChildren(el('li', {className: 'empty-row', textContent: searching
                ? tr('No results match this search.', 'لا توجد نتائج مطابقة لهذا البحث.')
                : tr('No results sent yet.', 'لم تُرسل أي نتيجة بعد.')}));
            return;
        }
        $('list').replaceChildren(...state.results.map(r => {
            const li = el('li', {className: 'appt'}), head = el('div', {className: 'appt-head'});
            head.append(el('strong', {textContent: r.patient_name, dir: 'auto'}), el('span', {className: 'muted-small', textContent: r.patient_phone, dir: 'ltr'}));
            const code = r.code_expired ? tr('Code expired', 'انتهت صلاحية الرمز') : tr('Code valid until ', 'الرمز صالح حتى ') + date(r.code_expires_at);
            li.append(head, el('p', {className: 'appt-reason', textContent: `${r.title} · ${date(r.created_at)} · ${code}`, dir: 'auto'}));
            const again = el('button', {type: 'button', className: 'btn ghost', textContent: tr('New QR code', 'رمز QR جديد')});
            again.setAttribute('aria-label', tr('New QR code for ', 'رمز QR جديد لـ ') + `${r.patient_name}, ${r.title}`);
            again.onclick = async () => {
                $('listError').hidden = true;
                busy(again, true);
                const renewed = await api(`/api/lab/results/${r.id}/code`, {});
                busy(again, false);
                if (!renewed.ok) return showError('listError', renewed.data);
                show(renewed.data);
            };
            const row = el('div', {className: 'actions'});
            row.append(again);
            li.append(row);
            return li;
        }));
    }

    function show(data) {
        shown = data;
        state.results = [data.result, ...state.results.filter(r => r.id !== data.result.id)];
        renderSlip();
        renderList();
        $('slip').focus();
        $('slip').scrollIntoView({block: 'nearest'});
    }

    $('resultForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('formError').hidden = true;
        const file = $('file').files[0];
        if (!file) return showError('formError', {error: 'no_file', message: 'Choose a file to upload.'});
        if (file.size > 5 * 1024 * 1024) return showError('formError', {error: 'file_too_large', message: 'The file is larger than 5 MB.'});
        // Arabic keyboards type ١٩٨٥; the server expects 1985.
        const birthYear = $('birthYear').value.trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
        if (birthYear && !/^(19|20)\d{2}$/.test(birthYear)) return showError('formError', {error: 'invalid_birth_year', message: 'Enter the birth year with 4 digits, for example 1985.'});
        // The fields go before the file, so the server has them when the file arrives.
        const form = new FormData();
        form.append('patient_name', $('patientName').value);
        form.append('patient_phone', $('patientPhone').value);
        form.append('title', $('title').value);
        if (birthYear) form.append('birth_year', birthYear);
        form.append('file', file);
        busy($('uploadButton'), true);
        let response, data = {};
        try {
            response = await fetch('/api/lab/results', {method: 'POST', body: form, credentials: 'same-origin'});
            data = await response.json().catch(() => ({}));
        } catch (_) {
            data = {error: 'network', message: 'Could not connect. Check your internet and try again.'};
        }
        busy($('uploadButton'), false);
        if (!response?.ok) return showError('formError', data);
        $('resultForm').reset();
        show(data);
    });

    $('searchForm').addEventListener('submit', event => {
        event.preventDefault();
        query = {q: $('searchQ').value.trim(), from: $('searchFrom').value, to: $('searchTo').value};
        load(false);
    });
    $('clearSearch').addEventListener('click', () => {
        $('searchForm').reset();
        query = {};
        load(false);
    });
    $('moreButton').addEventListener('click', () => load(true));
    $('printButton').addEventListener('click', () => window.print());
    document.addEventListener('shc:language', () => { renderSlip(); renderList(); });
    renderList();
});
