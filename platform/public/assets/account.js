// "My account": shows who is signed in and what comes next for each role.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const roles = {patient: ['Patient', 'مريض'], doctor: ['Doctor', 'طبيب'], admin: ['Administrator', 'مدير']};
    const res = await api('/api/me');
    $('main').setAttribute('aria-busy', 'false');
    if (!res.ok) {
        $('signedOut').hidden = false;
        return;
    }
    const user = res.data.user;
    const render = () => {
        $('greeting').textContent = tr(`Hello, ${user.name}`, `مرحباً، ${user.name}`);
        $('userName').textContent = user.name;
        $('userRole').textContent = tr(...roles[user.role]);
        $('contactLabel').textContent = user.role === 'patient' ? tr('Mobile', 'الجوال') : tr('Email', 'البريد الإلكتروني');
        $('userContact').textContent = user.role === 'patient' ? user.phone : user.email;
    };
    // Doctors see where their profile stands.
    const STATUS = {draft: ['Profile not sent yet', 'لم يُرسل الملف بعد', 'Add your specialty, clinic and licence, then send it for review.', 'أضف اختصاصك وعيادتك وترخيصك ثم أرسله للمراجعة.'],
        pending: ['Waiting for verification', 'بانتظار التحقق', 'Our team is checking your licence. Patients cannot book you yet.', 'يتحقق فريقنا من ترخيصك. لا يمكن للمرضى الحجز لديك بعد.'],
        approved: ['Approved', 'معتمد', 'Patients can find and book you.', 'يمكن للمرضى إيجادك والحجز لديك.'],
        rejected: ['Changes requested', 'مطلوب تعديلات', 'Open your profile to see what needs to change.', 'افتح ملفك لمعرفة التعديلات المطلوبة.'],
        suspended: ['Suspended', 'موقوف', 'Your profile is hidden from patients. Please contact support.', 'ملفك مخفي عن المرضى. يرجى التواصل مع الدعم.']};
    let doctorStatus = null;
    if (user.role === 'doctor') {
        const profile = await api('/api/doctor/profile');
        if (profile.ok) doctorStatus = profile.data.profile.status;
    }
    const renderDoctor = () => {
        if (!doctorStatus) return;
        const [en, ar, textEn, textAr] = STATUS[doctorStatus];
        $('doctorStatus').textContent = tr(en, ar);
        $('doctorStatus').className = 'pill' + (doctorStatus === 'approved' ? '' : ' wait');
        $('doctorStatusText').textContent = tr(textEn, textAr);
    };
    document.addEventListener('shc:language', () => { render(); renderDoctor(); });
    render();
    renderDoctor();
    $('details').hidden = false;
    $(user.role + 'Next').hidden = false;
    $('logout').hidden = false;
    $('logout').addEventListener('click', async () => {
        await api('/api/auth/logout', {});
        window.location.assign('/');
    });
});
