// Sign-in for doctors, facilities and admins; registration for doctors and facilities (labs, imaging, hospitals, clinics).
document.addEventListener('DOMContentLoaded', () => {
    const {$, api, showError, busy} = Shc;
    const tabs = [[$('tabLogin'), $('loginForm')], [$('tabRegister'), $('registerForm')]];

    function select(index, focus) {
        tabs.forEach(([tab, panel], i) => {
            tab.setAttribute('aria-selected', String(i === index));
            tab.tabIndex = i === index ? 0 : -1;
            panel.hidden = i !== index;
        });
        if (focus) tabs[index][0].focus();
    }
    tabs.forEach(([tab], i) => {
        tab.addEventListener('click', () => select(i));
        tab.addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            e.preventDefault();
            select(i === 0 ? 1 : 0, true);
        });
    });
    // Links like /staff#register or /staff#register-lab open the registration tab with that account type chosen.
    const hash = window.location.hash.match(/^#register(?:-(\w+))?$/);
    if (hash) {
        select(1);
        if (hash[1] && [...$('regType').options].some(o => o.value === hash[1])) $('regType').value = hash[1];
    }
    const renderType = () => {
        const facility = $('regType').value !== 'doctor';
        $('regNameDoctor').hidden = facility;
        $('regNameFacility').hidden = !facility;
        $('regFacilityHint').hidden = !facility;
    };
    $('regType').addEventListener('change', renderType);
    renderType();

    $('loginForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('loginError').hidden = true;
        busy($('loginButton'), true);
        const res = await api('/api/auth/login', {email: $('loginEmail').value, password: $('loginPassword').value});
        busy($('loginButton'), false);
        if (res.ok) return window.location.assign('/account');
        $('loginPassword').value = '';
        showError('loginError', res.data);
    });

    $('registerForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('registerError').hidden = true;
        busy($('registerButton'), true);
        const type = $('regType').value, body = {
            name: $('regName').value, email: $('regEmail').value, password: $('regPassword').value,
            consent: $('regConsent').checked, language: Shc.lang
        };
        const res = type === 'doctor' ? await api('/api/auth/doctor/register', body) : await api('/api/auth/facility/register', {...body, kind: type});
        busy($('registerButton'), false);
        if (res.ok) return window.location.assign('/account');
        showError('registerError', res.data);
    });
});
