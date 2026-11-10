// Doctors confirm it is them with an emailed code (second factor) before lab results and shared health files open.
// Other pages send them here with ?next=/page and come back afterwards.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    let challenge = null;
    const me = await api('/api/me');
    if (me.status === 401) return window.location.assign('/staff?next=/confirm');
    if (me.ok && me.data.second_factor) return window.location.assign(Shc.localNext('/account'));

    $('send').addEventListener('click', async () => {
        $('error').hidden = true;
        busy($('send'), true);
        const res = await api('/api/auth/step-up/request', {});
        busy($('send'), false);
        if (!res.ok) return showError('error', res.data);
        challenge = res.data.challenge;
        $('codeForm').hidden = false;
        $('send').textContent = tr('Send a new code', 'أرسل رمزاً جديداً');
        $('sent').textContent = tr(`We sent a code to ${res.data.email_hint}. It is valid for ${res.data.expires_in_minutes} minutes.`,
            `أرسلنا رمزاً إلى ${res.data.email_hint}. الرمز صالح لمدة ${res.data.expires_in_minutes} دقائق.`);
        $('code').focus();
    });

    $('codeForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('error').hidden = true;
        busy($('confirm'), true);
        const res = await api('/api/auth/step-up/verify', {challenge, code: $('code').value.replace(/\D/g, ''), remember: $('remember').checked});
        busy($('confirm'), false);
        if (!res.ok) return showError('error', res.data);
        window.location.assign(Shc.localNext('/account'));
    });
    $('heading').focus();
});
