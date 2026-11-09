// Shared by every platform page: language switch, API calls and small helpers.
const Shc = (() => {
    'use strict';
    let lang = 'ar';
    try { lang = localStorage.getItem('shc-lang') === 'en' ? 'en' : 'ar'; } catch (_) {}
    const $ = id => document.getElementById(id);
    const shownErrors = new Map();  // error messages, re-translated when the language changes
    const tr = (en, ar) => lang === 'ar' ? ar : en;

    // Server messages are in English; the most common ones are translated here.
    const arabic = {
        invalid_phone: 'أدخل رقم جوال صحيحاً، مثل 0912 345 678.',
        too_many_codes: 'طلبت رموزاً كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.',
        too_many_codes_today: 'طلبت رموزاً كثيرة اليوم. حاول مجدداً غداً.',
        sms_failed: 'تعذر إرسال الرسالة. حاول مجدداً بعد دقيقة.',
        code_expired: 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.',
        too_many_attempts: 'أدخلت رموزاً خاطئة كثيرة. اطلب رمزاً جديداً.',
        wrong_code: 'الرمز غير صحيح.',
        mail_failed: 'تعذر إرسال البريد. تحقق من العنوان وحاول مجدداً بعد دقيقة.',
        try_later: 'طلبات دخول كثيرة الآن. حاول مجدداً بعد بضع دقائق.',
        phone_signin_unavailable: 'الدخول برقم الجوال غير متاح بعد. يرجى الدخول بالبريد الإلكتروني.',
        use_password: 'هذا البريد مرتبط بحساب طبيب أو منشأة. سجّل الدخول بكلمة المرور.',
        use_email: 'هذا الرقم مرتبط بحساب طبيب أو منشأة أو موظف. سجّل الدخول بالبريد الإلكتروني.',
        disabled: 'تم إيقاف هذا الحساب. يرجى التواصل مع الدعم.',
        invalid_email: 'أدخل بريداً إلكترونياً صحيحاً.',
        invalid_name: 'أدخل اسمك الكامل.',
        weak_password: 'يجب أن تتكون كلمة المرور من 10 أحرف على الأقل.',
        consent_required: 'يرجى الموافقة على الشروط وسياسة الخصوصية.',
        email_taken: 'يوجد حساب بهذا البريد. يرجى تسجيل الدخول.',
        locked: 'محاولات فاشلة كثيرة. انتظر 15 دقيقة ثم حاول مجدداً.',
        wrong_credentials: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
        signin_required: 'يرجى تسجيل الدخول.',
        rate_limited: 'طلبات كثيرة. انتظر قليلاً ثم حاول مجدداً.',
        invalid_request: 'بعض الحقول ناقصة أو غير صحيحة.',
        server_error: 'حدث خطأ. حاول مجدداً.',
        network: 'تعذر الاتصال. تحقق من الإنترنت وحاول مجدداً.',
        forbidden: 'لا تملك صلاحية الوصول إلى هذه الصفحة.',
        invalid_specialty: 'اختر اختصاصاً من القائمة.',
        invalid_governorate: 'اختر محافظة من القائمة.',
        too_long: 'أحد الحقول أطول من المسموح.',
        suspended: 'ملفك موقوف. يرجى التواصل مع الدعم.',
        own_account: 'لا يمكنك إيقاف حسابك أنت.',
        file_consent_required: 'يرجى الموافقة على حفظ الملف الصحي أولاً.',
        invalid_items: 'بعض المستندات المختارة لم تعد موجودة. يرجى إعادة تحميل الصفحة.',
        second_factor_required: 'يرجى تأكيد هويتك بالرمز المرسل إلى بريدك الإلكتروني.',
        doctor_not_approved: 'يجب اعتماد ملفك أولاً.',
        share_code_invalid: 'لم يعد هذا الرمز صالحاً. اطلب من المريض عرض رمز جديد.',
        sharing_unavailable: 'المشاركة غير متاحة بعد.',
        documents_locked: 'لا يمكن تعديل الوثائق بعد الاعتماد. يرجى التواصل مع الدعم.',
        too_many_documents: 'يمكنك رفع 6 وثائق كحد أقصى.',
        no_file: 'اختر ملفاً لرفعه.',
        invalid_kind: 'اختر نوع الوثيقة.',
        file_too_large: 'حجم الملف أكبر من 5 ميغابايت.',
        invalid_file_type: 'ارفع ملف PDF أو JPG أو PNG.',
        // Health file (file.html)
        active_pdf: 'يحتوي ملف PDF هذا على محتوى نشط ولا يمكن رفعه. اطبعه إلى ملف PDF جديد أو التقط صورة له بدلاً من ذلك.',
        invalid_file: 'هذا الملف تالف ولا يمكن قراءته.',
        too_many_pages: 'يمكنك رفع 10 صفحات كحد أقصى في المرة الواحدة.',
        too_many_pages_today: 'يمكنك رفع 30 صفحة كحد أقصى في اليوم. تابع غداً.',
        invalid_category: 'اختر نوع الوثيقة.',
        invalid_document_title: 'أعطِ الوثيقة اسماً قصيراً (حرفان على الأقل).',
        invalid_date: 'أدخل تاريخاً صحيحاً، لا يكون في المستقبل.',
        too_many_file_entries: 'يمكن حفظ 100 وثيقة كحد أقصى في كل ملف. احذف وثائق قديمة أولاً.',
        storage_full: 'لم تعد هناك مساحة في هذا الملف (200 ميغابايت). احذف وثائق قديمة أولاً.',
        image_unreadable: 'تعذرت قراءة هذه الصورة. استخدم صورة JPG أو PNG أو ملف PDF.',
        pages_not_ready: 'انتظر حتى تجهز كل الصفحات.',
        page_problem: 'احذف الصفحات التي فيها مشكلة أولاً.',
        consent_unticked: 'ضع علامة في المربع للموافقة أولاً.',
        restore_expired: 'لم يعد بالإمكان استعادة هذه الوثيقة.',
        not_a_child: 'ملفات الأطفال لمن هم دون 18 عاماً. أدخل تاريخ الميلاد.',
        too_many_children: 'يمكنك إضافة 10 ملفات أطفال كحد أقصى.',
        code_format: 'يتكون الرمز من 12 حرفاً ورقماً، مثل ABCD-EFGH-JKLM.',
        check_format: 'أدخل سنة الميلاد (4 أرقام) أو آخر 3 أرقام من رقم الجوال.',
        wrong_check: 'سنة الميلاد أو آخر 3 أرقام لا تطابق ما أدخله المخبر.',
        claim_locked: 'محاولات خاطئة كثيرة. اطلب ورقة جديدة من المخبر.',
        already_claimed: 'هذه النتيجة موجودة في ملف صحي آخر. إذا كانت نتيجتك فعلاً، يمكنك الإبلاغ عن ذلك.',
        invalid_birth_year: 'أدخل سنة الميلاد بأربعة أرقام، مثلاً 1985.',
        already_submitted: 'أُرسل ملفك للمراجعة مسبقاً.',
        licence_required: 'يرجى رفع ترخيص مزاولة المهنة أولاً.',
        facility_licence_required: 'يرجى رفع ترخيص المنشأة أولاً.',
        invalid_service: 'اختر الخدمات من القائمة.',
        note_required: 'يرجى كتابة سبب مختصر.',
        wrong_status: 'لا يمكن تنفيذ هذا الإجراء في حالة الملف الحالية.',
        not_found: 'غير موجود.',
        invalid_time: 'اختر وقتاً من القائمة.',
        slot_taken: 'لم يعد هذا الوقت متاحاً. يرجى اختيار وقت آخر.',
        patient_busy: 'لديك موعد آخر في هذا الوقت.',
        too_many_active: 'لديك 5 مواعيد قادمة. ألغِ أحدها قبل حجز موعد جديد.',
        too_many_with_doctor: 'لديك مواعيد قادمة مع هذا الطبيب مسبقاً.',
        too_many_bookings: 'حجوزات كثيرة في وقت قصير. حاول لاحقاً.',
        cannot_cancel: 'لم يعد بالإمكان إلغاء هذا الموعد.',
        not_started: 'يمكنك تسجيل الموعد فقط بعد بدئه.',
        reset_invalid: 'هذا الرابط غير صالح أو انتهت صلاحيته. يرجى طلب رابط جديد.',
        password_mismatch: 'كلمتا المرور غير متطابقتين.',
        not_a_lab: 'يمكن للمخابر ومراكز الأشعة فقط إرسال النتائج.',
        lab_not_approved: 'يجب اعتماد منشأتكم قبل إرسال النتائج.',
        invalid_patient_name: 'أدخل اسم المريض الكامل.',
        invalid_title: 'أدخل اسم التحليل، مثلاً: تعداد دم كامل.',
        code_invalid: 'هذا الرمز غير صالح. تحقق منه أو اطلب رمزاً جديداً من المخبر.',
        doctor_not_approved: 'يجب اعتماد ملفك قبل استخدام ملفات المرضى.'
    };

    function applyLanguage() {
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelectorAll('[data-en]').forEach(n => { n.textContent = lang === 'ar' ? n.dataset.ar : n.dataset.en; });
        document.querySelectorAll('[data-placeholder-en]').forEach(n => { n.placeholder = n.getAttribute('data-placeholder-' + lang); });
        const t = document.documentElement.dataset;
        if (t.titleEn) document.title = tr(t.titleEn, t.titleAr);
        const toggle = $('langToggle');
        if (toggle) {
            toggle.textContent = tr('العربية', 'English');
            toggle.lang = tr('ar', 'en');
        }
        shownErrors.forEach((data, id) => { if (!$(id).hidden) $(id).textContent = errorText(data); });
        document.dispatchEvent(new Event('shc:language'));
    }

    async function api(path, body) {
        let response;
        try {
            response = await fetch(path, body === undefined ? {credentials: 'same-origin'} : {
                method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)
            });
        } catch (_) {
            return {ok: false, status: 0, data: {error: 'network', message: 'Could not connect. Check your internet and try again.'}};
        }
        const data = await response.json().catch(() => ({}));
        return {ok: response.ok, status: response.status, data};
    }

    const errorText = data => lang === 'ar' && arabic[data.error] ? arabic[data.error] : data.message || tr('Something went wrong.', 'حدث خطأ.');

    function showError(id, data) {
        const box = $(id);
        shownErrors.set(id, data);
        box.textContent = errorText(data);
        box.hidden = false;
        box.focus?.();
    }

    function busy(button, on) {
        button.disabled = on;
        button.setAttribute('aria-busy', String(on));
    }

    document.addEventListener('DOMContentLoaded', () => {
        $('langToggle')?.addEventListener('click', () => {
            lang = lang === 'ar' ? 'en' : 'ar';
            try { localStorage.setItem('shc-lang', lang); } catch (_) {}
            applyLanguage();
        });
        applyLanguage();
        setUpInstall();
    });

    // The platform can be installed like an app. sw.js saves only page frames, never data from /api/.
    if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
    function setUpInstall() {
        const box = $('installApp');
        if (!box) return;
        let prompt = null;
        const show = (button, ios) => {
            $('installButton').hidden = !button;
            $('installIos').hidden = !ios;
            box.hidden = !button && !ios;
        };
        const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
        // iPhones have no install prompt: point to Share → Add to Home Screen in Safari.
        if (!installed && /iPhone|iPod/.test(navigator.userAgent)) show(false, true);
        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            prompt = event;
            show(true, false);
        });
        $('installButton').addEventListener('click', async () => {
            if (!prompt) return;
            prompt.prompt();
            await prompt.userChoice.catch(() => {});
            prompt = null;
            show(false, false);
        });
        window.addEventListener('appinstalled', () => show(false, false));
    }
    // Health file: the profile names and SyriaHC patient numbers are kept on this device, so the number shows without
    // internet. Never anything medical. Signing out removes them (account.js).
    const PROFILES_KEY = 'shc-file-profiles';
    function saveProfiles(profiles) {
        const list = profiles.map(({id, name, patient_number, relationship}) => ({id, name, patient_number, relationship}));
        try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list)); } catch (_) {}
    }
    function savedProfiles() {
        try {
            const list = JSON.parse(localStorage.getItem(PROFILES_KEY) || '[]');
            return Array.isArray(list) ? list.filter(p => p && typeof p.patient_number === 'string' && typeof p.name === 'string') : [];
        } catch (_) {
            return [];
        }
    }
    function forgetProfiles() {
        try { localStorage.removeItem(PROFILES_KEY); } catch (_) {}
    }
    return {$, tr, api, showError, busy, saveProfiles, savedProfiles, forgetProfiles, get lang() { return lang; }};
})();
