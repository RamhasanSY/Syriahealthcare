// Sign-in for doctors, facilities and admins; registration for doctors and facilities (labs, imaging, hospitals, clinics).
document.addEventListener('DOMContentLoaded', () => {
    const {$, tr, api, showError, busy} = Shc;
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

    // Pages that need a signed-in doctor or lab send people here with ?next=/page; only plain local paths are followed.
    const goOn = () => {
        const next = new URLSearchParams(window.location.search).get('next');
        window.location.assign(/^\/[a-z]+$/.test(next || '') ? next : '/account');
    };
    // Administrators get a second step: the code from their email, tied to this sign-in attempt.
    let challenge = null;
    const showLogin = () => {
        challenge = null;
        $('codeForm').hidden = true;
        $('loginForm').hidden = false;
        document.querySelector('.tabs')?.removeAttribute('hidden');
        $('loginPassword').focus();
    };

    $('loginForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('loginError').hidden = true;
        busy($('loginButton'), true);
        const res = await api('/api/auth/login', {email: $('loginEmail').value, password: $('loginPassword').value});
        busy($('loginButton'), false);
        $('loginPassword').value = '';
        if (res.ok && res.data.second_factor) {
            challenge = res.data.challenge;
            $('loginForm').hidden = true;
            document.querySelector('.tabs')?.setAttribute('hidden', '');
            $('codeForm').hidden = false;
            $('codeHint').textContent = tr(`We sent a 6-digit code to ${res.data.email_hint}. It is valid for ${res.data.expires_in_minutes} minutes.`,
                `أرسلنا رمزاً من 6 أرقام إلى ⁦${res.data.email_hint}⁩. الرمز صالح لمدة ${res.data.expires_in_minutes} دقائق.`);
            $('staffCode').value = '';
            $('staffCode').focus();
            return;
        }
        if (res.ok) return goOn();
        showError('loginError', res.data);
    });

    $('codeForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('codeError').hidden = true;
        busy($('codeButton'), true);
        const res = await api('/api/auth/login/verify', {challenge, code: $('staffCode').value.replace(/\D/g, '')});
        busy($('codeButton'), false);
        if (res.ok) return goOn();
        // An expired or used-up code cannot be retried: back to the password.
        if (['code_expired', 'too_many_attempts'].includes(res.data.error)) {
            showLogin();
            return showError('loginError', res.data);
        }
        showError('codeError', res.data);
    });
    $('codeRestart').addEventListener('click', showLogin);

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
