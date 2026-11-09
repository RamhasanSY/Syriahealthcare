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
    "name": [{"text": "…"}], "telecom": [{"system": "phone", "value": "0912 345 678"}], "birthDate": "1990-04-02"},
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

→ MSA|AA|MSG0001|Delivered to the patient's SyriaHC health file.`;
    }

    function renderMine() {
        $('mine').hidden = !mine;
        if (!mine) return;
        $('mineList').replaceChildren(...(mine.clients.length ? mine.clients.map(c => el('li', {className: 'appt'},
            el('h3', {}, el('bdi', {textContent: c.name})),
            el('p', {className: 'muted-small'}, el('code', {textContent: c.client_id, dir: 'ltr'}), ` · ${c.scopes.join(', ')} · `,
                c.revoked_at ? tr('ended', 'منتهٍ') : tr('active', 'فعّال')))) : [el('li', {className: 'empty-row',
            textContent: tr('No connection yet. Write to us to get one.', 'لا يوجد ربط بعد. راسلونا للحصول عليه.')})]));
    }

    examples();
    const res = await api('/api/facility/api-clients');
    if (res.ok) {
        mine = res.data;
        urls = {token_url: res.data.token_url, fhir_base: res.data.fhir_base, hl7v2_url: res.data.hl7v2_url};
        examples();
    }
    renderMine();
    document.addEventListener('shc:language', renderMine);
});
