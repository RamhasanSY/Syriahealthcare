// Booking: pick a day and a free time, then request the appointment (signing in first if needed).
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const params = new URLSearchParams(window.location.search);
    const doctorId = params.get('doctor') || '';
    const TZ = 'Asia/Damascus';
    let doctor, me = null, catalog, slots = [], from = null, days = 14, day = null, chosen = params.get('slot');
    const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const dayName = (date, style = 'short') => new Date(date + 'T12:00:00Z').toLocaleDateString(locale(), {weekday: style, day: 'numeric', month: style === 'short' ? 'short' : 'long', timeZone: 'UTC'});
    const timeOf = iso => new Date(iso).toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit', timeZone: TZ});

    const [d, m, c] = await Promise.all([api('/api/doctors/' + encodeURIComponent(doctorId)), api('/api/me'), api('/api/catalog')]);
    $('main').setAttribute('aria-busy', 'false');
    if (!d.ok) {
        $('notFound').hidden = false;
        return;
    }
    doctor = d.data.doctor;
    me = m.ok ? m.data.user : null;
    catalog = c.data;
    // Parents with children's profiles in their health file can book for a child (subject_id).
    let profiles = [], subject = null;
    if (me?.role === 'patient') {
        const file = await api('/api/file');
        if (file.ok) profiles = file.data.profiles;
    }

    async function loadSlots(start) {
        const res = await api(`/api/doctors/${doctorId}/slots?days=${days}` + (start ? `&from=${start}` : ''));
        if (!res.ok) return;
        from = res.data.from;
        slots = res.data.slots;
        if (chosen && !slots.some(s => s.starts_at === chosen)) chosen = null;
        day = chosen ? slots.find(s => s.starts_at === chosen).date : slots[0]?.date || null;
        render();
    }

    function renderDoctor() {
        $('docName').textContent = doctor.name;
        $('docSpecialty').textContent = catalog.specialties[doctor.specialty] ? tr(...catalog.specialties[doctor.specialty]) : '';
        const gov = catalog.governorates[doctor.governorate] ? tr(...catalog.governorates[doctor.governorate]) : '';
        $('docClinic').textContent = [doctor.clinic_name, doctor.clinic_address, doctor.area, gov].filter(Boolean).join(' · ');
        $('docBio').hidden = !doctor.bio;
        $('docBio').textContent = doctor.bio || '';
        document.title = `${doctor.name} — ${tr('Book an appointment', 'احجز موعداً')}`;
    }

    function renderForWhom() {
        const children = profiles.filter(p => p.relationship === 'child'), self = profiles.find(p => p.relationship === 'self');
        $('forWhom').hidden = !children.length;
        if (!children.length) return;
        const option = (id, ...text) => {
            const label = el('label', {className: 'check'});
            const input = el('input', {type: 'radio', name: 'forWhom', value: id, checked: (subject || '') === id});
            input.addEventListener('change', () => { subject = id || null; loadShareItems(); });
            const span = el('span');
            span.append(...text);
            label.append(input, span);
            return label;
        };
        $('forWhomList').replaceChildren(option('', tr('Me', 'أنا'), ...(self ? [' (', el('bdi', {textContent: self.name}), ')'] : [])),
            ...children.map(child => option(child.id, el('bdi', {textContent: child.name}))));
    }

    // Optional: entries of the chosen profile's health file to share with this doctor (stage 2c).
    let shareItems = [], shareTicket = 0;
    async function loadShareItems() {
        const ticket = ++shareTicket;
        const p = subject ? profiles.find(x => x.id === subject) : profiles.find(x => x.relationship === 'self');
        shareItems = [];
        if (p?.consent) {
            const res = await api(`/api/file/profiles/${p.id}/items`);
            if (ticket !== shareTicket) return;
            if (res.ok) shareItems = res.data.items;
        }
        renderShareItems();
    }
    function renderShareItems() {
        $('shareOnBook').hidden = !shareItems.length;
        const date = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Damascus'});
        const checked = new Set([...$('shareList').querySelectorAll('input:checked')].map(i => i.value));
        $('shareList').replaceChildren(...shareItems.map(item => {
            const box = el('input', {type: 'checkbox', value: item.id, id: 'book-share-' + item.id, checked: checked.has(item.id)});
            const label = el('label', {className: 'check', htmlFor: box.id});
            const text = el('span');
            text.append(el('bdi', {textContent: item.title}), ` · ${date(item.document_date || item.created_at)}`);
            label.append(box, text);
            return label;
        }));
    }

    function radio(button, checked) {
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', String(checked));
        button.tabIndex = checked ? 0 : -1;
    }

    function render() {
        renderDoctor();
        $('slotHint').textContent = tr(`Appointments last ${doctor.slot_minutes} minutes. Times are Syria time.`, `مدة الموعد ${doctor.slot_minutes} دقيقة. الأوقات بتوقيت سوريا.`);
        const dates = [];
        for (let i = 0; i < days; i++) dates.push(new Date(Date.parse(from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));
        const counts = new Map();
        slots.forEach(s => counts.set(s.date, (counts.get(s.date) || 0) + 1));
        $('days').replaceChildren(...dates.map(date => {
            const n = counts.get(date) || 0, b = el('button', {type: 'button', className: 'day-chip', disabled: !n});
            b.append(el('strong', {textContent: dayName(date)}), el('span', {textContent: n ? tr(`${n} free`, `${n} متاح`) : tr('Full / closed', 'لا مواعيد')}));
            radio(b, date === day);
            b.onclick = () => { day = date; chosen = null; render(); $('times').querySelector('button')?.focus(); };
            return b;
        }));
        // Keep the selected day visible in the scrolling strip (sideways only, the page does not move).
        const strip = $('days'), picked = strip.querySelector('[aria-checked=true]');
        if (picked) {
            const box = strip.getBoundingClientRect(), item = picked.getBoundingClientRect();
            if (item.left < box.left || item.right > box.right) strip.scrollLeft += item.left - box.left - (box.width - item.width) / 2;
        }
        const todays = slots.filter(s => s.date === day);
        $('times').replaceChildren(...(todays.length ? todays.map(s => {
            const b = el('button', {type: 'button', className: 'chip time-chip', textContent: timeOf(s.starts_at)});
            radio(b, s.starts_at === chosen);
            b.onclick = () => { chosen = s.starts_at; render(); $(me?.role === 'patient' ? 'bookButton' : 'signInLink')?.focus(); };
            return b;
        }) : [el('p', {className: 'empty-row', textContent: slots.length ? '' : tr('No free times in these days. Try later days.', 'لا توجد أوقات متاحة في هذه الأيام. جرّب أياماً لاحقة.')})]));
        const slot = slots.find(s => s.starts_at === chosen);
        $('chosen').textContent = slot ? `${dayName(slot.date, 'long')} · ${timeOf(slot.starts_at)}` : tr('Choose a time on the left.', 'اختر وقتاً من القائمة.');
        $('bookButton').disabled = !slot;
        $('signInFirst').hidden = Boolean(me);
        $('notPatient').hidden = !me || me.role === 'patient';
        $('bookForm').hidden = me?.role !== 'patient';
        renderForWhom();
        const back = `/book?doctor=${encodeURIComponent(doctorId)}` + (chosen ? `&slot=${encodeURIComponent(chosen)}` : '');
        $('signInLink').href = '/login?next=' + encodeURIComponent(back);
    }

    // Arrow keys move between days and between times, like radio buttons.
    for (const id of ['days', 'times']) {
        $(id).addEventListener('keydown', e => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
            const items = [...$(id).querySelectorAll('button:not([disabled])')], i = items.indexOf(document.activeElement);
            if (i < 0) return;
            e.preventDefault();
            const forward = ['ArrowDown', Shc.lang === 'ar' ? 'ArrowLeft' : 'ArrowRight'].includes(e.key);
            items[(i + (forward ? 1 : -1) + items.length) % items.length].focus();
        });
    }

    $('moreDays').addEventListener('click', () => loadSlots(new Date(Date.parse(from + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10)));

    $('bookForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('bookError').hidden = true;
        busy($('bookButton'), true);
        const shared = [...$('shareList').querySelectorAll('input:checked')].map(i => i.value);
        const res = await api('/api/appointments', {doctor_id: doctorId, starts_at: chosen, reason: $('reason').value, ...(subject && {subject_id: subject}),
            ...(shared.length && {share_item_ids: shared})});
        busy($('bookButton'), false);
        if (!res.ok) {
            showError('bookError', res.data);
            if (res.data.error === 'slot_taken') await loadSlots(from);
            return;
        }
        const slot = slots.find(s => s.starts_at === chosen);
        $('booking').hidden = true;
        $('done').hidden = false;
        $('doneText').textContent = tr(`Your request for ${dayName(slot.date, 'long')} at ${timeOf(slot.starts_at)} with ${doctor.name} has been sent. You can follow it under "My appointments", where it shows as confirmed once the doctor accepts.`,
            `أُرسل طلبك لموعد ${dayName(slot.date, 'long')} الساعة ${timeOf(slot.starts_at)} لدى ${doctor.name}. يمكنك متابعته في «مواعيدي»، وسيظهر مؤكداً عند قبول الطبيب.`);
        const child = profiles.find(p => p.id === subject);
        if (child) $('doneText').textContent += tr(` The appointment is for ${child.name}.`, ` الموعد لـ ${child.name}.`);
        if (shared.length) $('doneText').textContent += tr(` ${shared.length} entries of the health file are shared with the doctor until 30 days after the appointment.`,
            ` شاركت ${shared.length} وثائق من الملف الصحي مع الطبيب حتى 30 يوماً بعد الموعد.`);
        $('done').focus();
    });

    document.addEventListener('shc:language', () => { render(); renderShareItems(); });
    $('booking').hidden = false;
    if (me?.role === 'patient') loadShareItems();
    await loadSlots();
});
