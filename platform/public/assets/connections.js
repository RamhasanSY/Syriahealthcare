// Admin, stage 2d: software connections (OAuth clients) for approved labs, imaging centres, hospitals and clinics.
// The secret appears once, right after creating a connection, and never again.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const day = iso => iso ? new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Damascus'}) : '—';
    let data = null, facilities = [], created = null;

    async function load() {
        const res = await api('/api/admin/api-clients');
        if (!res.ok) return;  // not an administrator: admin.js shows the sign-in
        data = res.data;
        const f = await api('/api/admin/facilities?status=approved');
        facilities = f.ok ? f.data.facilities : [];
        $('connections').hidden = false;
        render();
    }

    function render() {
        if (!data) return;
        $('connFacility').replaceChildren(el('option', {value: '', textContent: tr('Choose an approved facility', 'اختر منشأة معتمدة')}),
            ...facilities.map(f => el('option', {value: f.id, textContent: f.facility_name || f.name})));
        $('connScopes').replaceChildren(...Object.entries(data.scopes).map(([scope, labels]) => {
            const box = el('input', {type: 'checkbox', value: scope, id: 'scope-' + scope.replace(/\W/g, '-')});
            const label = el('label', {className: 'check', htmlFor: box.id});
            label.append(box, el('span', {}, tr(...labels), ' ', el('code', {textContent: scope, dir: 'ltr'})));
            return label;
        }));
        renderRequests();
        $('connList').replaceChildren(...(data.clients.length ? data.clients.map(c => {
            const li = el('li', {className: 'appt'});
            const head = el('div', {className: 'appt-head'}, el('h3', {}, el('bdi', {textContent: c.name})),
                el('span', {className: 'pill ' + (c.revoked_at ? 'off' : 'ok'), textContent: c.revoked_at ? tr('Ended', 'منتهٍ') : tr('Active', 'فعّال')}));
            const facts = el('p', {className: 'muted-small'}, el('bdi', {textContent: c.facility_name || ''}), ' · ', el('code', {textContent: c.client_id, dir: 'ltr'}),
                ` · ${c.scopes.join(', ')} · ${tr('created', 'أُنشئ')} ${day(c.created_at)} · ${tr('last used', 'آخر استخدام')} ${day(c.last_used_at)}`);
            li.append(head, facts);
            if (!c.revoked_at) {
                const end = el('button', {type: 'button', className: 'btn danger', textContent: tr('End this connection', 'أنهِ هذا الربط')});
                end.setAttribute('aria-label', `${tr('End this connection', 'أنهِ هذا الربط')}: ${c.name}`);
                end.addEventListener('click', async () => {
                    if (!window.confirm(tr(`End "${c.name}"? The software stops working at once.`, `إنهاء «${c.name}»؟ يتوقف البرنامج عن العمل فوراً.`))) return;
                    busy(end, true);
                    const res = await api(`/api/admin/api-clients/${c.id}/revoke`, {});
                    busy(end, false);
                    if (!res.ok) return showError('connError', res.data);
                    await load();
                    $('connHeading').focus();
                });
                li.append(el('div', {className: 'actions'}, end));
            }
            return li;
        }) : [el('li', {className: 'empty-row', textContent: tr('No software is connected yet.', 'لم يُربط أي برنامج بعد.')})]));
        renderCreated();
    }

    // Requests that facilities sent from "Connect your software". Creating a connection for the facility closes its request.
    function renderRequests() {
        const requests = data.requests || [];
        $('connRequestsHeading').hidden = $('connRequests').hidden = !requests.length;
        $('connRequests').replaceChildren(...requests.map(r => {
            const name = r.facility_name || r.account_name;
            const facts = [tr('Software', 'البرنامج') + ': ', el('bdi', {textContent: r.software})];
            if (r.contact) facts.push(' · ' + tr('Contact at the provider', 'التواصل لدى المزود') + ': ', el('bdi', {textContent: r.contact}));
            facts.push(` · ${tr('asked', 'طُلب')} ${day(r.created_at)} · `, el('bdi', {textContent: r.account_name}), ' ', el('span', {dir: 'ltr', textContent: `<${r.email}>`}));
            const prepare = el('button', {type: 'button', className: 'btn', textContent: tr('Prepare this connection', 'جهّز هذا الربط')});
            prepare.setAttribute('aria-label', `${tr('Prepare this connection', 'جهّز هذا الربط')}: ${name}`);
            prepare.addEventListener('click', () => {
                $('connFacility').value = r.facility_id;
                $('connName').value = r.software;
                // Labs and imaging centres send results; hospitals, clinics and others send documents.
                const scope = ['lab', 'imaging'].includes(r.kind) ? 'system/DiagnosticReport.c' : 'system/DocumentReference.c';
                $('connScopes').querySelectorAll('input').forEach(box => { box.checked = box.value === scope; });
                $('connName').focus();
            });
            const close = el('button', {type: 'button', className: 'btn ghost', textContent: tr('Close without a connection', 'أغلق دون ربط')});
            close.setAttribute('aria-label', `${tr('Close without a connection', 'أغلق دون ربط')}: ${name}`);
            close.addEventListener('click', async () => {
                if (!window.confirm(tr(`Close the request from "${name}"? They can ask again later.`, `إغلاق طلب «${name}»؟ يمكنهم الطلب مرة أخرى لاحقاً.`))) return;
                busy(close, true);
                const res = await api(`/api/admin/api-client-requests/${r.id}/close`, {});
                busy(close, false);
                if (!res.ok) return showError('connError', res.data);
                await load();
                $('connHeading').focus();
            });
            return el('li', {className: 'appt'},
                el('div', {className: 'appt-head'}, el('h3', {}, el('bdi', {textContent: name})), el('span', {className: 'pill wait', textContent: tr('Waiting', 'بانتظار')})),
                el('p', {className: 'muted-small'}, ...facts), el('div', {className: 'actions'}, prepare, close));
        }));
    }

    function renderCreated() {
        $('connSecretBox').hidden = !created;
        if (!created) {
            // Gone from the page, not only hidden: nobody looking at this screen later can read it.
            $('connClientId').textContent = $('connSecret').textContent = $('connTokenUrl').textContent = $('connCopied').textContent = '';
            return;
        }
        $('connClientId').textContent = created.client.client_id;
        $('connSecret').textContent = created.client_secret;
        $('connTokenUrl').textContent = created.token_url;
    }

    $('connForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('connError').hidden = true;
        const scopes = [...$('connScopes').querySelectorAll('input:checked')].map(b => b.value);
        if (!$('connFacility').value) return showError('connError', {error: 'choose_facility', message: tr('Choose the facility.', 'اختر المنشأة.')});
        if (!scopes.length) return showError('connError', {error: 'choose_scope', message: tr('Choose what the software may send.', 'اختر ما يمكن للبرنامج إرساله.')});
        busy($('connCreate'), true);
        const res = await api('/api/admin/api-clients', {facility_id: $('connFacility').value, name: $('connName').value.trim(), scopes});
        busy($('connCreate'), false);
        if (!res.ok) return showError('connError', res.data);
        created = res.data;
        $('connForm').reset();
        await load();
        $('connSecretHeading').focus();
    });

    $('connCopy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(`client_id=${created.client.client_id}\nclient_secret=${created.client_secret}\ntoken_url=${created.token_url}`);
            $('connCopied').textContent = tr('Copied.', 'تم النسخ.');
        } catch (_) {
            $('connCopied').textContent = tr('Could not copy. Select the text and copy it.', 'تعذر النسخ. حدد النص وانسخه.');
        }
    });
    $('connSecretDone').addEventListener('click', () => { created = null; renderCreated(); $('connHeading').focus(); });
    document.addEventListener('shc:language', render);
    await load();
});
