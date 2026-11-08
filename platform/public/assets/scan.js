// Scanning a lab result: the QR code opens this page with the code after "#". The doctor checks whose result it is
// and adds it to the patient file. Doctors who are not signed in come back here, with the code, after signing in.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const KEY = 'shc-scan-code';
    const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    let code = decodeURIComponent(window.location.hash.slice(1)), found = null;
    if (code) history.replaceState(null, '', window.location.pathname);  // keep the code out of the address bar and history
    try {
        code = code || sessionStorage.getItem(KEY) || '';
        sessionStorage.removeItem(KEY);
    } catch (_) {}

    const toSignIn = value => {
        try { if (value) sessionStorage.setItem(KEY, value); } catch (_) {}
        window.location.assign('/staff?next=/scan');
    };
    const me = await api('/api/me');
    $('main').setAttribute('aria-busy', 'false');
    const offline = me.status === 0;
    if (!offline && !me.ok) return toSignIn(code);
    if (!offline && me.data.user.role !== 'doctor') return showError('scanError', {error: 'forbidden', message: 'Only doctors can add lab results to a patient file.'});
    $('codeForm').hidden = false;

    function render() {
        $('found').hidden = !found;
        if (!found) return;
        $('foundTitle').textContent = found.title;
        $('foundPatient').textContent = found.patient_name;
        $('foundPhone').textContent = found.patient_phone;
        $('foundLab').textContent = found.lab_name;
        $('foundDate').textContent = date(found.created_at);
        $('toAdd').hidden = found.added;
        $('added').hidden = !found.added;
        $('openLink').href = `/api/doctor/results/${found.id}/file`;
    }

    async function lookup(value) {
        $('scanError').hidden = true;
        found = null;
        render();
        busy($('lookupButton'), true);
        const res = await api('/api/doctor/results/lookup', {code: value});
        busy($('lookupButton'), false);
        if (res.status === 401) return toSignIn(value);
        if (!res.ok) return showError('scanError', res.data);
        found = {...res.data.result, code: value};
        render();
        $('found').focus();
    }

    $('addButton').addEventListener('click', async () => {
        $('scanError').hidden = true;
        busy($('addButton'), true);
        const res = await api('/api/doctor/results/add', {code: found.code});
        busy($('addButton'), false);
        if (!res.ok) return showError('scanError', res.data);
        found = {...res.data.result, code: found.code};
        $('code').value = '';
        render();
        $('announce').textContent = tr(`Added to the file of ${found.patient_name}.`, `أُضيفت إلى ملف ${found.patient_name}.`);
        $('openLink').focus();
    });

    $('codeForm').addEventListener('submit', event => {
        event.preventDefault();
        lookup($('code').value);
    });
    document.addEventListener('shc:language', render);
    // A second QR link opened while this page is already open changes only the part after "#".
    window.addEventListener('hashchange', () => {
        const next = decodeURIComponent(window.location.hash.slice(1));
        if (!next) return;
        history.replaceState(null, '', window.location.pathname);
        $('code').value = next;
        lookup(next);
    });
    if (offline) {
        // Without internet the code stays on screen, so the doctor only has to press "Look up" once the connection is back.
        $('code').value = code;
        showError('scanError', me.data);
    } else if (code) {
        $('code').value = code;
        lookup(code);
    } else {
        $('code').focus();
    }
});
