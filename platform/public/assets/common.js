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
        sms_failed: 'تعذر إرسال الرسالة. حاول مجدداً بعد دقيقة.',
        code_expired: 'انتهت صلاحية الرمز. اطلب رمزاً جديداً.',
        too_many_attempts: 'أدخلت رموزاً خاطئة كثيرة. اطلب رمزاً جديداً.',
        wrong_code: 'الرمز غير صحيح.',
        use_email: 'هذا الرقم مرتبط بحساب طبيب أو موظف. سجّل الدخول بالبريد الإلكتروني.',
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
        documents_locked: 'لا يمكن تعديل الوثائق بعد الاعتماد. يرجى التواصل مع الدعم.',
        too_many_documents: 'يمكنك رفع 6 وثائق كحد أقصى.',
        no_file: 'اختر ملفاً لرفعه.',
        invalid_kind: 'اختر نوع الوثيقة.',
        file_too_large: 'حجم الملف أكبر من 5 ميغابايت.',
        invalid_file_type: 'ارفع ملف PDF أو JPG أو PNG.',
        already_submitted: 'أُرسل ملفك للمراجعة مسبقاً.',
        licence_required: 'يرجى رفع ترخيص مزاولة المهنة أولاً.',
        note_required: 'يرجى كتابة سبب مختصر للطبيب.',
        wrong_status: 'لا يمكن تنفيذ هذا الإجراء في حالة الملف الحالية.',
        not_found: 'غير موجود.',
        invalid_time: 'اختر وقتاً من القائمة.',
        slot_taken: 'لم يعد هذا الوقت متاحاً. يرجى اختيار وقت آخر.',
        patient_busy: 'لديك موعد آخر في هذا الوقت.',
        too_many_active: 'لديك 5 مواعيد قادمة. ألغِ أحدها قبل حجز موعد جديد.',
        too_many_with_doctor: 'لديك مواعيد قادمة مع هذا الطبيب مسبقاً.',
        too_many_bookings: 'حجوزات كثيرة في وقت قصير. حاول لاحقاً.',
        cannot_cancel: 'لم يعد بالإمكان إلغاء هذا الموعد.',
        not_started: 'يمكنك تسجيل الموعد فقط بعد بدئه.'
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
    });
    return {$, tr, api, showError, busy, get lang() { return lang; }};
})();
