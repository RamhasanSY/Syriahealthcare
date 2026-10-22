// Fixed lists used in doctor and facility profiles and search. Keys are stored in the database; labels are [English, Arabic].
export const specialties = {
    general: ['General practice', 'طب عام'],
    family: ['Family medicine', 'طب الأسرة'],
    internal: ['Internal medicine', 'أمراض داخلية'],
    cardiology: ['Cardiology', 'أمراض القلب'],
    pediatrics: ['Pediatrics', 'طب الأطفال'],
    obgyn: ['Obstetrics & gynecology', 'نسائية وتوليد'],
    dermatology: ['Dermatology', 'أمراض جلدية'],
    ophthalmology: ['Ophthalmology', 'طب العيون'],
    ent: ['Ear, nose & throat', 'أذن وأنف وحنجرة'],
    orthopedics: ['Orthopedics', 'جراحة العظام'],
    general_surgery: ['General surgery', 'جراحة عامة'],
    neurology: ['Neurology', 'أمراض عصبية'],
    neurosurgery: ['Neurosurgery', 'جراحة عصبية'],
    psychiatry: ['Psychiatry', 'طب نفسي'],
    urology: ['Urology', 'جراحة بولية'],
    nephrology: ['Nephrology', 'أمراض الكلى'],
    gastroenterology: ['Gastroenterology', 'أمراض الهضم'],
    endocrinology: ['Endocrinology & diabetes', 'غدد صم وسكري'],
    pulmonology: ['Pulmonology', 'أمراض صدرية'],
    rheumatology: ['Rheumatology', 'أمراض المفاصل والروماتيزم'],
    oncology: ['Oncology', 'أمراض الأورام'],
    hematology: ['Hematology', 'أمراض الدم'],
    radiology: ['Radiology', 'أشعة'],
    anesthesiology: ['Anesthesiology', 'تخدير'],
    plastic_surgery: ['Plastic surgery', 'جراحة تجميلية'],
    vascular_surgery: ['Vascular surgery', 'جراحة أوعية'],
    cardiac_surgery: ['Cardiac surgery', 'جراحة قلبية'],
    physical_medicine: ['Physical medicine & rehabilitation', 'طب فيزيائي وإعادة تأهيل'],
    nutrition: ['Clinical nutrition', 'تغذية علاجية'],
    dentistry: ['Dentistry', 'طب الأسنان']
};

// Labs, imaging centres, hospitals and clinics. Labs and imaging go to the website's Labs page, the others to Hospitals.
export const facilityKinds = {
    lab: ['Medical laboratory', 'مخبر تحاليل طبية'],
    imaging: ['Imaging centre', 'مركز أشعة'],
    hospital: ['Hospital', 'مشفى'],
    clinic: ['Medical centre or clinic', 'مركز طبي أو مستوصف']
};

// What a facility offers, by kind. Shown as tags and used as a filter on the website.
export const facilityServices = {
    lab: {
        blood_count: ['Blood count (CBC)', 'تعداد دم عام'],
        biochemistry: ['Blood chemistry', 'كيمياء الدم'],
        hormones: ['Hormones', 'هرمونات'],
        diabetes: ['Blood sugar and HbA1c', 'سكر الدم والسكر التراكمي'],
        urine_stool: ['Urine and stool tests', 'تحليل البول والبراز'],
        microbiology: ['Cultures and microbiology', 'زرع وجراثيم'],
        serology: ['Serology and immunology', 'مصليات ومناعة'],
        pcr: ['PCR and molecular tests', 'اختبارات PCR والجزيئية'],
        pathology: ['Pathology (biopsies)', 'تشريح مرضي (خزعات)'],
        pregnancy: ['Pregnancy tests', 'اختبارات الحمل'],
        home_collection: ['Home sample collection', 'سحب العينات من المنزل']
    },
    imaging: {
        xray: ['X-ray', 'أشعة سينية'],
        ultrasound: ['Ultrasound', 'تصوير بالأمواج فوق الصوتية (إيكو)'],
        ct: ['CT scan', 'طبقي محوري'],
        mri: ['MRI', 'رنين مغناطيسي'],
        mammography: ['Mammography', 'تصوير الثدي'],
        dexa: ['Bone density (DEXA)', 'كثافة العظام'],
        doppler: ['Doppler', 'دوبلر'],
        panoramic: ['Dental panoramic', 'بانوراما الأسنان']
    },
    hospital: {
        emergency_care: ['Emergency care', 'إسعاف'],
        surgery: ['Surgery', 'جراحة'],
        maternity: ['Maternity and delivery', 'توليد وأمومة'],
        pediatrics: ['Children', 'أطفال'],
        icu: ['Intensive care', 'عناية مشددة'],
        dialysis: ['Dialysis', 'غسيل كلى'],
        cardiology: ['Heart care', 'قلبية'],
        oncology: ['Cancer care', 'أورام'],
        laboratory: ['Laboratory', 'مخبر'],
        radiology: ['Radiology', 'أشعة'],
        outpatient: ['Outpatient clinics', 'عيادات خارجية']
    },
    clinic: {
        general: ['General practice', 'طب عام'],
        pediatrics: ['Children', 'أطفال'],
        women: ["Women's health", 'صحة المرأة'],
        dental: ['Dentistry', 'أسنان'],
        vaccination: ['Vaccination', 'لقاحات'],
        chronic: ['Chronic diseases', 'أمراض مزمنة'],
        mental_health: ['Mental health', 'صحة نفسية'],
        physiotherapy: ['Physiotherapy', 'علاج فيزيائي'],
        laboratory: ['Laboratory', 'مخبر'],
        pharmacy: ['Pharmacy', 'صيدلية']
    }
};

// The 14 governorates of Syria.
export const governorates = {
    damascus: ['Damascus', 'دمشق'],
    rif_dimashq: ['Rif Dimashq', 'ريف دمشق'],
    aleppo: ['Aleppo', 'حلب'],
    homs: ['Homs', 'حمص'],
    hama: ['Hama', 'حماة'],
    latakia: ['Latakia', 'اللاذقية'],
    tartus: ['Tartus', 'طرطوس'],
    idlib: ['Idlib', 'إدلب'],
    daraa: ['Daraa', 'درعا'],
    suwayda: ['As-Suwayda', 'السويداء'],
    quneitra: ['Quneitra', 'القنيطرة'],
    deir_ez_zor: ['Deir ez-Zor', 'دير الزور'],
    raqqa: ['Raqqa', 'الرقة'],
    hasakah: ['Al-Hasakah', 'الحسكة']
};
