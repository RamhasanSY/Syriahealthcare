// Review checklist for administrators (docs/PLAN.md, part G). A doctor or facility is approved only when the
// administrator has ticked every check; the ticks are kept in the history, next to who approved and when.
// There is no register to check licences against automatically, so these are the checks a person makes by hand.
import {HttpError} from './auth.js';

// key -> [English, Arabic], like the lists in catalog.js. The admin page gets them with each profile it opens
// (never from the cached public catalog, so a new check reaches the page at once).
export const reviewChecks = {
    document: ['The licence document is readable, in the name of this doctor or facility, and not expired.',
        'وثيقة الترخيص مقروءة، وباسم هذا الطبيب أو هذه المنشأة، وغير منتهية الصلاحية.'],
    licence_number: ['The licence number in the profile is the one on the document.',
        'رقم الترخيص في الملف هو نفسه المكتوب في الوثيقة.'],
    phone: ['I called the phone number in the profile and they confirmed this application.',
        'اتصلتُ برقم الهاتف المذكور في الملف وأكّدوا هذا الطلب.']
};

// The ticked keys in a fixed order, or an error naming what is missing.
export function checkedReview(checks) {
    const ticked = new Set(Array.isArray(checks) ? checks : []);
    const missing = Object.keys(reviewChecks).filter(key => !ticked.has(key));
    if (missing.length) throw new HttpError(400, 'checks_required', 'Tick every check before approving.');
    return Object.keys(reviewChecks);
}

export const checksSchema = {type: 'array', maxItems: 10, items: {type: 'string', maxLength: 40}};
