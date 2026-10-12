// Admin: review doctors, open their documents, approve / ask for changes / suspend.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const STATUSES = {pending: ['Waiting for review', 'بانتظار المراجعة'], approved: ['Approved', 'معتمد'], rejected: ['Changes requested', 'مطلوب تعديلات'],
        suspended: ['Suspended', 'موقوف'], draft: ['Not sent yet', 'لم يُرسل بعد']};
    const FIELD_LABELS = [['email', 'Email', 'البريد الإلكتروني'], ['specialty', 'Specialty', 'الاختصاص'], ['governorate', 'Governorate', 'المحافظة'],
        ['area', 'City or area', 'المدينة أو المنطقة'], ['clinic_name', 'Clinic', 'العيادة'], ['clinic_address', 'Address', 'العنوان'],
        ['clinic_phone', 'Clinic phone', 'هاتف العيادة'], ['licence_number', 'Licence number', 'رقم الترخيص'], ['bio', 'Introduction', 'النبذة']];
    const ACTIONS = {'doctor.registered': ['Account created', 'إنشاء الحساب'], 'doctor.submitted': ['Sent for review', 'أُرسل للمراجعة'],
        'doctor.approved': ['Approved', 'اعتُمد'], 'doctor.rejected': ['Changes requested', 'طُلبت تعديلات'], 'doctor.suspended': ['Suspended', 'أُوقف'],
        'doctor.changed_after_approval': ['Edited after approval', 'عُدّل بعد الاعتماد'], 'document.uploaded': ['Document uploaded', 'رُفعت وثيقة'],
        'document.deleted': ['Document removed', 'حُذفت وثيقة'], 'document.viewed': ['Document opened', 'فُتحت وثيقة']};
    const KINDS = {licence: ['Licence to practise', 'ترخيص مزاولة المهنة'], syndicate: ['Syndicate card', 'بطاقة النقابة'], other: ['Other document', 'وثيقة أخرى']};
    let status = 'pending', list = null, current = null, catalog = null;

    const cat = await api('/api/catalog');
    catalog = cat.data;
    const label = (group, key) => key && catalog?.[group]?.[key] ? tr(...catalog[group][key]) : (key || '—');
    const when = iso => iso ? new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {dateStyle: 'medium', timeStyle: 'short'}) : '—';
    const el = (tag, text, cls) => Object.assign(document.createElement(tag), text !== undefined ? {textContent: text} : {}, cls ? {className: cls} : {});

    async function loadList() {
        const res = await api('/api/admin/doctors?status=' + status);
        if (res.status === 401) return window.location.assign('/staff');
        if (res.status === 403) return window.location.assign('/account');
        list = res.data;
        renderList();
    }

    function renderTabs() {
        $('statusTabs').replaceChildren(...Object.keys(STATUSES).map(s => {
            const b = el('button', `${tr(...STATUSES[s])} (${list?.counts?.[s] || 0})`);
            b.type = 'button';
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', String(s === status));
            b.onclick = () => { status = s; current = null; loadList(); };
            return b;
        }));
    }

    function renderList() {
        renderTabs();
        $('detail').hidden = true;
        $('listPanel').hidden = false;
        const rows = list.doctors;
        $('doctorTable').hidden = !rows.length;
        $('listEmpty').hidden = rows.length > 0;
        $('listEmpty').textContent = tr('No doctors in this group.', 'لا يوجد أطباء في هذه الفئة.');
        $('doctorRows').replaceChildren(...rows.map(d => {
            const tr_ = el('tr'), name = el('td'), strong = el('strong', d.name);
            strong.dir = 'auto';
            name.append(strong, el('br'), el('span', d.email, 'muted-small'));
            const open = el('button', tr('Review', 'مراجعة'), 'btn ghost');
            open.type = 'button';
            open.setAttribute('aria-label', tr('Review ', 'مراجعة ') + d.name);
            open.onclick = () => openDoctor(d.id);
            const action = el('td');
            action.append(open);
            tr_.append(name, el('td', label('specialties', d.specialty)), el('td', label('governorates', d.governorate)),
                el('td', when(d.submitted_at)), el('td', String(d.documents)), action);
            return tr_;
        }));
    }

    async function openDoctor(id) {
        const res = await api('/api/admin/doctors/' + id);
        if (!res.ok) return;
        current = res.data;
        renderDetail();
        $('detail').focus();
    }

    function renderDetail() {
        const {doctor, profile, documents, history} = current;
        $('listPanel').hidden = true;
        $('detail').hidden = false;
        $('decisionError').hidden = true;
        $('detailName').textContent = doctor.name;
        $('detailStatus').replaceChildren(el('span', tr(...STATUSES[profile.status]), 'pill' + (profile.status === 'approved' ? '' : ' wait')));
        if (profile.review_note) $('detailStatus').append(el('span', ' ' + profile.review_note));
        const values = {...profile, email: doctor.email, specialty: label('specialties', profile.specialty), governorate: label('governorates', profile.governorate)};
        $('detailFields').replaceChildren(...FIELD_LABELS.flatMap(([key, en, ar]) => {
            const dd = el('dd', values[key] || '—');
            dd.dir = ['email', 'clinic_phone', 'licence_number'].includes(key) ? 'ltr' : 'auto';
            return [el('dt', tr(en, ar)), dd];
        }));
        $('detailDocs').replaceChildren(...(documents.length ? documents.map(d => {
            const li = el('li'), a = el('a', d.filename);
            a.href = '/api/admin/documents/' + d.id;
            a.target = '_blank';
            a.rel = 'noopener';
            a.dir = 'auto';
            li.append(a, el('span', `${tr(...KINDS[d.kind])} · ${Math.max(1, Math.round(d.size_bytes / 1024))} KB`, 'muted-small'));
            return li;
        }) : [el('li', tr('No documents uploaded.', 'لا توجد وثائق.'), 'empty-row')]));
        $('approve').hidden = !['pending', 'suspended'].includes(profile.status);
        $('reject').hidden = profile.status !== 'pending';
        $('suspend').hidden = profile.status !== 'approved';
        $('decisionForm').hidden = $('approve').hidden && $('reject').hidden && $('suspend').hidden;
        $('history').replaceChildren(...history.map(h => {
            const li = el('li');
            li.append(el('time', when(h.created_at)), el('span', ' ' + (ACTIONS[h.action] ? tr(...ACTIONS[h.action]) : h.action) + (h.actor_name ? ' · ' + h.actor_name : '')));
            if (h.details?.note) li.append(el('q', h.details.note));
            return li;
        }));
    }

    async function decide(action) {
        $('decisionError').hidden = true;
        const button = $(action);
        busy(button, true);
        const res = await api(`/api/admin/doctors/${current.doctor.id}/${action}`, {note: $('note').value});
        busy(button, false);
        if (!res.ok) return showError('decisionError', res.data);
        $('note').value = '';
        await openDoctor(current.doctor.id);
        const refreshed = await api('/api/admin/doctors?status=' + status);
        if (refreshed.ok) {
            list = refreshed.data;
            renderTabs();
        }
    }
    ['approve', 'reject', 'suspend'].forEach(a => $(a).addEventListener('click', () => decide(a)));
    $('backToList').addEventListener('click', () => { current = null; loadList(); });
    document.addEventListener('shc:language', () => current ? renderDetail() : list && renderList());
    loadList();
});
