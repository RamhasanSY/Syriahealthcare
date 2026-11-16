// Delete your account (src/account-deletion.js). Also the web page Google Play links to for deleting an account.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const me = await api('/api/me');
    $('main').setAttribute('aria-busy', 'false');
    if (!me.ok) {
        $('signInCard').hidden = false;
        return;
    }
    const user = me.data.user;
    if (user.role === 'admin') {
        $('adminCard').hidden = false;
        return;
    }
    const patient = user.role === 'patient';
    const render = () => {
        $('who').textContent = [user.name, user.email || user.phone].filter(Boolean).join(' · ');
        $('understandText').textContent = patient
            ? tr('I understand that my account and health file are deleted for good. This cannot be undone.', 'أفهم أن حسابي وملفي الصحي سيُحذفان نهائياً، ولا يمكن التراجع عن ذلك.')
            : tr('I understand that the account is switched off at once and later deleted for good.', 'أفهم أن الحساب سيُوقف فوراً ثم يُحذف نهائياً لاحقاً.');
        $('deleteButton').textContent = patient ? tr('Delete my account', 'احذف حسابي') : tr('Switch off and delete my account', 'أوقف حسابي واحذفه');
    };
    render();
    document.addEventListener('shc:language', render);
    $('deleteCard').hidden = false;

    // A sign-in from the last 15 minutes is needed: sign out here, then back to this page after signing in.
    $('signInAgainButton').addEventListener('click', async () => {
        await api('/api/auth/logout', {});
        window.location.assign((patient ? '/login' : '/staff') + '?next=/delete-account');
    });

    $('deleteButton').addEventListener('click', async () => {
        $('deleteError').hidden = true;
        $('signInAgain').hidden = true;
        if (!$('understand').checked) {
            showError('deleteError', {error: 'confirm', en: 'Tick the box first to confirm.', ar: 'ضع علامة في المربع أولاً للتأكيد.'});
            return $('understand').focus();
        }
        busy($('deleteButton'), true);
        const res = await api('/api/account/delete', {confirm: true});
        busy($('deleteButton'), false);
        if (!res.ok) {
            if (res.data.error === 'recent_sign_in_required') {
                $('signInAgain').hidden = false;
                return showError('deleteError', {error: res.data.error,
                    en: 'For your safety, sign in again first. Then come back to this page; it opens by itself.',
                    ar: 'لأمانك، سجّل الدخول من جديد أولاً. ستعود إلى هذه الصفحة تلقائياً.'});
            }
            return showError('deleteError', res.data);
        }
        // Nothing of this person stays on the device: saved patient numbers, cached pages, notifications.
        await Shc.freshDevice();
        $('deleteCard').hidden = true;
        $('doneTitle').textContent = patient ? tr('Your account has been deleted', 'تم حذف حسابك') : tr('Your account is switched off', 'تم إيقاف حسابك');
        $('doneText').textContent = patient
            ? tr('We sent a confirmation to your email address, if your account had one.', 'أرسلنا تأكيداً إلى بريدك الإلكتروني، إن كان لحسابك بريد.')
            : tr('We will delete it for good after checking what must be kept by law, and we sent you an email about it.', 'سنحذفه نهائياً بعد التحقق مما يجب الاحتفاظ به قانونياً، وأرسلنا لك بريداً بذلك.');
        $('doneCard').hidden = false;
        $('doneCard').focus();
    });
});
