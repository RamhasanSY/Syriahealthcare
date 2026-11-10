// "My account": shows who is signed in and what comes next for each role.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const roles = {patient: ['Patient', 'مريض'], doctor: ['Doctor', 'طبيب'], facility: ['Health facility', 'منشأة صحية'], admin: ['Administrator', 'مدير']};
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
        // Patients may have signed in with an email address, a mobile number, or both.
        const byPhone = user.role === 'patient' && user.phone && !user.email;
        $('contactLabel').textContent = byPhone ? tr('Mobile', 'الجوال') : tr('Email', 'البريد الإلكتروني');
        $('userContact').textContent = byPhone ? user.phone : [user.email, user.role === 'patient' ? user.phone : null].filter(Boolean).join(' · ');
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
        approved: ['Approved', 'معتمد', 'Your listing is shown on syriahc.com.', 'منشأتكم ظاهرة على syriahc.com.'],
        rejected: ['Changes requested', 'مطلوب تعديلات', 'Open your facility page to see what needs to change.', 'افتحوا صفحة المنشأة لمعرفة التعديلات المطلوبة.'],
        suspended: ['Suspended', 'موقوف', 'Your listing is hidden from the website. Please contact support.', 'منشأتكم مخفية عن الموقع. يرجى التواصل مع الدعم.']};
    let doctorStatus = null, facilityStatus = null;
    // Patients see their health file and their own SyriaHC patient number once the health file is switched on.
    if (user.role === 'patient') {
        const file = await api('/api/file');
        const self = file.ok ? file.data.profiles.find(p => p.relationship === 'self') : null;
        if (file.ok) Shc.saveProfiles(file.data.profiles);
        $('fileLink').hidden = !file.ok;
        $('numberLabel').hidden = $('userNumber').hidden = !self;
        $('userNumber').textContent = self ? self.patient_number : '';
    }
    if (user.role === 'facility') {
        const profile = await api('/api/facility/profile');
        if (profile.ok) facilityStatus = profile.data.profile.status;
        // Approved labs and imaging centres send results to patients as QR codes.
        $('resultsLink').hidden = !(profile.ok && facilityStatus === 'approved' && ['lab', 'imaging'].includes(profile.data.profile.kind));
        $('connectLink').hidden = !(profile.ok && facilityStatus === 'approved');
        // Labs and imaging centres keep a price list (also before approval) and handle home sample collection.
        const isLab = profile.ok && ['lab', 'imaging'].includes(profile.data.profile.kind);
        $('pricesLink').hidden = $('packagesLink').hidden = !isLab;
        $('visitsLink').hidden = !(isLab && facilityStatus === 'approved');
        // Blood banks and hospitals post blood donation calls.
        $('bloodLink').hidden = !(profile.ok && facilityStatus === 'approved' && ['blood_bank', 'hospital'].includes(profile.data.profile.kind));
        // Pharmacies enter night and holiday duties (also before approval; shown once approved).
        $('dutiesLink').hidden = !(profile.ok && profile.data.profile.kind === 'pharmacy');
    }
    if (user.role === 'doctor') {
        const profile = await api('/api/doctor/profile');
        if (profile.ok) doctorStatus = profile.data.profile.status;
        $('recordsLinks').hidden = doctorStatus !== 'approved';
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
        $('doctorStatus').className = 'pill ' + (doctorStatus === 'approved' ? 'ok' : 'wait');
        $('doctorStatusText').textContent = tr(textEn, textAr);
    };
    const renderFacility = () => {
        if (!facilityStatus) return;
        const [en, ar, textEn, textAr] = FACILITY_STATUS[facilityStatus];
        $('facilityStatus').textContent = tr(en, ar);
        $('facilityStatus').className = 'pill ' + (facilityStatus === 'approved' ? 'ok' : 'wait');
        $('facilityStatusText').textContent = tr(textEn, textAr);
    };
    document.addEventListener('shc:language', () => { render(); renderDoctor(); renderFacility(); });
    render();
    renderDoctor();
    renderFacility();
    $('details').hidden = false;
    $(user.role + 'Next').hidden = false;
    $('logout').hidden = false;
    // Notifications on this device (src/push.js).
    const iphone = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const PUSH_TEXT = {
        on: ['Notifications are on for this device.', 'الإشعارات مفعّلة على هذا الجهاز.'],
        off: ['Get a notification when an appointment is confirmed or something else is new.', 'احصل على إشعار عند تأكيد موعد أو عند وجود جديد.'],
        denied: ['This browser blocks notifications from SyriaHC. Allow them in the browser settings for this site.', 'يمنع هذا المتصفح إشعارات صحة تك. اسمح بها من إعدادات المتصفح لهذا الموقع.'],
        unsupported: iphone
            ? ['On iPhone, first add SyriaHC to the Home Screen (Share, then "Add to Home Screen") and open it from there.', 'على iPhone أضف صحة تك أولاً إلى الشاشة الرئيسية (مشاركة ثم "إضافة إلى الشاشة الرئيسية") وافتحه من هناك.']
            : ['This browser cannot show notifications.', 'لا يستطيع هذا المتصفح عرض الإشعارات.']
    };
    let pushNow = await Shc.pushState();
    const renderPush = () => {
        if (pushNow === 'unavailable') return;
        $('pushCard').hidden = false;
        $('pushText').textContent = tr(...PUSH_TEXT[pushNow]);
        $('pushOn').hidden = pushNow !== 'off';
        $('pushOff').hidden = $('pushTest').hidden = pushNow !== 'on';
    };
    document.addEventListener('shc:language', renderPush);
    renderPush();
    $('pushOn').addEventListener('click', async () => {
        $('pushError').hidden = true;
        Shc.busy($('pushOn'), true);
        const res = await Shc.enablePush();
        Shc.busy($('pushOn'), false);
        if (!res.ok) {
            if (res.data.error === 'push_denied') pushNow = 'denied';
            renderPush();
            return Shc.showError('pushError', res.data);
        }
        pushNow = 'on';
        renderPush();
        $('pushTest').focus();
    });
    $('pushTest').addEventListener('click', async () => {
        $('pushError').hidden = true;
        Shc.busy($('pushTest'), true);
        const res = await api('/api/push/test', {});
        Shc.busy($('pushTest'), false);
        if (!res.ok) Shc.showError('pushError', res.data);
    });
    $('pushOff').addEventListener('click', async () => {
        await Shc.disablePush();
        pushNow = 'off';
        renderPush();
        $('pushOn').focus();
    });
    $('logout').addEventListener('click', async () => {
        await Shc.disablePush();  // this device stops getting this person's notifications
        await api('/api/auth/logout', {});
        await Shc.freshDevice();  // the next person on this phone must not see these patient numbers or cached pages
        window.location.assign('/');
    });
});
