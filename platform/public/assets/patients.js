// "My patients" for doctors (stage 2c): everyone from appointments, scanned lab slips and shares, searched on the
// server, and the entries a patient shares. Shared entries need a confirmation code sent to the doctor's email
// (once per session, or once in 30 days on a remembered device). A QR code a patient shows arrives here as #redeem=CODE.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => iso ? new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'}) : '';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    // What the address asks for: a patient to open, or a QR code to redeem. Kept out of the address bar afterwards.
    const hash = decodeURIComponent(window.location.hash.slice(1));
    let redeem = hash.startsWith('redeem=') ? hash.slice(7) : null, open = UUID.test(hash) ? hash : null;
    if (hash) history.replaceState(null, '', window.location.pathname);

    let list = null, secondFactor = false, challenge = null, opened = null, ticket = 0;

    const me = await api('/api/me');
    $('main').setAttribute('aria-busy', 'false');
    if (me.status === 401) return window.location.assign('/staff?next=/patients');
    if (!me.ok) return showError('pageError', me.data);
    if (me.data.user.role !== 'doctor') return showError('pageError', {error: 'forbidden', message: 'This page is for doctors.'});
    secondFactor = me.data.second_factor;

    async function load() {
        const t = ++ticket, q = $('search').value.trim();
        const res = await api('/api/doctor/patients' + (q ? '?q=' + encodeURIComponent(q) : ''));
        if (t !== ticket) return;
        if (res.status === 404) {
            $('unavailable').hidden = false;
            return;
        }
        if (!res.ok) return showError('pageError', res.data);
        $('content').hidden = false;
        list = res.data.patients;
        secondFactor = res.data.second_factor;
        render();
    }

    function render() {
        $('confirmBox').hidden = secondFactor;
        renderConfirm();
        if (!list) return;
        $('count').textContent = list.length ? tr(`${list.length} patients`, `${list.length} مريض`) : '';
        $('list').replaceChildren(...(list.length ? list.map(person => {
            const li = el('li', {className: 'appt'});
            const head = el('div', {className: 'appt-head'}, el('h2', {className: 'record-name'}, el('bdi', {textContent: person.name})));
            const badges = el('p', {className: 'chips'});
            const add = (n, en, ar) => n && badges.append(el('span', {className: 'pill', textContent: tr(`${n} ${en}`, `${n} ${ar}`)}));
            add(person.sources.appointments, 'appointments', 'مواعيد');
            add(person.sources.scans, 'scanned slips', 'أوراق ممسوحة');
            add(person.sources.shares, 'shares', 'مشاركات');
            const facts = el('p', {className: 'muted-small'});
            if (person.patient_number) facts.append(el('bdi', {textContent: person.patient_number, dir: 'ltr'}), ' · ');
            if (person.phone) facts.append(el('a', {href: 'tel:' + person.phone, textContent: person.phone, dir: 'ltr'}), ' · ');
            facts.append(tr('last contact', 'آخر تواصل') + ' ' + day(person.last_contact));
            li.append(head, badges, facts);
            if (person.profile_id && person.sources.shares) {
                const button = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Open shared entries', 'افتح الوثائق المشاركة')});
                button.setAttribute('aria-label', `${tr('Open shared entries', 'افتح الوثائق المشاركة')}: ${person.name}`);
                button.addEventListener('click', () => openPatient(person.profile_id, button));
                li.append(el('div', {className: 'actions'}, button));
            }
            return li;
        }) : [el('li', {className: 'empty-row', textContent: $('search').value.trim()
            ? tr('Nobody found. Search by name, mobile number or SyriaHC number.', 'لم يُعثر على أحد. ابحث بالاسم أو رقم الجوال أو رقم صحة تك.')
            : tr('No patients yet. They appear here after an appointment, a scanned lab slip or a share.', 'لا يوجد مرضى بعد. يظهرون هنا بعد موعد أو ورقة تحليل ممسوحة أو مشاركة.')})]));
        renderOpened();
    }

    // ---- One shared profile ----

    async function openPatient(id, button) {
        if (!secondFactor) {
            open = id;
            $('confirmBox').scrollIntoView({block: 'nearest'});
            return $('confirmHeading').focus();
        }
        if (button) busy(button, true);
        const res = await api(`/api/doctor/patients/${id}`);
        if (button) busy(button, false);
        if (res.data?.error === 'second_factor_required') {
            secondFactor = false;
            open = id;
            return render();
        }
        if (!res.ok) return showError('pageError', res.data.error === 'not_found'
            ? {error: 'not_found', message: tr('This patient does not share anything with you (any more).', 'لا يشارك هذا المريض معك أي شيء (بعد الآن).')} : res.data);
        opened = res.data;
        renderOpened();
        $('openedHeading').focus();
    }

    function renderOpened() {
        $('opened').hidden = !opened;
        if (!opened) return;
        const p = opened.patient;
        $('openedHeading').textContent = p.name;
        $('openedFacts').replaceChildren(el('bdi', {textContent: p.patient_number, dir: 'ltr'}), p.birth_date ? ` · ${tr('born', 'مواليد')} ${day(p.birth_date)}` : '');
        $('openedItems').replaceChildren(...opened.items.map(item => {
            const row = el('li', {className: 'appt'});
            row.append(el('h3', {}, el('bdi', {textContent: item.title})),
                el('p', {className: 'muted-small', textContent: [day(item.document_date || item.created_at), item.lab_name, `${tr('shared until', 'مشاركة حتى')} ${day(item.shared_until)}`].filter(Boolean).join(' · ')}));
            const pages = el('p');
            for (let n = 1; n <= Math.max(1, item.pages); n++) {
                const link = el('a', {href: `/api/doctor/shared/${item.id}/pages/${n}`, target: '_blank', rel: 'noopener', textContent: tr(`Page ${n}`, `الصفحة ${n}`)});
                link.setAttribute('aria-label', `${item.title}, ${tr(`page ${n}`, `الصفحة ${n}`)}`);
                pages.append(link, ' ');
            }
            row.append(pages);
            if (item.has_values) row.append(Shc.valuesButton(`/api/doctor/shared/${item.id}/values`, item.title));
            return row;
        }));
    }

    // ---- Confirmation code ----

    function renderConfirm() {
        $('codeStep').hidden = !challenge;
        $('sendCode').textContent = challenge ? tr('Send a new code', 'أرسل رمزاً جديداً') : tr('Send me a code', 'أرسل لي رمزاً');
    }

    $('sendCode').addEventListener('click', async () => {
        $('confirmError').hidden = true;
        busy($('sendCode'), true);
        const res = await api('/api/auth/step-up/request', {});
        busy($('sendCode'), false);
        if (!res.ok) return showError('confirmError', res.data);
        challenge = res.data.challenge;
        renderConfirm();
        $('codeSent').textContent = tr(`We sent a code to ${res.data.email_hint}. It is valid for ${res.data.expires_in_minutes} minutes.`,
            `أرسلنا رمزاً إلى ${res.data.email_hint}. الرمز صالح لمدة ${res.data.expires_in_minutes} دقائق.`);
        $('stepCode').focus();
    });

    $('codeStep').addEventListener('submit', async event => {
        event.preventDefault();
        $('confirmError').hidden = true;
        busy($('confirmButton'), true);
        const res = await api('/api/auth/step-up/verify', {challenge, code: $('stepCode').value.replace(/\D/g, ''), remember: $('remember').checked});
        busy($('confirmButton'), false);
        if (!res.ok) return showError('confirmError', res.data);
        secondFactor = true;
        challenge = null;
        $('stepCode').value = '';
        await afterConfirm();
    });

    async function afterConfirm() {
        if (redeem) {
            const code = redeem;
            redeem = null;
            const res = await api('/api/doctor/share-codes/redeem', {code});
            if (!res.ok) showError('pageError', res.data);
            else open = res.data.patient_id;
        }
        await load();
        if (open) {
            const id = open;
            open = null;
            await openPatient(id);
        } else {
            $('searchHeading').focus();
        }
    }

    let debounce = null;
    $('search').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(load, 300); });
    $('searchForm').addEventListener('submit', event => { event.preventDefault(); load(); });
    $('closeOpened').addEventListener('click', () => { opened = null; renderOpened(); $('searchHeading').focus(); });
    document.addEventListener('shc:language', render);

    await load();
    if (secondFactor && (redeem || open)) await afterConfirm();
    else if (!secondFactor && (redeem || open)) $('confirmHeading').focus();
});
