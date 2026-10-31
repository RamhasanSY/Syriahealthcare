// "Forgot password" (/forgot) and choosing a new one from the emailed link (/reset#token).
document.addEventListener('DOMContentLoaded', () => {
    const {$, api, showError, busy} = Shc;

    $('forgotForm')?.addEventListener('submit', async event => {
        event.preventDefault();
        $('forgotError').hidden = true;
        busy($('forgotButton'), true);
        const res = await api('/api/auth/password/forgot', {email: $('forgotEmail').value});
        busy($('forgotButton'), false);
        if (!res.ok) return showError('forgotError', res.data);
        $('forgotForm').hidden = true;
        $('forgotSent').hidden = false;
        $('forgotSent').focus();
    });

    if (!$('resetForm')) return;
    // Take the token out of the address bar at once, so it is not kept in the history or shown on screen.
    const token = window.location.hash.slice(1);
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    const invalid = () => {
        showError('resetError', {error: 'reset_invalid', message: 'This link is invalid or has expired. Please request a new one.'});
        $('resetAgain').hidden = false;
        $('resetButton').disabled = true;
    };
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return invalid();

    $('resetForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('resetError').hidden = true;
        if ($('resetPassword').value !== $('resetRepeat').value) {
            $('resetRepeat').setAttribute('aria-invalid', 'true');
            return showError('resetError', {error: 'password_mismatch', message: 'The two passwords are not the same.'});
        }
        $('resetRepeat').removeAttribute('aria-invalid');
        busy($('resetButton'), true);
        const res = await api('/api/auth/password/reset', {token, password: $('resetPassword').value});
        busy($('resetButton'), false);
        if (res.ok) return window.location.assign('/account');
        if (res.data.error === 'reset_invalid') return invalid();
        showError('resetError', res.data);
    });
});
