// Admin: review doctors and facilities (labs, imaging, hospitals, clinics), open their documents, approve / ask for changes / suspend.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const STATUSES = {pending: ['Waiting for review', 'بانتظار المراجعة'], approved: ['Approved', 'معتمد'], rejected: ['Changes requested', 'مطلوب تعديلات'],
        suspended: ['Suspended', 'موقوف'], draft: ['Not sent yet', 'لم يُرسل بعد']};
    // The two groups share the review flow; they differ in endpoints, columns and fields.
    const GROUPS = {
        doctors: {
            api: '/api/admin/doctors', list: 'doctors', one: 'doctor', name: ['Doctor', 'الطبيب'], type: ['Specialty', 'الاختصاص'],
            empty: ['No doctors in this group.', 'لا يوجد أطباء في هذه الفئة.'],
            rowName: d => d.name, rowType: d => label('specialties', d.specialty),
            fields: [['email', 'Email', 'البريد الإلكتروني'], ['specialty', 'Specialty', 'الاختصاص'], ['governorate', 'Governorate', 'المحافظة'],
                ['area', 'City or area', 'المدينة أو المنطقة'], ['clinic_name', 'Clinic', 'العيادة'], ['clinic_address', 'Address', 'العنوان'],
                ['clinic_phone', 'Clinic phone', 'هاتف العيادة'], ['licence_number', 'Licence number', 'رقم الترخيص'], ['bio', 'Introduction', 'النبذة']],
            values: ({doctor, profile}) => ({...profile, email: doctor.email, specialty: label('specialties', profile.specialty), governorate: label('governorates', profile.governorate)}),
            title: ({doctor}) => doctor.name
        },
        facilities: {
            api: '/api/admin/facilities', list: 'facilities', one: 'facility', name: ['Facility', 'المنشأة'], type: ['Type', 'النوع'],
            empty: ['No facilities in this group.', 'لا توجد منشآت في هذه الفئة.'],
            rowName: f => f.facility_name || tr('(no name yet)', '(بلا اسم بعد)'), rowType: f => label('facilityKinds', f.kind),
            fields: [['kind', 'Type', 'النوع'], ['contact', 'Contact person', 'الشخص المسؤول'], ['email', 'Email', 'البريد الإلكتروني'],
                ['governorate', 'Governorate', 'المحافظة'], ['area', 'City or area', 'المدينة أو المنطقة'], ['address', 'Address', 'العنوان'],
                ['phone', 'Phone', 'الهاتف'], ['licence_number', 'Licence number', 'رقم الترخيص'], ['services', 'Services', 'الخدمات'],
                ['emergency', 'Emergency department', 'قسم إسعاف'], ['opening_hours', 'Opening hours', 'أوقات الدوام'], ['description', 'Description', 'الوصف']],
            values: ({facility, profile}) => ({...profile, contact: facility.name, email: facility.email, kind: label('facilityKinds', profile.kind),
                governorate: label('governorates', profile.governorate),
                services: profile.services.map(s => catalog?.facilityServices?.[profile.kind]?.[s] ? tr(...catalog.facilityServices[profile.kind][s]) : s).join(tr(', ', '، ')),
                emergency: ['hospital', 'clinic'].includes(profile.kind) ? (profile.emergency ? tr('Yes', 'نعم') : tr('No', 'لا')) : ''}),
            title: ({facility, profile}) => profile.facility_name || facility.name
        }
    };
    const ACTIONS = {'doctor.registered': ['Account created', 'إنشاء الحساب'], 'doctor.submitted': ['Sent for review', 'أُرسل للمراجعة'],
        'doctor.approved': ['Approved', 'اعتُمد'], 'doctor.rejected': ['Changes requested', 'طُلبت تعديلات'], 'doctor.suspended': ['Suspended', 'أُوقف'],
        'doctor.changed_after_approval': ['Edited after approval', 'عُدّل بعد الاعتماد'], 'document.uploaded': ['Document uploaded', 'رُفعت وثيقة'],
        'document.deleted': ['Document removed', 'حُذفت وثيقة'], 'document.viewed': ['Document opened', 'فُتحت وثيقة'],
        'facility.registered': ['Account created', 'إنشاء الحساب'], 'facility.submitted': ['Sent for review', 'أُرسل للمراجعة'],
        'facility.approved': ['Approved', 'اعتُمد'], 'facility.rejected': ['Changes requested', 'طُلبت تعديلات'], 'facility.suspended': ['Suspended', 'أُوقف'],
        'facility.changed_after_approval': ['Edited after approval', 'عُدّل بعد الاعتماد']};
    const KINDS = {licence: ['Licence', 'الترخيص'], syndicate: ['Syndicate card', 'بطاقة النقابة'], other: ['Other document', 'وثيقة أخرى']};
    let group = window.location.hash === '#facilities' ? 'facilities' : 'doctors';
    let status = 'pending', list = null, current = null, catalog = null;
    const G = () => GROUPS[group];

    const cat = await api('/api/catalog');
    catalog = cat.data;
    const label = (group, key) => key && catalog?.[group]?.[key] ? tr(...catalog[group][key]) : (key || '—');
    const when = iso => iso ? new Date(iso).toLocaleString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {dateStyle: 'medium', timeStyle: 'short'}) : '—';
    const el = (tag, text, cls) => Object.assign(document.createElement(tag), text !== undefined ? {textContent: text} : {}, cls ? {className: cls} : {});

    async function loadList() {
        const res = await api(`${G().api}?status=${status}`);
        if (res.status === 401) return window.location.assign('/staff');
        if (res.status === 403) return window.location.assign('/account');
        list = res.data;
        renderList();
    }

    function renderGroups() {
        document.querySelectorAll('#groupTabs [data-group]').forEach(b => {
            b.setAttribute('aria-selected', String(b.dataset.group === group));
            b.onclick = () => {
                if (group === b.dataset.group) return;
                group = b.dataset.group;
                history.replaceState(null, '', group === 'facilities' ? '#facilities' : '#');
                status = 'pending';
                current = null;
                list = null;
                renderGroups();
                loadList();
            };
        });
        $('colName').textContent = tr(...G().name);
        $('colType').textContent = tr(...G().type);
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
        renderGroups();
        const rows = list[G().list];
        $('doctorTable').hidden = !rows.length;
        $('listEmpty').hidden = rows.length > 0;
        $('listEmpty').textContent = tr(...G().empty);
        $('doctorRows').replaceChildren(...rows.map(d => {
            const tr_ = el('tr'), name = el('td'), strong = el('strong', G().rowName(d));
            strong.dir = 'auto';
            name.append(strong, el('br'), el('span', d.email, 'muted-small'));
            const open = el('button', tr('Review', 'مراجعة'), 'btn ghost');
            open.type = 'button';
            open.setAttribute('aria-label', tr('Review ', 'مراجعة ') + G().rowName(d));
            open.onclick = () => openDoctor(d.id);
            const action = el('td');
            action.append(open);
            tr_.append(name, el('td', G().rowType(d)), el('td', label('governorates', d.governorate)),
                el('td', when(d.submitted_at)), el('td', String(d.documents)), action);
            return tr_;
        }));
    }

    async function openDoctor(id) {
        const res = await api(`${G().api}/${id}`);
        if (!res.ok) return;
        current = res.data;
        renderDetail();
        $('detail').focus();
    }

    function renderDetail() {
        const {profile, documents, history} = current;
        $('listPanel').hidden = true;
        $('detail').hidden = false;
        $('decisionError').hidden = true;
        $('detailName').textContent = G().title(current);
        $('detailStatus').replaceChildren(el('span', tr(...STATUSES[profile.status]), 'pill' + (profile.status === 'approved' ? '' : ' wait')));
        if (profile.review_note) $('detailStatus').append(el('span', ' ' + profile.review_note));
        const values = G().values(current);
        $('detailFields').replaceChildren(...G().fields.filter(([key]) => key !== 'emergency' || values.emergency).flatMap(([key, en, ar]) => {
            const dd = el('dd', values[key] || '—');
            dd.dir = ['email', 'clinic_phone', 'phone', 'licence_number'].includes(key) ? 'ltr' : 'auto';
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
        const id = current[G().one].id;
        const res = await api(`${G().api}/${id}/${action}`, {note: $('note').value});
        busy(button, false);
        if (!res.ok) return showError('decisionError', res.data);
        $('note').value = '';
        await openDoctor(id);
        const refreshed = await api(`${G().api}?status=${status}`);
        if (refreshed.ok) {
            list = refreshed.data;
            renderTabs();
        }
    }
    ['approve', 'reject', 'suspend'].forEach(a => $(a).addEventListener('click', () => decide(a)));
    $('backToList').addEventListener('click', () => { current = null; loadList(); });
    document.addEventListener('shc:language', () => { renderGroups(); current ? renderDetail() : list && renderList(); });
    renderGroups();
    loadList();
});
