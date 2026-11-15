// Blood donation calls (src/blood.js): the public list, and for signed-in patients the donor register and "I can donate".
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    // Who can give red cells to whom (the same table as src/blood.js).
    const CAN_GIVE = {'O-': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'], 'O+': ['O+', 'A+', 'B+', 'AB+'], 'A-': ['A-', 'A+', 'AB-', 'AB+'],
        'A+': ['A+', 'AB+'], 'B-': ['B-', 'B+', 'AB-', 'AB+'], 'B+': ['B+', 'AB+'], 'AB-': ['AB-', 'AB+'], 'AB+': ['AB+']};
    const day = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {weekday: 'long', day: 'numeric', month: 'long'});
    const [me, cat] = await Promise.all([api('/api/me'), api('/api/catalog')]);
    const user = me.ok ? me.data.user : null, catalog = cat.data;
    let requests = [], types = Object.keys(CAN_GIVE), donorsOn = false, donor = null, answered = new Map(), ticket = 0;

    const option = (value, text) => el('option', {value, textContent: text});
    function fillSelects() {
        const govs = Object.entries(catalog.governorates);
        const keep = id => $(id).value;
        const [g, t, d, b] = [keep('filterGov'), keep('filterType'), keep('donorGov'), keep('bloodType')];
        $('filterGov').replaceChildren(option('', tr('All governorates', 'كل المحافظات')), ...govs.map(([k, v]) => option(k, tr(...v))));
        $('filterType').replaceChildren(option('', tr('Any', 'أي زمرة')), ...types.map(x => option(x, x)));
        $('donorGov').replaceChildren(option('', tr('Choose…', 'اختر…')), ...govs.map(([k, v]) => option(k, tr(...v))));
        $('bloodType').replaceChildren(option('', tr('Choose…', 'اختر…')), ...types.map(x => option(x, x)));
        [$('filterGov').value, $('filterType').value, $('donorGov').value, $('bloodType').value] = [g, t, d, b];
    }

    async function loadList() {
        const t = ++ticket, params = new URLSearchParams();
        if ($('filterGov').value) params.set('governorate', $('filterGov').value);
        if ($('filterType').value) params.set('blood_type', $('filterType').value);
        const res = await api('/api/blood-requests?' + params);
        if (t !== ticket) return;
        $('main').setAttribute('aria-busy', 'false');
        if (!res.ok) return showError('listError', res.data);
        requests = res.data.requests;
        donorsOn = res.data.donors;
        render();
    }

    function card(r) {
        const li = el('li', {className: 'appt'});
        const place = [r.area, catalog.governorates[r.governorate] ? tr(...catalog.governorates[r.governorate]) : ''].filter(Boolean).join(' · ');
        li.append(el('span', {className: 'pill ' + (r.urgency === 'urgent' ? 'wait' : 'ok'), textContent: r.urgency === 'urgent' ? tr('Urgent', 'عاجل') : tr('Needed', 'مطلوب')}),
            el('h3', {textContent: r.facility_name, dir: 'auto'}),
            el('p', {className: 'blood-types'}, tr('Blood groups: ', 'الزمر: '), ...r.blood_types.map(x => el('span', {className: 'chip', dir: 'ltr', textContent: x}))),
            el('p', {className: 'muted-small', textContent: [tr(`Needed by ${day(r.needed_by)}`, `مطلوب قبل ${day(r.needed_by)}`),
                r.units ? tr(`${r.units} units`, `${r.units} وحدة`) : ''].filter(Boolean).join(' · ')}),
            el('p', {className: 'muted-small', textContent: [r.address, place].filter(Boolean).join(' · '), dir: 'auto'}),
            el('p', {className: 'muted-small'}, tr('Phone: ', 'الهاتف: '), el('a', {href: 'tel:' + r.phone, textContent: r.phone, dir: 'ltr'})));
        if (r.note) li.append(el('p', {className: 'appt-reason', textContent: r.note, dir: 'auto'}));
        if (answered.has(r.id)) {
            li.append(el('p', {className: 'msg info', textContent: tr(`Thank you. They now have your name and number. Please call ${r.phone} before you go.`,
                `شكراً لك. أصبح لديهم اسمك ورقمك. يرجى الاتصال على ${r.phone} قبل الذهاب.`)}));
        } else if (donor && CAN_GIVE[donor.blood_type].some(x => r.blood_types.includes(x))) {
            const button = el('button', {type: 'button', className: 'btn', textContent: tr('I can donate', 'أستطيع التبرع')});
            button.onclick = async () => {
                $('listError').hidden = true;
                busy(button, true);
                const res = await api(`/api/blood-requests/${r.id}/respond`, {});
                busy(button, false);
                if (!res.ok) return showError('listError', res.data);
                answered.set(r.id, true);
                render();
                $('count').focus();
            };
            li.append(button);
        }
        return li;
    }

    function render() {
        fillSelects();
        $('count').textContent = requests.length ? tr(`${requests.length} open calls`, `${requests.length} نداءات مفتوحة`) : tr('No open calls here right now.', 'لا توجد نداءات مفتوحة هنا حالياً.');
        $('list').replaceChildren(...requests.map(card));
        $('signInHint').hidden = !(donorsOn && !user);
        renderDonor();
    }

    // ---- Donor register (patients, while the health file is switched on) ----
    async function loadDonor() {
        if (user?.role !== 'patient' || !donorsOn) return;
        const res = await api('/api/donor');
        if (!res.ok) return;
        donor = res.data.donor;
        $('donorCard').hidden = false;
        if (donor) {
            $('bloodType').value = donor.blood_type;
            $('donorGov').value = donor.governorate;
            $('donorPhone').value = donor.phone;
            $('lastDonation').value = donor.last_donation_date || '';
            $('notify').checked = donor.notify;
        } else if (user.phone) {
            $('donorPhone').value = user.phone;
        }
        render();
    }
    function renderDonor() {
        if ($('donorCard').hidden) return;
        $('consentRow').hidden = Boolean(donor);
        $('donorDelete').hidden = !donor;
        $('donorState').textContent = !donor ? tr('You are not on the donor list.', 'لست على قائمة المتبرعين.')
            : donor.next_possible && donor.next_possible > new Date().toISOString().slice(0, 10)
                ? tr(`You are on the donor list (${donor.blood_type}). Calls resume from ${day(donor.next_possible)}.`, `أنت على قائمة المتبرعين (${donor.blood_type}). تُستأنف النداءات من ${day(donor.next_possible)}.`)
                : tr(`You are on the donor list (${donor.blood_type}).`, `أنت على قائمة المتبرعين (${donor.blood_type}).`);
    }
    $('donorForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('donorError').hidden = true;
        busy($('donorSave'), true);
        const res = await api('/api/donor', {blood_type: $('bloodType').value, governorate: $('donorGov').value, phone: $('donorPhone').value,
            notify: $('notify').checked, last_donation_date: $('lastDonation').value || null, consent: $('donorConsent').checked});
        busy($('donorSave'), false);
        if (!res.ok) return showError('donorError', res.data);
        donor = res.data.donor;
        render();
        $('donorState').focus?.();
    });
    $('donorDelete').addEventListener('click', async () => {
        busy($('donorDelete'), true);
        const res = await api('/api/donor/delete', {});
        busy($('donorDelete'), false);
        if (!res.ok) return showError('donorError', res.data);
        donor = null;
        $('donorForm').reset();
        render();
        $('donorTitle').focus();
    });

    $('filterGov').addEventListener('change', loadList);
    $('filterType').addEventListener('change', loadList);
    document.addEventListener('shc:language', render);
    await loadList();
    await loadDonor();
});
