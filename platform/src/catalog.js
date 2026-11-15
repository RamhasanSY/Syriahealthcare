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

// Labs and imaging go to the website's Labs page, hospitals and clinics to Hospitals, pharmacies and blood banks to their own pages.
// A new kind also needs the CHECK constraint on facility_profiles.kind widened (see migrations/013_more_facility_kinds.sql).
export const facilityKinds = {
    lab: ['Medical laboratory', 'مخبر تحاليل طبية'],
    imaging: ['Imaging centre', 'مركز أشعة'],
    hospital: ['Hospital', 'مشفى'],
    clinic: ['Medical centre or clinic', 'مركز طبي أو مستوصف'],
    pharmacy: ['Pharmacy', 'صيدلية'],
    blood_bank: ['Blood bank', 'بنك دم']
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
        thyroid: ['Thyroid (TSH, T3, T4)', 'الغدة الدرقية (TSH وT3 وT4)'],
        lipids: ['Blood fats (cholesterol, triglycerides)', 'شحوم الدم (الكوليسترول والشحوم الثلاثية)'],
        liver: ['Liver function', 'وظائف الكبد'],
        kidney: ['Kidney function', 'وظائف الكلى'],
        electrolytes: ['Electrolytes (sodium, potassium, calcium)', 'الشوارد (الصوديوم والبوتاسيوم والكالسيوم)'],
        vitamins: ['Vitamins (D, B12) and iron', 'الفيتامينات (د وب12) والحديد'],
        inflammation: ['Inflammation (CRP, ESR)', 'مؤشرات الالتهاب (CRP وسرعة التثفل)'],
        coagulation: ['Blood clotting (PT, INR)', 'تخثر الدم (PT وINR)'],
        cardiac: ['Heart markers (troponin)', 'واسمات القلب (التروبونين)'],
        tumor_markers: ['Tumour markers', 'الواسمات الورمية'],
        allergy: ['Allergy tests', 'اختبارات التحسس'],
        hepatitis_hiv: ['Hepatitis and HIV screening', 'كشف التهاب الكبد ونقص المناعة المكتسب'],
        blood_group: ['Blood group', 'زمرة الدم'],
        premarital: ['Pre-marriage tests', 'تحاليل ما قبل الزواج'],
        semen: ['Semen analysis', 'تحليل السائل المنوي'],
        drug_levels: ['Drug levels in the blood', 'مستويات الأدوية في الدم'],
        genetic: ['Genetic tests', 'اختبارات وراثية'],
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
    },
    pharmacy: {
        open_24h: ['Open 24 hours', 'مفتوحة على مدار الساعة'],
        night_duty: ['Night and holiday duty', 'مناوبة ليلية وفي العطل'],
        delivery: ['Home delivery', 'توصيل إلى المنزل'],
        vaccination: ['Vaccination', 'لقاحات'],
        medical_supplies: ['Medical supplies', 'مستلزمات طبية']
    },
    blood_bank: {
        donation: ['Blood donation', 'التبرع بالدم'],
        blood_types: ['Blood group testing', 'تحديد الزمرة الدموية'],
        platelets: ['Platelets', 'الصفيحات الدموية'],
        plasma: ['Plasma', 'البلازما']
    }
};

// What a lab package is for (src/lab-packages.js), to compare packages across labs.
export const packageTopics = {
    checkup: ['General check-up', 'فحص شامل'],
    pregnancy: ['Pregnancy', 'الحمل'],
    premarital: ['Before marriage', 'ما قبل الزواج'],
    diabetes: ['Diabetes', 'السكري'],
    heart: ['Heart and blood fats', 'القلب والشحوم'],
    thyroid: ['Thyroid', 'الغدة الدرقية'],
    children: ['Children', 'الأطفال'],
    women: ["Women's health", 'صحة المرأة'],
    men: ["Men's health", 'صحة الرجل'],
    elderly: ['Older people', 'كبار السن'],
    other: ['Other', 'أخرى']
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

// Kinds of entries in a patient's health file (stage 2b), with the LOINC document type used in FHIR DocumentReference.type.
export const documentCategories = {
    lab: {loinc: ['11502-2', 'Laboratory report'], label: ['Lab result', 'نتيجة تحليل']},
    imaging: {loinc: ['18748-4', 'Diagnostic imaging study'], label: ['X-ray or scan', 'صورة أشعة']},
    report: {loinc: ['11488-4', 'Consult note'], label: ["Doctor's report", 'تقرير طبي']},
    prescription: {loinc: ['57833-6', 'Prescription for medication'], label: ['Prescription', 'وصفة طبية']},
    discharge: {loinc: ['18842-5', 'Discharge summary'], label: ['Hospital discharge letter', 'تقرير خروج من المشفى']},
    vaccination: {loinc: ['11369-6', 'History of Immunization Narrative'], label: ['Vaccinations', 'لقاحات']},
    other: {loinc: null, label: ['Other', 'أخرى']}
};

// Where an entry of the health file came from.
export const documentSources = {
    'patient-upload': ['Uploaded by the patient', 'رفعه المريض'],
    'lab-slip': ['Lab result taken over from a lab slip', 'نتيجة تحليل أُضيفت من ورقة المخبر']
};
