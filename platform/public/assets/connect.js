// "Connect your software" (stage 2d): the guide with examples for this server, and a facility's own connections.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const origin = window.location.origin;
    let urls = {token_url: `${origin}/oauth/token`, fhir_base: `${origin}/fhir/r4`, hl7v2_url: `${origin}/hl7v2`}, mine = null;

    function examples() {
        $('exToken').textContent = `curl -u "CLIENT_ID:CLIENT_SECRET" \\
  -d "grant_type=client_credentials&scope=system/DiagnosticReport.c" \\
  ${urls.token_url}

→ {"access_token":"…","token_type":"Bearer","expires_in":900,"scope":"system/DiagnosticReport.c"}`;
        $('exFhir').textContent = `POST ${urls.fhir_base}
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/fhir+json

{"resourceType": "Bundle", "type": "transaction", "entry": [
  {"fullUrl": "urn:uuid:…patient", "resource": {"resourceType": "Patient",
    "identifier": [{"system": "https://syriahc.com/fhir/sid/patient-number", "value": "SHC-XXXX-XXXX-X"}],
    "name": [{"text": "Lina Haddad"}], "telecom": [{"system": "phone", "value": "0912 345 678"}], "birthDate": "1990-04-02"},
   "request": {"method": "POST", "url": "Patient"}},
  {"resource": {"resourceType": "DiagnosticReport", "status": "final",
    "identifier": [{"system": "urn:your-lab", "value": "YOUR-LAB-NUMBER"}],
    "code": {"text": "Complete blood count"}, "subject": {"reference": "urn:uuid:…patient"},
    "presentedForm": [{"contentType": "application/pdf", "data": "JVBERi0…"}]},
   "request": {"method": "POST", "url": "DiagnosticReport"}}
]}

→ transaction-response: "201 Created" + "delivered" or "not-delivered" with the slip code`;
        $('exV2').textContent = `POST ${urls.hl7v2_url}
Authorization: Bearer ACCESS_TOKEN
Content-Type: x-application/hl7-v2+er7

MSH|^~\\&|YourLabSoft|YourLab|SyriaHC|SyriaHC|20261109101500||ORU^R01^ORU_R01|MSG0001|P|2.5.1
PID|1||SHC-XXXX-XXXX-X^^^SyriaHC||Family^Given||19900402|F|||||0912345678
OBR|1||YOUR-LAB-NUMBER|CBC^Complete blood count
OBX|1|NM|718-7^Hemoglobin^LN||13.2|g/dL^g/dL^UCUM|12-16|N|||F
OBX|2|ED|PDF^Report^L||^application^pdf^Base64^JVBERi0…||||||F

→ MSA|AA|MSG0001|Not delivered to a health file. Print this code for the patient: ABCD-EFGH-JKLM
  (or, when it went into the patient's file: Delivered to the patient's SyriaHC health file.)`;
    }

    const day = iso => new Date(iso).toLocaleDateString(Shc.lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Damascus'});

    function renderMine() {
        $('mine').hidden = !mine;
        // Who may ask: not signed in as a facility → sign in; not approved → profile first; an open request → its date.
        $('askSignIn').hidden = Boolean(mine);
        $('askNotApproved').hidden = !mine || mine.approved;
        $('askOpen').hidden = !mine?.request;
        $('askForm').hidden = !mine?.approved || Boolean(mine.request);
        if (mine?.request) {
            $('askOpen').textContent = tr(`You asked for a connection for "${mine.request.software}" on ${day(mine.request.created_at)}. We will contact you.`,
                `طلبتم ربط «${mine.request.software}» بتاريخ ${day(mine.request.created_at)}. سنتواصل معكم.`);
        }
        $('healthNow').hidden = !mine;
        if (mine) {
            $('healthNow').textContent = mine.health_file
                ? tr('On SyriaHC now: health files for patients are switched on.', 'في صحة تك الآن: الملفات الصحية للمرضى مفعّلة.')
                : tr('On SyriaHC now: health files for patients are not switched on yet, so every result is answered with a slip code to print.',
                    'في صحة تك الآن: الملفات الصحية للمرضى غير مفعّلة بعد، لذلك يكون الرد على كل نتيجة رمز ورقة للطباعة.');
        }
        if (!mine) return;
        $('mineList').replaceChildren(...(mine.clients.length ? mine.clients.map(c => el('li', {className: 'appt'},
            el('h3', {}, el('bdi', {textContent: c.name})),
            el('p', {className: 'muted-small'}, el('code', {textContent: c.client_id, dir: 'ltr'}), ` · ${c.scopes.join(', ')} · `,
                c.revoked_at ? tr('ended', 'منتهٍ') : tr('active', 'فعّال')))) : [el('li', {className: 'empty-row',
            textContent: tr('No connection yet.', 'لا يوجد ربط بعد.')})]));
    }

    async function load() {
        const res = await api('/api/facility/api-clients');
        if (res.ok) {
            mine = res.data;
            urls = {token_url: res.data.token_url, fhir_base: res.data.fhir_base, hl7v2_url: res.data.hl7v2_url};
            examples();
        }
        renderMine();
    }

    $('askForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('askError').hidden = true;
        const software = $('askSoftware').value.trim();
        if (software.length < 2) {
            Shc.showError('askError', {error: 'invalid_software', message: 'Write the name of your software.'});
            return $('askSoftware').focus();
        }
        Shc.busy($('askSend'), true);
        const res = await api('/api/facility/api-client-requests', {software, contact: $('askContact').value.trim()});
        Shc.busy($('askSend'), false);
        if (!res.ok) return Shc.showError('askError', res.data);
        $('askForm').reset();
        await load();
        $('askOpen').focus();
    });

    examples();
    await load();
    document.addEventListener('shc:language', renderMine);
});
