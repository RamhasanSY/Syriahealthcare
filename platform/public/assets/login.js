// Patient sign-in: phone number, then SMS code (plus name and consent the first time).
document.addEventListener('DOMContentLoaded', () => {
    const {$, tr, api, showError, busy} = Shc;
    let phone = '', newPatient = false, sentInfo = null;

    const renderInfo = () => {
        if (!sentInfo) return;
        $('codeInfo').textContent = tr(`We sent a code to ${sentInfo.phone}. It is valid for ${sentInfo.minutes} minutes.`, `أرسلنا رمزاً إلى ${sentInfo.phone}، صالحاً لمدة ${sentInfo.minutes} دقائق.`);
        if (sentInfo.previewCode) $('codeInfo').textContent += tr(` (Test mode, no SMS sent: your code is ${sentInfo.previewCode}.)`, ` (وضع التجربة، لم تُرسل رسالة: رمزك هو ${sentInfo.previewCode}.)`);
    };
    document.addEventListener('shc:language', renderInfo);

    $('phoneForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('phoneError').hidden = true;
        busy($('sendCode'), true);
        const res = await api('/api/auth/otp/request', {phone: $('phone').value});
        busy($('sendCode'), false);
        if (!res.ok) {
            $('phone').setAttribute('aria-invalid', 'true');
            return showError('phoneError', res.data);
        }
        $('phone').removeAttribute('aria-invalid');
        phone = res.data.phone;
        sentInfo = {phone, minutes: res.data.expiresInMinutes, previewCode: res.data.previewCode};
        renderInfo();
        $('phoneForm').hidden = true;
        $('codeForm').hidden = false;
        $('code').value = '';
        $('code').focus();
    });

    $('codeForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('codeError').hidden = true;
        const body = {phone, code: $('code').value.replace(/\D/g, ''), language: Shc.lang};
        if (newPatient) Object.assign(body, {name: $('name').value.trim(), consent: $('consent').checked});
        busy($('verify'), true);
        const res = await api('/api/auth/otp/verify', body);
        busy($('verify'), false);
        if (res.ok) {
            // Return to the page that sent the patient here (same site only).
            const next = new URLSearchParams(window.location.search).get('next') || '';
            return window.location.assign(/^\/(?![\/\\])/.test(next) ? next : '/account');
        }
        if (res.data.error === 'profile_required') {
            const firstTime = !newPatient;
            newPatient = true;
            $('profile').hidden = false;
            if (firstTime) return $('name').focus();
        }
        showError('codeError', res.data);
    });

    $('changeNumber').addEventListener('click', () => {
        newPatient = false;
        sentInfo = null;
        $('profile').hidden = true;
        $('codeForm').hidden = true;
        $('phoneForm').hidden = false;
        $('phone').focus();
    });
});
