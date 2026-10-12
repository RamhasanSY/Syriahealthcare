// Doctor and admin sign-in, and doctor registration.
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
    if (window.location.hash === '#register') select(1);

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
        const res = await api('/api/auth/doctor/register', {
            name: $('regName').value, email: $('regEmail').value, password: $('regPassword').value,
            consent: $('regConsent').checked, language: Shc.lang
        });
        busy($('registerButton'), false);
        if (res.ok) return window.location.assign('/account');
        showError('registerError', res.data);
    });
});
