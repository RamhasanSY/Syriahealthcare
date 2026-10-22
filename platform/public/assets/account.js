// "My account": shows who is signed in and what comes next for each role.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const roles = {patient: ['Patient', 'مريض'], doctor: ['Doctor', 'طبيب'], facility: ['Lab, hospital or clinic', 'مخبر أو مشفى أو مركز طبي'], admin: ['Administrator', 'مدير']};
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
    // Labs, imaging centres, hospitals and clinics see where their listing stands.
    const FACILITY_STATUS = {draft: ['Not sent yet', 'لم يُرسل بعد', 'Add your details and operating licence, then send them for review.', 'أضيفوا بيانات المنشأة وترخيصها ثم أرسلوها للمراجعة.'],
        pending: ['Waiting for verification', 'بانتظار التحقق', 'Our team is checking your licence. Your listing is not public yet.', 'يتحقق فريقنا من ترخيصكم. منشأتكم غير ظاهرة للعموم بعد.'],
        approved: ['Approved', 'معتمد', 'Your listing is shown on syriahealthcare.com.', 'منشأتكم ظاهرة على syriahealthcare.com.'],
        rejected: ['Changes requested', 'مطلوب تعديلات', 'Open your facility page to see what needs to change.', 'افتحوا صفحة المنشأة لمعرفة التعديلات المطلوبة.'],
        suspended: ['Suspended', 'موقوف', 'Your listing is hidden from the website. Please contact support.', 'منشأتكم مخفية عن الموقع. يرجى التواصل مع الدعم.']};
    let doctorStatus = null, facilityStatus = null;
    if (user.role === 'facility') {
        const profile = await api('/api/facility/profile');
        if (profile.ok) facilityStatus = profile.data.profile.status;
    }
    if (user.role === 'doctor') {
        const profile = await api('/api/doctor/profile');
        if (profile.ok) doctorStatus = profile.data.profile.status;
        const waiting = await api('/api/doctor/appointments?scope=requests');
        if (waiting.ok && waiting.data.counts.requests) {
            const n = waiting.data.counts.requests;
            $('dashboardLink').removeAttribute('data-en');
            const label = () => { $('dashboardLink').textContent = tr(`Appointments (${n} new)`, `المواعيد (${n} جديد)`); };
            label();
            document.addEventListener('shc:language', label);
        }
    }
    const renderDoctor = () => {
        if (!doctorStatus) return;
        const [en, ar, textEn, textAr] = STATUS[doctorStatus];
        $('doctorStatus').textContent = tr(en, ar);
        $('doctorStatus').className = 'pill' + (doctorStatus === 'approved' ? '' : ' wait');
        $('doctorStatusText').textContent = tr(textEn, textAr);
    };
    const renderFacility = () => {
        if (!facilityStatus) return;
        const [en, ar, textEn, textAr] = FACILITY_STATUS[facilityStatus];
        $('facilityStatus').textContent = tr(en, ar);
        $('facilityStatus').className = 'pill' + (facilityStatus === 'approved' ? '' : ' wait');
        $('facilityStatusText').textContent = tr(textEn, textAr);
    };
    document.addEventListener('shc:language', () => { render(); renderDoctor(); renderFacility(); });
    render();
    renderDoctor();
    renderFacility();
    $('details').hidden = false;
    $(user.role + 'Next').hidden = false;
    $('logout').hidden = false;
    $('logout').addEventListener('click', async () => {
        await api('/api/auth/logout', {});
        window.location.assign('/');
    });
});
