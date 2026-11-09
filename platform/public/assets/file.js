// My health file (stage 2b): the patient's own profile and their children's, each with a SyriaHC patient number, consent,
// a timeline with filters and a bin, uploads of photos and PDFs (photos are made smaller in the browser first), and lab
// results taken over from the printed slip. Only profile names and patient numbers stay on this device (common.js).
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus', CLAIM_KEY = 'shc-claim-code';
    const MAX_PAGE_BYTES = 5 * 1024 * 1024, MAX_SIDE = 2000, JPEG_QUALITY = 0.85;
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
    // Calendar days ('2026-11-09') are shown as they are; moments (created_at) in Syria time.
    const longDate = value => new Date(isDay(value) ? value + 'T12:00:00Z' : value)
        .toLocaleDateString(locale(), {day: 'numeric', month: 'long', year: 'numeric', timeZone: isDay(value) ? 'UTC' : TZ});
    const monthName = key => new Date(key + '-15T12:00:00Z').toLocaleDateString(locale(), {month: 'long', year: 'numeric', timeZone: 'UTC'});
    function damascusDay(moment) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'})
            .formatToParts(new Date(moment)).map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    }
    // The server checks dates against its own (UTC) day: never offer a day it would call "in the future".
    const today = () => {
        const now = new Date(), local = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        return [local, now.toISOString().slice(0, 10)].sort()[0];
    };
    // Arabic keyboards type ١٩٨٥; the server expects 1985.
    const latinDigits = text => String(text).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
    const sizeText = bytes => bytes >= 1024 * 1024
        ? tr(`${(bytes / 1048576).toFixed(1)} MB`, `${(bytes / 1048576).toFixed(1)} ميغابايت`)
        : tr(`${Math.max(1, Math.round(bytes / 1024))} KB`, `${Math.max(1, Math.round(bytes / 1024))} كيلوبايت`);
    // Arabic counts: 1 صفحة واحدة, 2 صفحتان, 3–10 صفحات, 11+ صفحة.
    const arCount = (n, one, two, few, many) => n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
    const pagesText = n => tr(n === 1 ? '1 page' : `${n} pages`, arCount(n, 'صفحة واحدة', 'صفحتان', 'صفحات', 'صفحة'));
    const fail = (error, message) => ({error, message});

    // Some error codes mean something else elsewhere on the platform; on this page they get their own wording.
    const FILE_ERRORS = {consent_required: 'file_consent_required', invalid_title: 'invalid_document_title', too_many_documents: 'too_many_file_entries'};
    function fileError(data) {
        let error = FILE_ERRORS[data.error] || data.error;
        // The fifth wrong try locks the slip; the server says so in the message of the same error.
        if (error === 'wrong_check' && /too many/i.test(data.message || '')) error = 'claim_locked';
        return {...data, error};
    }
    const needsConsent = data => ['file_consent_required', 'consent_required'].includes(data.error);

    let file = null;           // GET /api/file: profiles, categories, limits
    let current = null;        // id of the profile on screen
    let items = [], loaded = false, bin = false, filters = {}, loadTicket = 0;
    let pages = [], pageKey = 0, preparing = false;
    let note = null, lastDeleted = null, status = null, copied = null, progress = null;
    let tries = null, reportCode = null;
    const triesByCode = new Map();  // wrong tries in this visit, per slip code

    // A slip link like /file#claim=ABCD-EFGH-JKLM fills in the code; it is taken out of the address bar and history.
    function codeFromHash() {
        const found = window.location.hash.match(/^#claim=([^&]*)/);
        if (!found) return '';
        history.replaceState(null, '', window.location.pathname + window.location.search);
        try { return decodeURIComponent(found[1]).slice(0, 20); } catch (_) { return found[1].slice(0, 20); }
    }
    let claimCode = codeFromHash();
    try {
        claimCode = claimCode || sessionStorage.getItem(CLAIM_KEY) || '';
        sessionStorage.removeItem(CLAIM_KEY);
    } catch (_) {}
    claimCode = claimCode.slice(0, 20);

    const profile = () => file.profiles.find(p => p.id === current);
    const isSelf = p => p.relationship === 'self';

    // ---- Loading ----

    async function start() {
        $('pageError').hidden = true;
        const res = await api('/api/file');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) {
            Shc.forgetProfiles();
            try { if (claimCode) sessionStorage.setItem(CLAIM_KEY, claimCode); } catch (_) {}
            return window.location.assign('/login?next=/file');
        }
        if (res.status === 404) {  // the health file is switched off (HEALTH_FILE): only a short note
            $('lead').hidden = true;
            $('unavailable').hidden = false;
            return;
        }
        if (res.status === 0) return showOffline();
        if (!res.ok) return showError('pageError', res.data);
        file = res.data;
        Shc.saveProfiles(file.profiles);
        $('offline').hidden = true;
        current = file.profiles[0].id;
        $('content').hidden = false;
        if (claimCode) $('claimCode').value = claimCode;
        renderAll();
        if (claimCode && profile().consent) openPanel('claim');
        claimCode = profile().consent ? '' : claimCode;  // still waiting for consent: the consent box says so
        renderProfile();
        await loadItems();
    }

    async function loadItems() {
        const ticket = ++loadTicket, id = current;
        $('timelineError').hidden = true;
        const query = new URLSearchParams(Object.entries({...filters, bin: bin ? 'true' : ''}).filter(([, v]) => v)).toString();
        $('timeline').setAttribute('aria-busy', 'true');
        const res = await api(`/api/file/profiles/${id}/items` + (query ? '?' + query : ''));
        if (ticket !== loadTicket) return;  // the profile, filter or bin changed meanwhile
        $('timeline').setAttribute('aria-busy', 'false');
        if (!res.ok) {
            items = [];
            loaded = false;
            renderTimeline();
            return showError('timelineError', fileError(res.data));
        }
        items = res.data.items;
        loaded = true;
        // Consent may have changed in another tab or on another phone.
        const p = profile();
        if (p && p.consent !== res.data.profile.consent) {
            p.consent = res.data.profile.consent;
            renderProfile();
        }
        renderTimeline();
    }

    function showOffline() {
        $('offline').hidden = false;
        renderOffline();
        $('offline').focus();
    }

    // ---- Rendering ----

    function renderAll() {
        if (!file) return renderOffline();
        renderSelects();
        renderTabs();
        renderProfile();
        renderTimeline();
        renderNote();
        renderStatus();
        renderPages();
        renderProgress();
        renderTries();
    }

    function renderOffline() {
        if ($('offline').hidden) return;
        const saved = Shc.savedProfiles();
        if (!saved.length) {
            $('offlineList').replaceChildren(el('li', {className: 'empty-row', textContent: tr('No patient number is saved on this device yet. Open this page once with internet.',
                'لا يوجد رقم محفوظ على هذا الجهاز بعد. افتح هذه الصفحة مرة واحدة مع الإنترنت.')}));
            return;
        }
        $('offlineList').replaceChildren(...saved.map(p => {
            const li = el('li', {className: 'number-item'});
            const name = el('p', {className: 'number-name'});
            name.append(el('bdi', {textContent: p.name}), p.relationship === 'self' ? tr(' (me)', ' (أنا)') : '');
            li.append(name, el('p', {className: 'patient-number', textContent: p.patient_number, dir: 'ltr'}));
            return li;
        }));
    }

    function renderSelects() {
        const fill = (select, first) => {
            const value = select.value;
            select.replaceChildren(el('option', {value: '', textContent: first}),
                ...Object.entries(file.categories).map(([key, label]) => el('option', {value: key, textContent: tr(...label)})));
            select.value = value;
        };
        fill($('upCategory'), tr('Choose…', 'اختر…'));
        fill($('filterCategory'), tr('All kinds', 'كل الأنواع'));
        $('upDate').max = today();
        $('filterFrom').max = $('filterTo').max = today();
        $('childBirth').max = $('editBirth').max = today();
    }

    function renderTabs() {
        const list = $('profileTabs'), focused = list.contains(document.activeElement) ? document.activeElement.id : null;
        list.setAttribute('aria-label', tr('Whose file', 'ملف من'));
        list.replaceChildren(...file.profiles.map(p => {
            const tab = el('button', {type: 'button', id: 'tab-' + p.id});
            tab.append(el('bdi', {textContent: p.name}), isSelf(p) ? tr(' (me)', ' (أنا)') : '');
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(p.id === current));
            tab.setAttribute('aria-controls', 'profilePanel');
            tab.tabIndex = p.id === current ? 0 : -1;
            tab.addEventListener('click', () => selectProfile(p.id));
            return tab;
        }));
        $('profilePanel').setAttribute('aria-labelledby', 'tab-' + current);
        if (focused) $(focused)?.focus();
    }

    function renderProfile() {
        const p = profile();
        $('patientNumber').textContent = p.patient_number;
        $('profileName').replaceChildren(el('bdi', {textContent: p.name}));
        $('profileBirth').textContent = p.birth_date ? longDate(p.birth_date) : tr('Not given', 'غير محدد');
        $('copyStatus').textContent = copied === null ? '' : copied
            ? tr('Copied', 'تم النسخ') : tr('Could not copy. Select the number and copy it.', 'تعذر النسخ. حدد الرقم وانسخه.');
        $('editBirthLabel').textContent = isSelf(p) ? tr('Birth date (optional)', 'تاريخ الميلاد (اختياري)') : tr('Birth date *', 'تاريخ الميلاد *');

        $('consentBox').hidden = p.consent;
        $('addBox').hidden = !p.consent;
        $('withdrawBox').hidden = !p.consent;
        if (!p.consent) {
            openPanel(null);
            $('withdrawConfirm').hidden = true;
            $('withdrawToggle').setAttribute('aria-expanded', 'false');
        }
        $('consentHeading').textContent = isSelf(p) ? tr('Start your health file', 'ابدأ ملفك الصحي') : tr(`Start a health file for ${p.name}`, `ابدأ ملفاً صحياً لـ ${p.name}`);
        $('consentLabel').textContent = isSelf(p)
            ? tr('I agree that SyriaHC keeps my health file as described above and in the privacy policy.',
                'أوافق على أن تحفظ صحة تك ملفي الصحي كما هو موضح أعلاه وفي سياسة الخصوصية.')
            : tr(`I am ${p.name}'s parent or guardian and agree that SyriaHC keeps this health file as described above and in the privacy policy.`,
                `أنا وليّ أمر ${p.name} وأوافق على أن تحفظ صحة تك هذا الملف الصحي كما هو موضح أعلاه وفي سياسة الخصوصية.`);
        $('claimWaiting').hidden = !claimCode;  // a slip link brought a code that waits for consent
        $('uploadButton').textContent = isSelf(p) ? tr('Upload to my file', 'ارفع إلى ملفي') : tr(`Upload to ${p.name}'s file`, `ارفع إلى ملف ${p.name}`);
        $('claimButton').textContent = isSelf(p) ? tr('Add to my file', 'أضف إلى ملفي') : tr(`Add to ${p.name}'s file`, `أضف إلى ملف ${p.name}`);
        // Sharing (share.js) follows the profile on screen.
        document.dispatchEvent(new CustomEvent('shc:profile', {detail: {profile: p}}));
    }

    function renderTimeline() {
        $('timelineHeading').textContent = bin ? tr('Bin', 'سلة المحذوفات') : tr('Documents and results', 'الوثائق والنتائج');
        $('binToggle').textContent = bin ? tr('Back to the file', 'العودة إلى الملف') : tr('Open the bin', 'افتح سلة المحذوفات');
        if (!loaded) {
            $('timelineCount').textContent = '';
            $('timeline').replaceChildren();
            return;
        }
        const n = items.length, filtering = Object.values(filters).some(Boolean);
        $('timelineCount').textContent = !n ? '' : bin
            ? tr(`${n} in the bin.`, `في السلة: ${n}.`)
            : tr(`${n} ${n === 1 ? 'entry' : 'entries'}.`, `عدد الوثائق: ${n}.`);
        if (!n) {
            const empty = bin ? tr('The bin is empty.', 'سلة المحذوفات فارغة.')
                : filtering ? tr('Nothing matches these filters.', 'لا يوجد ما يطابق هذا البحث.')
                    : profile().consent ? tr('Nothing in this file yet. Upload a photo or a PDF, or add a lab result from your slip.',
                        'لا يوجد شيء في هذا الملف بعد. ارفع صورة أو ملف PDF، أو أضف نتيجة تحليل من ورقة المخبر.')
                        : tr('Nothing in this file yet.', 'لا يوجد شيء في هذا الملف بعد.');
            $('timeline').replaceChildren(el('p', {className: 'empty-row', textContent: empty}));
            return;
        }
        // Newest first (as the server sends them), grouped by the month of the document (or of adding it).
        const months = new Map();
        for (const item of items) {
            const key = (item.document_date || damascusDay(item.created_at)).slice(0, 7);
            if (!months.has(key)) months.set(key, []);
            months.get(key).push(item);
        }
        $('timeline').replaceChildren(...[...months].map(([key, list]) => {
            const group = el('div', {className: 'month-group'});
            group.append(el('h3', {textContent: monthName(key)}), el('ul', {className: 'appt-list'}));
            group.lastChild.append(...list.map(entry));
            return group;
        }));
    }

    function entry(item) {
        const li = el('li', {className: 'appt entry'});
        const kind = file.categories[item.category] ? tr(...file.categories[item.category]) : item.category;
        const when = item.document_date ? longDate(item.document_date) : tr('Added on ', 'أُضيفت في ') + longDate(item.created_at);
        const head = el('div', {className: 'appt-head'});
        head.append(el('span', {className: 'pill', textContent: kind}), el('span', {className: 'muted-small', textContent: when}));
        const source = el('p', {className: 'muted-small'});
        if (item.source === 'lab_result') source.append(tr('From ', 'من '), el('bdi', {textContent: item.lab_name || tr('a lab', 'مخبر')}));
        else source.append(tr('Uploaded by you', 'رفعتها أنت'));
        source.append(' · ', pagesText(item.pages));
        if (item.size_bytes) source.append(' · ', el('bdi', {textContent: sizeText(item.size_bytes)}));
        const links = el('p', {className: 'page-links'});
        for (let n = 1; n <= item.pages; n++) {
            const link = el('a', {href: `/api/file/documents/${item.id}/pages/${n}`, target: '_blank', rel: 'noopener', textContent: tr(`Page ${n}`, `الصفحة ${n}`)});
            link.setAttribute('aria-label', tr(`Page ${n} of ${item.title} (opens in a new tab)`, `الصفحة ${n} من ${item.title} (تُفتح في نافذة جديدة)`));
            links.append(link);
        }
        li.append(head, el('h4', {className: 'entry-title', textContent: item.title, dir: 'auto'}), source, links);
        if (item.has_values) li.append(Shc.valuesButton(`/api/file/documents/${item.id}/values`, item.title));
        const actions = el('div', {className: 'actions'});
        if (item.deleted_at) {
            const days = file.limits.binDays, gone = new Date(Date.parse(item.deleted_at) + days * 86400000).toISOString();
            li.append(el('p', {className: 'appt-reason', textContent: tr(`Deleted on ${longDate(item.deleted_at)} — removed for good after ${days} days (${longDate(gone)}).`,
                `حُذفت في ${longDate(item.deleted_at)} — تُحذف نهائياً بعد ${days} يوماً (${longDate(gone)}).`)}));
            const restore = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Restore', 'استعادة')});
            restore.setAttribute('aria-label', `${tr('Restore', 'استعادة')}: ${item.title}`);
            restore.addEventListener('click', () => restoreItem(item, restore));
            actions.append(restore);
        } else {
            const remove = el('button', {type: 'button', className: 'btn danger', textContent: tr('Delete', 'حذف')});
            remove.setAttribute('aria-label', `${tr('Delete', 'حذف')}: ${item.title}, ${when}`);
            remove.addEventListener('click', () => deleteItem(item, remove));
            actions.append(remove);
        }
        li.append(actions);
        return li;
    }

    // Messages under the timeline heading (deleted, restored, added) and above the profile (consent, children, edits).
    // They are kept as functions so they follow a change of language.
    function renderNote() {
        $('timelineNote').hidden = !note;
        $('timelineNoteText').textContent = note ? note() : '';
        $('undoDelete').hidden = !note || !lastDeleted;
    }
    function setNote(text, undo = null) {
        note = text;
        lastDeleted = undo;
        renderNote();
        $('timelineNote').focus();
    }
    function renderStatus() {
        $('profileStatus').hidden = !status;
        $('profileStatus').textContent = status ? status() : '';
    }
    function setStatus(text) {
        status = text;
        renderStatus();
        if (text) $('profileStatus').focus();
    }
    function renderProgress() {
        $('uploadProgress').textContent = progress ? progress() : '';
    }
    function setProgress(text) {
        progress = text;
        renderProgress();
    }
    // Shown under the error; screen readers hear it with the error, which gets the focus.
    function renderTries() {
        $('claimTries').hidden = !tries;
        if (tries) $('claimError').setAttribute('aria-describedby', 'claimTries');
        else $('claimError').removeAttribute('aria-describedby');
        if (!tries) return;
        const left = Math.max(0, file.limits.claimAttempts - tries);
        $('claimTries').textContent = left
            ? tr(`You have at most ${left} more ${left === 1 ? 'try' : 'tries'} with this slip before it is locked.`,
                `بقي لك ${arCount(left, 'محاولة واحدة', 'محاولتان', 'محاولات', 'محاولة')} على الأكثر بهذه الورقة قبل أن تُقفل.`)
            : tr('If this try was wrong too, the slip is locked: ask the lab for a new one.', 'إذا كانت هذه المحاولة خاطئة أيضاً فقد قُفلت الورقة: اطلب ورقة جديدة من المخبر.');
    }

    // ---- Profiles ----

    function selectProfile(id) {
        if (id === current) return;
        current = id;
        bin = false;
        filters = {};
        items = [];
        loaded = false;
        note = null;
        lastDeleted = null;
        copied = null;
        tries = null;
        $('filterForm').reset();
        $('editForm').hidden = true;
        $('editToggle').setAttribute('aria-expanded', 'false');
        $('withdrawConfirm').hidden = true;
        $('withdrawToggle').setAttribute('aria-expanded', 'false');
        $('consentCheck').checked = false;
        for (const box of ['consentError', 'editError', 'uploadError', 'claimError', 'reportBox', 'reportDone']) $(box).hidden = true;
        setStatus(null);
        renderAll();
        loadItems();
    }

    $('profileTabs').addEventListener('keydown', event => {
        const tabs = [...$('profileTabs').querySelectorAll('[role=tab]')], i = tabs.indexOf(document.activeElement);
        if (i < 0) return;
        const next = Shc.lang === 'ar' ? 'ArrowLeft' : 'ArrowRight', previous = Shc.lang === 'ar' ? 'ArrowRight' : 'ArrowLeft';
        const to = {[next]: (i + 1) % tabs.length, [previous]: (i - 1 + tabs.length) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
        if (to === undefined) return;
        event.preventDefault();
        tabs[to].focus();  // Enter or Space opens the profile
    });

    $('copyNumber').addEventListener('click', async () => {
        const number = profile().patient_number;
        copied = false;
        try {
            await navigator.clipboard.writeText(number);
            copied = true;
        } catch (_) {
            // Older browsers: copy from a temporary text field.
            const field = el('textarea', {value: number, readOnly: true, className: 'sr-only'});
            document.body.append(field);
            field.select();
            try { copied = document.execCommand('copy'); } catch (_) {}
            field.remove();
            $('copyNumber').focus();
        }
        renderProfile();
    });

    $('childToggle').addEventListener('click', () => {
        const open = $('childForm').hidden;
        $('childForm').hidden = !open;
        $('childToggle').setAttribute('aria-expanded', String(open));
        if (open) $('childName').focus();
    });
    $('childCancel').addEventListener('click', () => {
        $('childForm').reset();
        $('childForm').hidden = true;
        $('childError').hidden = true;
        $('childToggle').setAttribute('aria-expanded', 'false');
        $('childToggle').focus();
    });
    $('childForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('childError').hidden = true;
        const name = $('childName').value.trim(), birth = $('childBirth').value;
        if (name.length < 2) return showError('childError', fail('invalid_name', 'Enter the child\'s full name.'));
        if (!birth) return showError('childError', fail('not_a_child', 'Children\'s profiles are for children under 18. Enter the birth date.'));
        busy($('childButton'), true);
        const res = await api('/api/file/profiles', {name, birth_date: birth, ...($('childSex').value && {sex: $('childSex').value})});
        busy($('childButton'), false);
        if (!res.ok) return showError('childError', fileError(res.data));
        const child = res.data.profile;
        file.profiles.push(child);
        Shc.saveProfiles(file.profiles);
        $('childForm').reset();
        $('childForm').hidden = true;
        $('childToggle').setAttribute('aria-expanded', 'false');
        selectProfile(child.id);
        setStatus(() => tr(`${child.name} was added. Their SyriaHC patient number is ${child.patient_number}.`,
            `أُضيف ${child.name}. رقم المريض في صحة تك: ⁦${child.patient_number}⁩.`));
    });

    $('editToggle').addEventListener('click', () => {
        const open = $('editForm').hidden, p = profile();
        $('editForm').hidden = !open;
        $('editToggle').setAttribute('aria-expanded', String(open));
        $('editError').hidden = true;
        if (!open) return;
        $('editName').value = p.name;
        $('editBirth').value = p.birth_date || '';
        $('editSex').value = p.sex || '';
        $('editName').focus();
    });
    $('editCancel').addEventListener('click', () => {
        $('editForm').hidden = true;
        $('editToggle').setAttribute('aria-expanded', 'false');
        $('editToggle').focus();
    });
    $('editForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('editError').hidden = true;
        const p = profile(), name = $('editName').value.trim();
        if (name.length < 2) return showError('editError', fail('invalid_name', 'Enter the full name.'));
        busy($('editButton'), true);
        const res = await api(`/api/file/profiles/${p.id}`, {name, birth_date: $('editBirth').value || null, sex: $('editSex').value || null});
        busy($('editButton'), false);
        if (!res.ok) return showError('editError', fileError(res.data));
        Object.assign(p, res.data.profile);
        Shc.saveProfiles(file.profiles);
        $('editForm').hidden = true;
        $('editToggle').setAttribute('aria-expanded', 'false');
        renderTabs();
        renderProfile();
        setStatus(() => tr('The profile was saved.', 'حُفظت البيانات.'));
    });

    // ---- Consent ----

    $('consentButton').addEventListener('click', async () => {
        $('consentError').hidden = true;
        if (!$('consentCheck').checked) return showError('consentError', fail('consent_unticked', 'Tick the box to agree first.'));
        const p = profile();
        busy($('consentButton'), true);
        const res = await api(`/api/file/profiles/${p.id}/consent`, {});
        busy($('consentButton'), false);
        if (!res.ok) return showError('consentError', fileError(res.data));
        p.consent = true;
        $('consentCheck').checked = false;
        note = null;
        lastDeleted = null;
        renderNote();
        const fromSlip = Boolean(claimCode);
        claimCode = '';
        renderProfile();
        renderTimeline();
        if (fromSlip) return openPanel('claim');
        setStatus(() => tr('The health file is on. You can now add photos, PDFs and lab results.', 'الملف الصحي مفعّل. يمكنك الآن إضافة صور وملفات PDF ونتائج تحاليل.'));
    });

    $('withdrawToggle').addEventListener('click', () => {
        const open = $('withdrawConfirm').hidden;
        $('withdrawConfirm').hidden = !open;
        $('withdrawError').hidden = true;
        $('withdrawToggle').setAttribute('aria-expanded', String(open));
        if (open) $('withdrawText').focus();
    });
    $('withdrawNo').addEventListener('click', () => {
        $('withdrawConfirm').hidden = true;
        $('withdrawToggle').setAttribute('aria-expanded', 'false');
        $('withdrawToggle').focus();
    });
    $('withdrawYes').addEventListener('click', async () => {
        $('withdrawError').hidden = true;
        const p = profile();
        busy($('withdrawYes'), true);
        const res = await api(`/api/file/profiles/${p.id}/consent/withdraw`, {});
        busy($('withdrawYes'), false);
        if (!res.ok) return showError('withdrawError', fileError(res.data));
        p.consent = false;
        note = null;
        lastDeleted = null;
        renderNote();
        renderProfile();
        renderTimeline();
        setStatus(() => tr('Consent withdrawn. Nothing new can be added to this file. What is already in it stays until you delete it.',
            'سُحبت الموافقة. لا يمكن إضافة شيء جديد إلى هذا الملف. ما فيه الآن يبقى حتى تحذفه.'));
    });

    // ---- Upload and claim panels ----

    function openPanel(which) {
        for (const [name, form, toggle, heading] of [['upload', 'uploadForm', 'uploadToggle', 'uploadHeading'], ['claim', 'claimForm', 'claimToggle', 'claimHeading']]) {
            const open = which === name && profile().consent;
            $(form).hidden = !open;
            $(toggle).setAttribute('aria-expanded', String(open));
            if (open) $(heading).focus();
        }
    }
    $('uploadToggle').addEventListener('click', () => openPanel($('uploadForm').hidden ? 'upload' : null));
    $('claimToggle').addEventListener('click', () => openPanel($('claimForm').hidden ? 'claim' : null));

    // ---- Timeline ----

    $('filterForm').addEventListener('submit', async event => {
        event.preventDefault();
        filters = {category: $('filterCategory').value, from: $('filterFrom').value, to: $('filterTo').value};
        note = null;
        lastDeleted = null;
        renderNote();
        busy($('filterButton'), true);
        await loadItems();
        busy($('filterButton'), false);
    });
    $('filterClear').addEventListener('click', async () => {
        $('filterForm').reset();
        filters = {};
        busy($('filterClear'), true);
        await loadItems();
        busy($('filterClear'), false);
    });
    $('binToggle').addEventListener('click', async () => {
        bin = !bin;
        loaded = false;
        note = null;
        lastDeleted = null;
        renderNote();
        renderTimeline();
        $('timelineHeading').focus();
        await loadItems();
    });

    async function deleteItem(item, button) {
        $('timelineError').hidden = true;
        busy(button, true);
        const res = await api(`/api/file/documents/${item.id}/delete`, {});
        busy(button, false);
        if (!res.ok) return showError('timelineError', fileError(res.data));
        items = items.filter(i => i.id !== item.id);
        renderTimeline();
        const days = res.data.restore_days;
        setNote(() => tr(`“${item.title}” was moved to the bin. You can restore it for ${days} days.`,
            `نُقلت «${item.title}» إلى سلة المحذوفات. يمكنك استعادتها خلال ${days} يوماً.`), item);
    }

    async function restoreItem(item, button) {
        $('timelineError').hidden = true;
        busy(button, true);
        const res = await api(`/api/file/documents/${item.id}/restore`, {});
        busy(button, false);
        if (!res.ok) {
            return showError('timelineError', res.status === 404 ? fail('restore_expired', 'This entry can no longer be restored.') : fileError(res.data));
        }
        await loadItems();
        setNote(() => tr(`“${item.title}” was restored.`, `استُعيدت «${item.title}».`));
    }
    $('undoDelete').addEventListener('click', () => lastDeleted && restoreItem(lastDeleted, $('undoDelete')));

    // ---- Upload ----

    const PAGE_ERRORS = {
        file_too_large: ['Larger than 5 MB. Remove it, or use a smaller file.', 'أكبر من 5 ميغابايت. احذفها أو استخدم ملفاً أصغر.'],
        invalid_file_type: ['Not a PDF, JPG or PNG file. Remove it.', 'ليست ملف PDF أو JPG أو PNG. احذفها.'],
        image_unreadable: ['This picture could not be read. Remove it, or take the photo again.', 'تعذرت قراءة هذه الصورة. احذفها أو التقط الصورة مجدداً.']
    };
    const isPdf = f => f.type === 'application/pdf' || (!f.type && /\.pdf$/i.test(f.name));
    const pageError = code => Object.assign(new Error(code), {code});

    // Pictures are decoded without a blob: address, which this page's security rules do not allow.
    async function decodePicture(picture) {
        if (window.createImageBitmap) {
            try { return await createImageBitmap(picture, {imageOrientation: 'from-image'}); } catch (_) { /* older browsers: below */ }
        }
        const url = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(picture);
        });
        const img = new Image();
        img.src = url;
        await img.decode();
        return img;
    }

    // Photos: at most 2000 px on the long side, saved again as JPEG. Drawing on a canvas leaves the EXIF data
    // (GPS position, phone model) behind. PDFs are sent as they are.
    async function preparePage(picked) {
        if (isPdf(picked)) return {blob: picked, mime: 'application/pdf', shrunk: false};
        if (picked.type && !picked.type.startsWith('image/')) throw pageError('invalid_file_type');
        let picture;
        try { picture = await decodePicture(picked); } catch (_) { throw pageError('image_unreadable'); }
        const width = picture.naturalWidth || picture.width, height = picture.naturalHeight || picture.height;
        const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
        const canvas = el('canvas', {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale))});
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';  // see-through parts of a PNG become white, not black
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(picture, 0, 0, canvas.width, canvas.height);
        picture.close?.();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
        canvas.width = canvas.height = 0;  // frees the memory at once on phones
        if (!blob) throw pageError('image_unreadable');
        return {blob, mime: 'image/jpeg', shrunk: true};
    }

    // One page at a time, so a phone does not hold several big photos in memory at once.
    async function prepareAll() {
        if (preparing) return;
        preparing = true;
        let page;
        while ((page = pages.find(p => p.state === 'waiting'))) {
            page.state = 'working';
            const done = pages.filter(p => p.state === 'ready' || p.state === 'error').length + 1, total = pages.length;
            setProgress(() => tr(`Preparing page ${done} of ${total}…`, `جارٍ تجهيز الصفحة ${done} من ${total}…`));
            renderPages();
            try {
                Object.assign(page, await preparePage(page.file), {state: 'ready'});
                if (page.blob.size > MAX_PAGE_BYTES) Object.assign(page, {state: 'error', error: 'file_too_large'});
            } catch (error) {
                Object.assign(page, {state: 'error', error: PAGE_ERRORS[error.code] ? error.code : 'image_unreadable'});
            }
            page.file = null;  // the original photo is no longer needed
            renderPages();
        }
        preparing = false;
        const ready = pages.filter(p => p.state === 'ready').length;
        setProgress(!pages.length ? null : pages.some(p => p.state === 'error')
            ? () => tr('Some pages have a problem: see the list.', 'بعض الصفحات فيها مشكلة: راجع القائمة.')
            : () => tr(`${ready} ${ready === 1 ? 'page' : 'pages'} ready to upload.`, `الصفحات الجاهزة للرفع: ${ready}.`));
    }

    function addFiles(fileList) {
        const picked = [...fileList];
        if (!picked.length) return;
        $('uploadError').hidden = true;
        const room = file.limits.pagesPerUpload - pages.length;
        if (picked.length > room) showError('uploadError', fail('too_many_pages', `At most ${file.limits.pagesPerUpload} pages at once.`));
        for (const f of picked.slice(0, Math.max(0, room))) pages.push({key: ++pageKey, file: f, name: f.name || tr('Photo', 'صورة'), state: 'waiting'});
        renderPages();
        prepareAll();
    }
    for (const id of ['upFiles', 'upCamera']) {
        $(id).addEventListener('change', event => {
            addFiles(event.target.files);
            event.target.value = '';  // the same photo can be chosen again
        });
    }

    function renderPages() {
        $('pageList').replaceChildren(...pages.map((page, i) => {
            const li = el('li', {className: 'page-item' + (page.state === 'error' ? ' has-error' : '')});
            li.dataset.key = page.key;
            const info = el('span', {className: 'page-info'});
            info.append(el('strong', {textContent: tr(`Page ${i + 1}`, `الصفحة ${i + 1}`)}), ' · ', el('bdi', {textContent: page.name}));
            const state = el('span', {className: 'page-state'});
            state.textContent = page.state === 'ready' ? sizeText(page.blob.size) + (page.shrunk ? tr(' · made smaller', ' · بعد التصغير') : '')
                : page.state === 'error' ? tr(...PAGE_ERRORS[page.error]) : tr('Preparing…', 'جارٍ التجهيز…');
            info.append(el('br'), state);
            const buttons = el('span', {className: 'page-actions'});
            const button = (action, text, label, disabled, run) => {
                const b = el('button', {type: 'button', className: 'link-btn', textContent: text, disabled});
                b.dataset.action = action;
                b.setAttribute('aria-label', label);
                b.addEventListener('click', run);
                buttons.append(b);
            };
            button('up', tr('Up', 'أعلى'), tr(`Move page ${i + 1} up`, `انقل الصفحة ${i + 1} إلى الأعلى`), i === 0, () => movePage(page, -1, 'up'));
            button('down', tr('Down', 'أسفل'), tr(`Move page ${i + 1} down`, `انقل الصفحة ${i + 1} إلى الأسفل`), i === pages.length - 1, () => movePage(page, 1, 'down'));
            button('remove', tr('Remove', 'احذف'), tr(`Remove page ${i + 1}`, `احذف الصفحة ${i + 1}`), false, () => removePage(page));
            li.append(info, buttons);
            return li;
        }));
    }

    function focusPageButton(page, action) {
        const row = $('pageList').querySelector(`[data-key="${page.key}"]`);
        const target = row?.querySelector(`[data-action=${action}]:not([disabled])`) || row?.querySelector('[data-action]:not([disabled])');
        target?.focus();
    }
    function movePage(page, delta, action) {
        const from = pages.indexOf(page), to = from + delta;
        if (to < 0 || to >= pages.length) return;
        pages.splice(from, 1);
        pages.splice(to, 0, page);
        renderPages();
        focusPageButton(page, action);
        setProgress(() => tr(`${page.name} is now page ${to + 1}.`, `أصبحت ${page.name} الصفحة ${to + 1}.`));
    }
    function removePage(page) {
        const at = pages.indexOf(page);
        pages = pages.filter(p => p !== page);
        renderPages();
        const next = pages[Math.min(at, pages.length - 1)];
        if (next) focusPageButton(next, 'remove');
        else $('upFiles').focus();
        setProgress(() => tr(`${page.name} was removed.`, `حُذفت ${page.name}.`));
    }

    // XMLHttpRequest instead of fetch, because only it reports upload progress.
    function send(url, form) {
        return new Promise(resolve => {
            const request = new XMLHttpRequest();
            let quarter = -1;
            request.open('POST', url);
            request.responseType = 'json';
            request.upload.addEventListener('progress', event => {
                if (!event.lengthComputable) return;
                const percent = Math.floor(event.loaded / event.total * 100);
                $('uploadBar').hidden = false;
                $('uploadBar').value = percent;
                // Screen readers hear every quarter, not every percent.
                if (Math.floor(percent / 25) === quarter) return;
                quarter = Math.floor(percent / 25);
                setProgress(() => tr(`Uploading… ${percent}%`, `جارٍ الرفع… ${percent}٪`));
            });
            request.addEventListener('load', () => resolve({ok: request.status >= 200 && request.status < 300, status: request.status, data: request.response || {}}));
            const offline = () => resolve({ok: false, status: 0, data: {error: 'network', message: 'Could not connect. Check your internet and try again.'}});
            request.addEventListener('error', offline);
            request.addEventListener('timeout', offline);
            request.send(form);
        });
    }

    $('uploadForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('uploadError').hidden = true;
        const p = profile(), category = $('upCategory').value, title = $('upTitle').value.trim(), date = $('upDate').value;
        if (!category) return showError('uploadError', fail('invalid_category', 'Choose what kind of document this is.'));
        if (title.length < 2) return showError('uploadError', fail('invalid_document_title', 'Give the document a short name.'));
        if (new TextEncoder().encode(title).length > 200) return showError('uploadError', fail('too_long', 'The name is too long.'));
        if (date && (!isDay(date) || date > today())) return showError('uploadError', fail('invalid_date', 'Enter a valid date, not in the future.'));
        if (!pages.length) return showError('uploadError', fail('no_file', 'Take a photo or choose a file to upload.'));
        if (pages.some(pg => pg.state === 'waiting' || pg.state === 'working')) return showError('uploadError', fail('pages_not_ready', 'Wait until all pages are ready.'));
        if (pages.some(pg => pg.state === 'error')) return showError('uploadError', fail('page_problem', 'Remove the pages marked with a problem first.'));
        // The fields go first, so the server has them when the pages arrive; the pages follow in the order shown.
        const form = new FormData();
        form.append('category', category);
        form.append('title', title);
        if (date) form.append('document_date', date);
        pages.forEach((pg, i) => form.append('page', pg.blob, `page-${i + 1}.${pg.mime === 'application/pdf' ? 'pdf' : 'jpg'}`));
        busy($('uploadButton'), true);
        setProgress(() => tr('Uploading…', 'جارٍ الرفع…'));
        const res = await send(`/api/file/profiles/${p.id}/documents`, form);
        busy($('uploadButton'), false);
        $('uploadBar').hidden = true;
        if (!res.ok) {
            setProgress(null);
            const data = fileError(res.data);
            showError('uploadError', data);
            if (needsConsent(data)) {
                p.consent = false;
                renderProfile();
            }
            return;
        }
        const saved = res.data.item;
        $('uploadForm').reset();
        pages = [];
        renderPages();
        setProgress(null);
        openPanel(null);
        bin = false;
        filters = {};
        $('filterForm').reset();
        await loadItems();
        setNote(() => tr(`Saved: “${saved.title}”, ${pagesText(saved.pages)}.`, `حُفظت «${saved.title}»، ${pagesText(saved.pages)}.`));
    });

    // ---- Lab result from the slip ----

    $('claimForm').addEventListener('submit', async event => {
        event.preventDefault();
        for (const box of ['claimError', 'reportBox', 'reportDone']) $(box).hidden = true;
        tries = null;
        renderTries();
        const p = profile();
        const code = latinDigits($('claimCode').value).toUpperCase().replace(/[^0-9A-Z]/g, '');
        const check = latinDigits($('claimCheck').value).replace(/\D/g, '');
        if (code.length !== 12) return showError('claimError', fail('code_format', 'The code has 12 letters and digits, like ABCD-EFGH-JKLM.'));
        if (check.length !== 3 && check.length !== 4) {
            return showError('claimError', fail('check_format', 'Enter the birth year (4 digits) or the last 3 digits of the mobile number.'));
        }
        busy($('claimButton'), true);
        const res = await api(`/api/file/profiles/${p.id}/claim`, {code, check});
        busy($('claimButton'), false);
        if (!res.ok) {
            const data = fileError(res.data);
            if (data.error === 'wrong_check') {
                triesByCode.set(code, (triesByCode.get(code) || 0) + 1);
                tries = triesByCode.get(code);
                renderTries();
            }
            if (data.error === 'already_claimed') {
                reportCode = code;
                $('reportBox').hidden = false;
                $('reportFields').hidden = true;
                $('reportToggle').setAttribute('aria-expanded', 'false');
            }
            if (needsConsent(data)) {
                p.consent = false;
                renderProfile();
            }
            return showError('claimError', data);
        }
        triesByCode.delete(code);
        $('claimForm').reset();
        const added = res.data.item, isNew = res.status === 201;
        openPanel(null);
        bin = false;
        filters = {};
        $('filterForm').reset();
        await loadItems();
        setNote(() => isNew ? tr(`Added to the file: “${added.title}”.`, `أُضيفت إلى الملف: «${added.title}».`)
            : tr(`This result is already in this file: “${added.title}”.`, `هذه النتيجة موجودة في هذا الملف مسبقاً: «${added.title}».`));
    });

    $('reportToggle').addEventListener('click', () => {
        const open = $('reportFields').hidden;
        $('reportFields').hidden = !open;
        $('reportToggle').setAttribute('aria-expanded', String(open));
        if (open) $('reportNote').focus();
    });
    $('reportSend').addEventListener('click', async () => {
        if (!reportCode) return;
        busy($('reportSend'), true);
        const res = await api('/api/file/claim/report', {code: reportCode, ...($('reportNote').value.trim() && {note: $('reportNote').value.trim()})});
        busy($('reportSend'), false);
        if (!res.ok) return showError('claimError', fileError(res.data));
        reportCode = null;
        $('reportNote').value = '';
        $('reportBox').hidden = true;
        $('claimError').hidden = true;
        $('reportDone').hidden = false;
        $('reportDone').focus();
    });

    $('retry').addEventListener('click', async () => {
        busy($('retry'), true);
        await start();
        busy($('retry'), false);
    });

    // A slip link opened while this page is already open.
    window.addEventListener('hashchange', () => {
        const code = codeFromHash();
        if (!code || !file) return;
        $('claimCode').value = code;
        claimCode = profile().consent ? '' : code;
        renderProfile();
        if (profile().consent) openPanel('claim');
    });

    document.addEventListener('shc:language', renderAll);
    await start();
});
