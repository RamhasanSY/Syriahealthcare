// Doctor profile: practice details, licence documents, and sending for review.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const FIELDS = ['specialty', 'governorate', 'area', 'clinic_name', 'clinic_address', 'clinic_phone', 'licence_number', 'bio'];
    const LABELS = {specialty: ['Specialty', 'الاختصاص'], governorate: ['Governorate', 'المحافظة'], area: ['City or area', 'المدينة أو المنطقة'],
        clinic_name: ['Clinic name', 'اسم العيادة'], clinic_address: ['Clinic address', 'عنوان العيادة'], clinic_phone: ['Clinic phone', 'هاتف العيادة'],
        licence_number: ['Licence number', 'رقم الترخيص']};
    const KINDS = {licence: ['Licence to practise', 'ترخيص مزاولة المهنة'], syndicate: ['Syndicate card', 'بطاقة النقابة'], other: ['Other document', 'وثيقة أخرى']};
    const STATUS = {
        draft: ['info', 'Not sent yet. Complete steps 1–3 below.', 'لم يُرسل بعد. أكمل الخطوات 1–3 أدناه.'],
        pending: ['wait', 'Under review. We will let you know by email when it is checked.', 'قيد المراجعة. سنبلغك بالبريد الإلكتروني عند الانتهاء.'],
        approved: ['ok', 'Approved. Patients will be able to find and book you.', 'معتمد. سيتمكن المرضى من إيجادك والحجز لديك.'],
        rejected: ['error', 'Changes needed before approval:', 'مطلوب تعديلات قبل الاعتماد:'],
        suspended: ['error', 'Your profile is suspended and hidden from patients:', 'ملفك موقوف ومخفي عن المرضى:']
    };
    let state = null, catalog = null;

    const [me, cat] = await Promise.all([api('/api/doctor/profile'), api('/api/catalog')]);
    $('main').setAttribute('aria-busy', 'false');
    if (!me.ok) return window.location.assign(me.status === 401 ? '/staff' : '/account');
    state = me.data;
    catalog = cat.data;

    function options(select, list, value) {
        const label = (k, l) => tr(l[0], l[1]);
        select.replaceChildren(new Option(tr('Choose…', 'اختر…'), ''),
            ...Object.entries(list).sort((a, b) => label(...a).localeCompare(label(...b), Shc.lang)).map(([k, l]) => new Option(label(k, l), k)));
        select.value = value || '';
    }

    function renderStatus() {
        const p = state.profile, [kind, en, ar] = STATUS[p.status];
        const box = $('statusBox');
        box.className = 'status-box ' + kind;
        box.replaceChildren(document.createTextNode(tr(en, ar)));
        if (p.review_note && ['rejected', 'suspended'].includes(p.status)) {
            const note = document.createElement('p');
            note.className = 'review-note';
            note.dir = 'auto';
            note.textContent = p.review_note;
            box.append(note);
        }
        const editable = p.status !== 'suspended', docsOpen = ['draft', 'pending', 'rejected'].includes(p.status);
        $('profileForm').hidden = !editable;
        $('documentsCard').hidden = false;
        $('uploadForm').hidden = !docsOpen;
        $('submitCard').hidden = !['draft', 'rejected'].includes(p.status);
        $('reviewWarning').hidden = p.status !== 'approved';
    }

    function renderForm() {
        options($('specialty'), catalog.specialties, $('specialty').value || state.profile.specialty);
        options($('governorate'), catalog.governorates, $('governorate').value || state.profile.governorate);
        $('bioCount').textContent = tr(`${$('bio').value.length} / 600 characters`, `${$('bio').value.length} / 600 حرف`);
    }

    function renderDocuments() {
        const docsOpen = ['draft', 'pending', 'rejected'].includes(state.profile.status);
        $('docList').replaceChildren(...state.documents.map(d => {
            const li = document.createElement('li'), info = document.createElement('span'), name = document.createElement('strong');
            name.textContent = d.filename;
            name.dir = 'auto';
            info.append(name, document.createTextNode(` · ${tr(...KINDS[d.kind])} · ${Math.max(1, Math.round(d.size_bytes / 1024))} KB`));
            li.append(info);
            if (docsOpen) {
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'link-btn';
                del.textContent = tr('Remove', 'حذف');
                del.setAttribute('aria-label', tr('Remove ', 'حذف ') + d.filename);
                del.onclick = async () => {
                    const res = await fetch('/api/doctor/documents/' + d.id, {method: 'DELETE', credentials: 'same-origin'});
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

    FIELDS.forEach(f => { if (f !== 'specialty' && f !== 'governorate') $(f).value = state.profile[f] || ''; });
    $('clinic_phone').value = state.profile.clinic_phone || '';
    $('bio').addEventListener('input', renderForm);
    document.addEventListener('shc:language', render);
    render();

    $('profileForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('profileError').hidden = true;
        $('savedNote').textContent = '';
        busy($('saveProfile'), true);
        const res = await api('/api/doctor/profile', Object.fromEntries(FIELDS.map(f => [f, $(f).value])));
        busy($('saveProfile'), false);
        if (!res.ok) return showError('profileError', res.data);
        state.profile = res.data.profile;
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
            res = await fetch('/api/doctor/documents', {method: 'POST', body: form, credentials: 'same-origin'});
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
        const res = await api('/api/doctor/submit', {});
        busy($('submitButton'), false);
        if (!res.ok) {
            if (res.data.missing) res.data.message = tr('Please fill in: ', 'يرجى تعبئة: ') + res.data.missing.map(k => tr(...LABELS[k])).join(tr(', ', '، '));
            if (res.data.missing && Shc.lang === 'ar') res.data.error = 'missing_fields';
            return showError('submitError', res.data);
        }
        state.profile = res.data.profile;
        render();
        $('statusBox').focus();
    });
});
