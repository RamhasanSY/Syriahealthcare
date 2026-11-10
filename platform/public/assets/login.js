// Patient sign-in: an email address (or, once SMS works, a mobile number), then a 6-digit code, plus name and
// consent the first time. The same steps create a new account.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const RESEND_SECONDS = 60;
    // sent: what the code form is about — {method: 'email'|'phone', to, channel, minutes, previewCode}
    let sent = null, newPatient = false, resendTimer = null, resendAt = 0;

    // ---- Email or mobile number ----
    const tabs = [[$('tabEmail'), $('emailForm')], [$('tabPhone'), $('phoneForm')]];
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
    // Not awaited: the forms below must be ready at once, or pressing Enter on a slow connection would submit the
    // email address the browser's way, into the page address (and the server log).
    api('/api/auth/methods').then(methods => {
        if (methods.ok && methods.data.phone) $('methodTabs').hidden = false;
    });

    // "name@gmial.com" -> "Did you mean name@gmail.com?" A typo here means the code never arrives.
    const DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com'];
    const TYPOS = {'gmial.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gmail.co': 'gmail.com',
        'gmail.con': 'gmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'outlok.com': 'outlook.com'};
    function suggestion(value) {
        const [local, domain] = value.trim().toLowerCase().split('@');
        if (!local || !domain || DOMAINS.includes(domain)) return null;
        return TYPOS[domain] ? `${local}@${TYPOS[domain]}` : null;
    }
    // The hint is a button that puts the suggestion in the field. It updates while typing (after a short pause),
    // not when the field loses focus: otherwise it could vanish just as the patient taps "Send code", moving the
    // button away from under their finger.
    let typoTimer = null;
    function renderTypo() {
        const better = suggestion($('email').value);
        $('emailTypo').hidden = !better;
        if (better) $('emailTypo').textContent = tr(`Did you mean ${better}? Tap to use it.`, `هل تقصد ⁦${better}⁩؟ اضغط لاستخدامه.`);
        $('emailTypo').dataset.value = better || '';
    }
    $('email').addEventListener('input', () => {
        clearTimeout(typoTimer);
        typoTimer = setTimeout(renderTypo, 500);
    });
    $('emailTypo').addEventListener('click', () => {
        $('email').value = $('emailTypo').dataset.value;
        renderTypo();
        $('email').focus();
    });

    // ---- Code form ----
    function renderInfo() {
        if (!sent) return;
        const to = `⁦${sent.to}⁩`;  // keep the address or "+963…" left-to-right inside Arabic text
        if (sent.method === 'email') {
            $('codeInfo').textContent = tr(`We sent a code to ${to}. It is valid for ${sent.minutes} minutes. Not there after a minute? Look in the spam folder.`,
                `أرسلنا رمزاً إلى ${to}، صالحاً لمدة ${sent.minutes} دقيقة. لم يصل بعد دقيقة؟ ابحث في مجلد الرسائل غير المرغوب فيها (Spam).`);
        } else {
            const via = {whatsapp: ['by WhatsApp', 'عبر واتساب'], telegram: ['by Telegram', 'عبر تيليغرام'], sms: ['by SMS', 'برسالة SMS']}[sent.channel];
            $('codeInfo').textContent = tr(`We sent a code ${via[0]} to ${to}. It is valid for ${sent.minutes} minutes.`,
                `أرسلنا رمزاً ${via[1]} إلى ${to}، صالحاً لمدة ${sent.minutes} دقائق.`);
        }
        if (sent.previewCode) $('codeInfo').textContent += tr(` (Test mode, nothing was sent: your code is ${sent.previewCode}.)`, ` (وضع التجربة، لم يُرسل شيء: رمزك هو ${sent.previewCode}.)`);
        $('smsInstead').hidden = sent.method !== 'phone' || sent.channel === 'sms';
        $('changeAddress').textContent = sent.method === 'email' ? tr('Use a different email address', 'استخدم بريداً آخر') : tr('Use a different number', 'استخدم رقماً آخر');
        $('welcomeNew').textContent = sent.method === 'email'
            ? tr('Welcome! This email address is new to us. Please tell us your name.', 'أهلاً! هذا البريد جديد لدينا. يرجى إدخال اسمك.')
            : tr('Welcome! This number is new to us. Please tell us your name.', 'أهلاً! هذا الرقم جديد لدينا. يرجى إدخال اسمك.');
        renderResend();
    }
    // Email can take a while: a new code can be asked for after a minute; older codes keep working.
    function renderResend() {
        const left = Math.ceil((resendAt - Date.now()) / 1000);
        $('resend').hidden = !sent || sent.method !== 'email';
        $('resend').disabled = left > 0;
        $('resend').textContent = left > 0 ? tr(`Send a new code (in ${left} s)`, `أرسل رمزاً جديداً (بعد ${left} ث)`) : tr('Send a new code', 'أرسل رمزاً جديداً');
    }
    function startResendTimer() {
        resendAt = Date.now() + RESEND_SECONDS * 1000;
        clearInterval(resendTimer);
        resendTimer = setInterval(() => {
            renderResend();
            if (Date.now() >= resendAt) clearInterval(resendTimer);
        }, 1000);
    }
    document.addEventListener('shc:language', () => { renderInfo(); renderTypo(); });

    function showCodeForm() {
        renderInfo();
        $('start').hidden = true;
        $('codeForm').hidden = false;
        $('code').value = '';
        $('code').focus();
    }

    async function requestEmailCode() {
        const res = await api('/api/auth/email/request', {email: $('email').value, language: Shc.lang});
        if (!res.ok) return res;
        sent = {method: 'email', to: res.data.email, minutes: res.data.expiresInMinutes, previewCode: res.data.previewCode};
        startResendTimer();
        return res;
    }

    $('emailForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('emailError').hidden = true;
        busy($('sendEmailCode'), true);
        const res = await requestEmailCode();
        busy($('sendEmailCode'), false);
        if (!res.ok) {
            $('email').setAttribute('aria-invalid', 'true');
            return showError('emailError', res.data);
        }
        $('email').removeAttribute('aria-invalid');
        showCodeForm();
    });

    $('phoneForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('phoneError').hidden = true;
        busy($('sendCode'), true);
        const res = await api('/api/auth/otp/request', {phone: $('phone').value, language: Shc.lang});
        busy($('sendCode'), false);
        if (!res.ok) {
            $('phone').setAttribute('aria-invalid', 'true');
            return showError('phoneError', res.data);
        }
        $('phone').removeAttribute('aria-invalid');
        sent = {method: 'phone', to: res.data.phone, channel: res.data.channel, minutes: res.data.expiresInMinutes, previewCode: res.data.previewCode};
        showCodeForm();
    });

    $('codeForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('codeError').hidden = true;
        const code = $('code').value.replace(/\D/g, '');
        const body = sent.method === 'email' ? {email: sent.to, code, language: Shc.lang} : {phone: sent.to, code, language: Shc.lang};
        if (newPatient) Object.assign(body, {name: $('name').value.trim(), consent: $('consent').checked});
        busy($('verify'), true);
        const res = await api(sent.method === 'email' ? '/api/auth/email/verify' : '/api/auth/otp/verify', body);
        busy($('verify'), false);
        if (res.ok) {
            // Return to the page that sent the patient here (same site only), after clearing what a previous person left.
            await Shc.freshDevice();
            return window.location.assign(Shc.localNext());
        }
        if (res.data.error === 'profile_required') {
            const firstTime = !newPatient;
            newPatient = true;
            $('profile').hidden = false;
            if (firstTime) return $('name').focus();
        }
        showError('codeError', res.data);
    });

    $('resend').addEventListener('click', async () => {
        $('codeError').hidden = true;
        busy($('resend'), true);
        const res = await requestEmailCode();
        busy($('resend'), false);
        if (!res.ok) return showError('codeError', res.data);
        renderInfo();
        $('code').focus();
    });

    // No WhatsApp on this number, or the message did not arrive: send a new code by SMS.
    $('smsInstead').addEventListener('click', async () => {
        $('codeError').hidden = true;
        busy($('smsInstead'), true);
        const res = await api('/api/auth/otp/request', {phone: sent.to, language: Shc.lang, channel: 'sms'});
        busy($('smsInstead'), false);
        if (!res.ok) return showError('codeError', res.data);
        sent = {...sent, channel: res.data.channel, minutes: res.data.expiresInMinutes, previewCode: res.data.previewCode};
        renderInfo();
        $('code').value = '';
        $('code').focus();
    });

    $('changeAddress').addEventListener('click', () => {
        const method = sent?.method;
        newPatient = false;
        sent = null;
        clearInterval(resendTimer);
        $('profile').hidden = true;
        $('codeForm').hidden = true;
        $('start').hidden = false;
        (method === 'phone' ? $('phone') : $('email')).focus();
    });
});
