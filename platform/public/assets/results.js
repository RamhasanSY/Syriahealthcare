// Lab results (laboratories and imaging centres): upload a result for a patient and print the QR code they take to their doctor.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    let state = null, shown = null;  // shown: the QR slip on screen, as the server returned it

    const res = await api('/api/lab/results');
    $('main').setAttribute('aria-busy', 'false');
    if (res.status === 401) return window.location.assign('/staff?next=/results');
    if (!res.ok) return showError('pageError', res.data);
    state = res.data;
    $('content').hidden = false;
    $('recent').hidden = false;

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
    }

    function renderList() {
        if (!state.results.length) {
            $('list').replaceChildren(el('li', {className: 'empty-row', textContent: tr('No results sent yet.', 'لم تُرسل أي نتيجة بعد.')}));
            return;
        }
        $('list').replaceChildren(...state.results.map(r => {
            const li = el('li', {className: 'appt'}), head = el('div', {className: 'appt-head'});
            head.append(el('strong', {textContent: r.patient_name, dir: 'auto'}), el('span', {className: 'muted-small', textContent: r.patient_phone, dir: 'ltr'}));
            const opened = r.doctors ? tr(`In ${r.doctors} doctor's file${r.doctors > 1 ? 's' : ''}`, `في ملف ${r.doctors} ${r.doctors > 1 ? 'أطباء' : 'طبيب'}`) : tr('Not scanned yet', 'لم يُمسح بعد');
            li.append(head, el('p', {className: 'appt-reason', textContent: `${r.title} · ${date(r.created_at)} · ${opened}`, dir: 'auto'}));
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
        // The fields go before the file, so the server has them when the file arrives.
        const form = new FormData();
        form.append('patient_name', $('patientName').value);
        form.append('patient_phone', $('patientPhone').value);
        form.append('title', $('title').value);
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

    $('printButton').addEventListener('click', () => window.print());
    document.addEventListener('shc:language', () => { renderSlip(); renderList(); });
    renderList();
});
