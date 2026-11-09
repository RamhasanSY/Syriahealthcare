// Health file, stage 2c: share chosen entries with a doctor (from the directory, or as a QR code for 15 minutes),
// and see who has access and who opened what. Works next to file.js, which announces the profile on screen
// with the event "shc:profile". Nothing is stored on the phone.
document.addEventListener('DOMContentLoaded', () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});
    const moment = iso => new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Damascus'});

    let profile = null, entries = [], access = null, catalog = null, doctors = [], chosenDoctor = null, mode = 'doctor', qr = null, timer = null, searchTicket = 0;
    let status = null;  // () => text of the last action, re-translated on language change

    document.addEventListener('shc:profile', event => {
        const next = event.detail.profile;
        const changed = next?.id !== profile?.id;
        profile = next;
        if (changed) closeForm();
        $('shareBox').hidden = $('accessBox').hidden = !profile?.consent;
        if (profile?.consent) loadAccess();
        renderAll();
    });

    // ---- Who has access ----

    async function loadAccess() {
        const id = profile.id;
        const res = await api(`/api/file/profiles/${id}/access`);
        if (id !== profile?.id) return;
        if (!res.ok) return showError('accessError', res.data);
        access = res.data;
        renderAccess();
    }

    const SOURCES = {directory: ['shared from the directory', 'مشاركة من دليل الأطباء'], booking: ['shared when booking', 'مشاركة عند الحجز'], qr: ['shown as QR code', 'عُرضت كرمز QR']};
    const LOG = {
        'health_document.viewed': ['opened', 'فتح'], 'health_document.read': ['opened', 'فتح'], 'health_file.opened': ['looked at the shared list', 'اطّلع على قائمة المشاركة'],
        'health_file.share_code_used': ['scanned your QR code', 'مسح رمز QR الخاص بك'], 'health_file.searched': ['searched the shared entries', 'بحث في الوثائق المشاركة']
    };
    const specialty = d => d.specialty ? ` · ${tr(...d.specialty)}` : '';

    function renderAccess() {
        if (!access) return;
        const active = access.shares.filter(s => s.active), ended = access.shares.filter(s => !s.active).slice(0, 5);
        $('accessShares').replaceChildren(...(active.length ? active.map(share => {
            const li = el('li', {className: 'appt'});
            const head = el('div', {className: 'appt-head'});
            head.append(el('h3', {}, el('bdi', {textContent: share.doctor.name})), el('span', {className: 'pill ok', textContent: tr('Active', 'فعّالة')}));
            const info = el('p', {className: 'muted-small', textContent: `${tr(...SOURCES[share.source])}${specialty(share.doctor)} · ${tr('until', 'حتى')} ${day(share.expires_at)}`});
            const list = el('ul', {className: 'doc-list'});
            list.append(...share.items.map(item => {
                const row = el('li', {}, el('bdi', {textContent: item.title}));
                if (item.revoked) row.append(el('span', {className: 'muted-small', textContent: ' ' + tr('(removed)', '(أُزيلت)')}));
                else if (share.items.filter(i => !i.revoked).length > 1) {
                    const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Remove', 'أزل')});
                    remove.setAttribute('aria-label', `${tr('Remove from this share', 'أزل من هذه المشاركة')}: ${item.title}`);
                    remove.addEventListener('click', () => revoke(`/api/file/shares/${share.id}/items/${item.id}/revoke`, remove,
                        () => tr(`${item.title} is no longer shared with ${share.doctor.name}.`, `لم تعد «${item.title}» مشاركة مع ${share.doctor.name}.`)));
                    row.append(remove);
                }
                return row;
            }));
            const end = el('button', {type: 'button', className: 'btn danger', textContent: tr('End share now', 'أنهِ المشاركة الآن')});
            end.setAttribute('aria-label', `${tr('End share now', 'أنهِ المشاركة الآن')}: ${share.doctor.name}`);
            end.addEventListener('click', () => revoke(`/api/file/shares/${share.id}/revoke`, end,
                () => tr(`${share.doctor.name} can no longer open these entries.`, `لم يعد بإمكان ${share.doctor.name} فتح هذه الوثائق.`)));
            li.append(head, info, list, el('div', {className: 'actions'}, end));
            return li;
        }) : [el('li', {className: 'empty-row', textContent: tr('No doctor has access to this file right now.', 'لا يملك أي طبيب وصولاً إلى هذا الملف حالياً.')})]));
        $('accessEnded').hidden = !ended.length;
        $('accessEndedList').replaceChildren(...ended.map(share => el('li', {textContent:
            `${share.doctor.name} · ${share.items.length} ${tr('entries', 'وثائق')} · ${share.revoked_at ? tr('ended by you on', 'أنهيتها في') + ' ' + day(share.revoked_at) : tr('expired on', 'انتهت في') + ' ' + day(share.expires_at)}`})));

        const scans = access.scans.filter(s => !s.revoked_at);
        $('accessScansBox').hidden = !scans.length;
        $('accessScans').replaceChildren(...scans.map(scan => {
            const row = el('li', {}, el('span', {}, el('bdi', {textContent: scan.doctor.name}), ` · ${tr('scanned the slip of', 'مسح ورقة')} `, el('bdi', {textContent: scan.title})));
            const back = el('button', {type: 'button', className: 'link-btn', textContent: tr('Take back', 'استرجع')});
            back.setAttribute('aria-label', `${tr('Take back from', 'استرجع من')} ${scan.doctor.name}: ${scan.title}`);
            back.addEventListener('click', () => revoke(`/api/file/scans/${scan.result_id}/revoke`, back,
                () => tr(`${scan.doctor.name} can no longer open ${scan.title}.`, `لم يعد بإمكان ${scan.doctor.name} فتح «${scan.title}».`), {doctor_id: scan.doctor.id}));
            row.append(back);
            return row;
        }));

        $('accessLog').replaceChildren(...(access.log.length ? access.log.slice(0, 50).map(entry => el('li', {},
            el('time', {dateTime: entry.at, textContent: moment(entry.at)}), ' ', el('bdi', {textContent: entry.doctor_name}), ' ',
            document.createTextNode(LOG[entry.action] ? tr(...LOG[entry.action]) : entry.action),
            ...(entry.title ? [' «', el('bdi', {textContent: entry.title}), '»'] : []))) : [el('li', {className: 'empty-row', textContent: tr('Nobody has opened this file yet.', 'لم يفتح أحد هذا الملف بعد.')})]));
    }

    async function revoke(url, button, done, body = {}) {
        busy(button, true);
        const res = await api(url, body);
        busy(button, false);
        if (!res.ok) return showError('accessError', res.data);
        status = done;
        renderStatus();
        await loadAccess();
        $('accessHeading').focus();
    }

    // ---- Share form ----

    async function openForm() {
        $('shareForm').hidden = false;
        $('shareToggle').setAttribute('aria-expanded', 'true');
        $('shareError').hidden = true;
        const res = await api(`/api/file/profiles/${profile.id}/items`);
        if (!res.ok) return showError('shareError', res.data);
        entries = res.data.items;
        if (!catalog) {
            const c = await api('/api/catalog');
            if (c.ok) catalog = c.data;
        }
        renderEntries();
        renderMode();
        $('shareHeading').focus();
    }

    function closeForm() {
        $('shareForm').hidden = true;
        $('shareToggle').setAttribute('aria-expanded', 'false');
        chosenDoctor = null;
        doctors = [];
        $('doctorSearch').value = '';
        stopQr();
    }

    function renderEntries() {
        $('shareEntries').replaceChildren(...(entries.length ? entries.map(item => {
            const box = el('input', {type: 'checkbox', value: item.id, id: 'share-' + item.id});
            const label = el('label', {className: 'check', htmlFor: box.id});
            label.append(box, el('span', {}, el('bdi', {textContent: item.title}), ` · ${day(item.document_date || item.created_at)}`));
            return label;
        }) : [el('p', {className: 'hint', textContent: tr('This file has no entries yet.', 'لا توجد وثائق في هذا الملف بعد.')})]));
    }

    const chosenItems = () => [...$('shareEntries').querySelectorAll('input:checked')].map(box => box.value);

    function renderMode() {
        mode = $('shareModeQr').checked ? 'qr' : 'doctor';
        $('doctorFields').hidden = mode !== 'doctor';
        $('shareSubmit').textContent = mode === 'qr' ? tr('Show QR code', 'اعرض رمز QR') : tr('Share with this doctor', 'شارك مع هذا الطبيب');
    }

    async function searchDoctors() {
        const ticket = ++searchTicket, q = $('doctorSearch').value.trim();
        if (q.length < 2) {
            doctors = [];
            return renderDoctors();
        }
        const res = await api('/api/doctors?q=' + encodeURIComponent(q));
        if (ticket !== searchTicket) return;
        doctors = res.ok ? res.data.doctors.slice(0, 20) : [];
        renderDoctors();
    }

    function renderDoctors() {
        const label = d => [d.name, catalog?.specialties?.[d.specialty] ? tr(...catalog.specialties[d.specialty]) : null, d.clinic_name, d.area].filter(Boolean).join(' · ');
        $('doctorResults').replaceChildren(...doctors.map(d => {
            const radio = el('input', {type: 'radio', name: 'shareDoctor', value: d.id, id: 'doc-' + d.id, checked: chosenDoctor?.id === d.id});
            radio.addEventListener('change', () => { chosenDoctor = d; });
            const row = el('label', {className: 'check', htmlFor: radio.id});
            row.append(radio, el('bdi', {textContent: label(d)}));
            return row;
        }));
        $('doctorCount').textContent = $('doctorSearch').value.trim().length < 2 ? ''
            : doctors.length ? tr(`${doctors.length} doctors found`, `عُثر على ${doctors.length} طبيب`) : tr('No approved doctor found.', 'لم يُعثر على طبيب معتمد.');
    }

    async function submit(event) {
        event.preventDefault();
        $('shareError').hidden = true;
        const ids = chosenItems();
        if (!ids.length) return showError('shareError', {error: 'choose_entries', message: tr('Choose at least one entry.', 'اختر وثيقة واحدة على الأقل.')});
        if (mode === 'doctor' && !chosenDoctor) return showError('shareError', {error: 'choose_doctor', message: tr('Search for the doctor and choose them.', 'ابحث عن الطبيب واختره.')});
        busy($('shareSubmit'), true);
        const res = mode === 'qr'
            ? await api(`/api/file/profiles/${profile.id}/share-codes`, {item_ids: ids})
            : await api(`/api/file/profiles/${profile.id}/shares`, {doctor_id: chosenDoctor.id, item_ids: ids, days: Number($('shareDays').value)});
        busy($('shareSubmit'), false);
        if (!res.ok) return showError('shareError', res.data);
        if (mode === 'qr') return showQr(res.data);
        const name = chosenDoctor.name, until = res.data.share.expires_at, count = ids.length;
        closeForm();
        status = () => tr(`${count} entries shared with ${name} until ${day(until)}. You can end it below at any time.`,
            `شاركت ${count} وثائق مع ${name} حتى ${day(until)}. يمكنك إنهاء المشاركة أدناه في أي وقت.`);
        renderStatus();
        await loadAccess();
        $('shareStatus').focus();
    }

    // ---- QR code for 15 minutes ----

    function showQr(data) {
        qr = data;
        $('shareForm').hidden = true;
        $('qrBox').hidden = false;
        $('qrImage').src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.qr_svg);
        $('qrImage').alt = tr(`QR code ${data.code}`, `رمز QR ${data.code}`);
        $('qrCode').textContent = data.code;
        tick();
        timer = setInterval(tick, 1000);
        $('qrHeading').focus();
    }

    function tick() {
        if (!qr) return;
        const left = Math.max(0, Math.round((new Date(qr.expires_at).getTime() - Date.now()) / 1000));
        const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
        $('qrTime').textContent = left ? tr(`Valid for ${mm}:${ss} minutes. It works once.`, `صالح لمدة ${mm}:${ss} دقيقة. يعمل مرة واحدة.`)
            : tr('This code has expired. Make a new one if needed.', 'انتهت صلاحية هذا الرمز. أنشئ رمزاً جديداً عند الحاجة.');
        if (!left) stopQr(false);
    }

    function stopQr(hide = true) {
        clearInterval(timer);
        timer = null;
        if (hide) {
            qr = null;
            $('qrBox').hidden = true;
        }
    }

    function renderStatus() {
        $('shareStatus').hidden = !status;
        $('shareStatus').textContent = status ? status() : '';
    }

    function renderAll() {
        if (!profile) return;
        renderStatus();
        if (!$('shareForm').hidden) {
            renderEntries();
            renderMode();
            renderDoctors();
        }
        if (qr) tick();
        renderAccess();
    }

    $('shareToggle').addEventListener('click', () => $('shareForm').hidden ? openForm() : closeForm());
    $('shareCancel').addEventListener('click', () => { closeForm(); $('shareToggle').focus(); });
    $('shareModeDoctor').addEventListener('change', renderMode);
    $('shareModeQr').addEventListener('change', renderMode);
    let debounce = null;
    $('doctorSearch').addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(searchDoctors, 300); });
    $('shareForm').addEventListener('submit', submit);
    $('qrDone').addEventListener('click', async () => { stopQr(); await loadAccess(); $('shareToggle').focus(); });
    document.addEventListener('shc:language', renderAll);
});
