// Facility profile (lab, imaging centre, hospital, clinic): public details, operating licence, and sending for review.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TEXT = ['facility_name', 'area', 'address', 'phone', 'licence_number', 'opening_hours', 'description'];
    const LABELS = {facility_name: ['Name', 'الاسم'], governorate: ['Governorate', 'المحافظة'], area: ['City or area', 'المدينة أو المنطقة'],
        address: ['Address', 'العنوان'], phone: ['Phone', 'الهاتف'], licence_number: ['Licence number', 'رقم الترخيص']};
    const NAMES = {lab: ['Laboratory name *', 'اسم المخبر *'], imaging: ['Imaging centre name *', 'اسم مركز الأشعة *'],
        hospital: ['Hospital name *', 'اسم المشفى *'], clinic: ['Centre or clinic name *', 'اسم المركز أو المستوصف *']};
    const KINDS = {licence: ['Operating licence', 'ترخيص المنشأة'], other: ['Other document', 'وثيقة أخرى']};
    const STATUS = {
        draft: ['info', 'Not sent yet. Complete steps 1–3 below.', 'لم يُرسل بعد. أكملوا الخطوات 1–3 أدناه.'],
        pending: ['wait', 'Under review. We will let you know by email when it is checked.', 'قيد المراجعة. سنبلغكم بالبريد الإلكتروني عند الانتهاء.'],
        approved: ['ok', 'Approved. Your listing appears on syriahealthcare.com at the next daily update.', 'معتمد. تظهر منشأتكم على syriahealthcare.com مع التحديث اليومي التالي.'],
        rejected: ['error', 'Changes needed before approval:', 'مطلوب تعديلات قبل الاعتماد:'],
        suspended: ['error', 'Your listing is suspended and hidden from the website:', 'منشأتكم موقوفة ومخفية عن الموقع:']
    };
    const DOCS_OPEN = ['draft', 'pending', 'rejected'];

    const [me, cat] = await Promise.all([api('/api/facility/profile'), api('/api/catalog')]);
    $('main').setAttribute('aria-busy', 'false');
    if (!me.ok) return window.location.assign(me.status === 401 ? '/staff' : '/account');
    const state = me.data, catalog = cat.data, kind = state.profile.kind;
    let chosen = new Set(state.profile.services || []);

    function renderStatus() {
        const p = state.profile, [cls, en, ar] = STATUS[p.status];
        const box = $('statusBox');
        box.className = 'status-box ' + cls;
        box.replaceChildren(document.createTextNode(tr(en, ar)));
        if (p.review_note && ['rejected', 'suspended'].includes(p.status)) {
            const note = document.createElement('p');
            note.className = 'review-note';
            note.dir = 'auto';
            note.textContent = p.review_note;
            box.append(note);
        }
        $('profileForm').hidden = p.status === 'suspended';
        $('documentsCard').hidden = false;
        $('uploadForm').hidden = !DOCS_OPEN.includes(p.status);
        $('submitCard').hidden = !['draft', 'rejected'].includes(p.status);
        $('reviewWarning').hidden = p.status !== 'approved';
    }

    function renderForm() {
        $('pageTitle').textContent = tr('My facility', 'منشأتي') + ' · ' + tr(...catalog.facilityKinds[kind]);
        $('nameLabel').textContent = tr(...NAMES[kind]);
        const label = l => tr(l[0], l[1]);
        const select = $('governorate'), current = select.value || state.profile.governorate;
        select.replaceChildren(new Option(tr('Choose…', 'اختر…'), ''),
            ...Object.entries(catalog.governorates).sort((a, b) => label(a[1]).localeCompare(label(b[1]), Shc.lang)).map(([k, l]) => new Option(label(l), k)));
        select.value = current || '';
        $('services').replaceChildren(...Object.entries(catalog.facilityServices[kind]).map(([key, l]) => {
            const row = document.createElement('label'), box = document.createElement('input'), text = document.createElement('span');
            row.className = 'check';
            box.type = 'checkbox';
            box.value = key;
            box.checked = chosen.has(key);
            box.onchange = () => { box.checked ? chosen.add(key) : chosen.delete(key); };
            text.textContent = label(l);
            row.append(box, text);
            return row;
        }));
        $('emergencyRow').hidden = !['hospital', 'clinic'].includes(kind);
        $('descriptionCount').textContent = tr(`${$('description').value.length} / 600 characters`, `${$('description').value.length} / 600 حرف`);
    }

    function renderDocuments() {
        const docsOpen = DOCS_OPEN.includes(state.profile.status);
        $('docList').replaceChildren(...state.documents.map(d => {
            const li = document.createElement('li'), info = document.createElement('span'), name = document.createElement('strong');
            name.textContent = d.filename;
            name.dir = 'auto';
            info.append(name, document.createTextNode(` · ${tr(...(KINDS[d.kind] || KINDS.other))} · ${Math.max(1, Math.round(d.size_bytes / 1024))} KB`));
            li.append(info);
            if (docsOpen) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'link-btn';
                del.textContent = tr('Remove', 'حذف');
                del.setAttribute('aria-label', tr('Remove ', 'حذف ') + d.filename);
                del.onclick = async () => {
                    const res = await fetch('/api/facility/documents/' + d.id, {method: 'DELETE', credentials: 'same-origin'});
                    if (res.ok) {
                        state.documents = state.documents.filter(x => x.id !== d.id);
                        renderDocuments();
                        $('file').focus();
                    }
                };
                li.append(del);
            }
            return li;
        }));
        if (!state.documents.length) {
            const li = document.createElement('li');
            li.className = 'empty-row';
            li.textContent = tr('No documents uploaded yet.', 'لم تُرفع أي وثيقة بعد.');
            $('docList').append(li);
        }
    }

    function render() {
        renderStatus();
        renderForm();
        renderDocuments();
    }

    TEXT.forEach(f => { $(f).value = state.profile[f] || ''; });
    $('emergency').checked = state.profile.emergency;
    $('description').addEventListener('input', () => {
        $('descriptionCount').textContent = tr(`${$('description').value.length} / 600 characters`, `${$('description').value.length} / 600 حرف`);
    });
    document.addEventListener('shc:language', render);
    render();

    $('profileForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('profileError').hidden = true;
        $('savedNote').textContent = '';
        const body = Object.fromEntries(TEXT.map(f => [f, $(f).value]));
        Object.assign(body, {governorate: $('governorate').value, services: [...chosen], emergency: $('emergency').checked});
        busy($('saveProfile'), true);
        const res = await api('/api/facility/profile', body);
        busy($('saveProfile'), false);
        if (!res.ok) return showError('profileError', res.data);
        state.profile = res.data.profile;
        chosen = new Set(state.profile.services);
        $('submitError').hidden = true;
        render();
        $('savedNote').textContent = tr('Saved.', 'تم الحفظ.');
    });

    $('uploadForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('uploadError').hidden = true;
        const file = $('file').files[0];
        if (!file) return showError('uploadError', {error: 'no_file', message: 'Choose a file to upload.'});
        if (file.size > 5 * 1024 * 1024) return showError('uploadError', {error: 'file_too_large', message: 'The file is larger than 5 MB.'});
        const form = new FormData();
        form.append('kind', $('kind').value);
        form.append('file', file);
        busy($('uploadButton'), true);
        let res, data = {};
        try {
            res = await fetch('/api/facility/documents', {method: 'POST', body: form, credentials: 'same-origin'});
            data = await res.json().catch(() => ({}));
        } catch (_) {
            data = {error: 'network', message: 'Could not connect. Check your internet and try again.'};
        }
        busy($('uploadButton'), false);
        if (!res?.ok) return showError('uploadError', data);
        state.documents.push(data.document);
        $('file').value = '';
        renderDocuments();
    });

    $('submitButton').addEventListener('click', async () => {
        $('submitError').hidden = true;
        busy($('submitButton'), true);
        const res = await api('/api/facility/submit', {});
        busy($('submitButton'), false);
        if (!res.ok) {
            if (res.data.missing) res.data.message = tr('Please fill in and save: ', 'يرجى تعبئة وحفظ: ') + res.data.missing.map(k => tr(...LABELS[k])).join(tr(', ', '، '));
            if (res.data.missing && Shc.lang === 'ar') res.data.error = 'missing_fields';
            return showError('submitError', res.data);
        }
        state.profile = res.data.profile;
        render();
        $('statusBox').focus();
    });
});
