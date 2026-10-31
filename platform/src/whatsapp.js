// Sends WhatsApp messages through Meta's official WhatsApp Cloud API. A business may only start a conversation with a
// template that Meta has approved, so every message here is a template name plus its {{1}}, {{2}}, ... values.
// The templates to create in WhatsApp Manager are listed in README.md.

// Meta does not deliver to WhatsApp users in sanctioned countries (Syria, Cuba, Iran, North Korea); those numbers get SMS.
// Remove a prefix from WHATSAPP_BLOCKED_PREFIXES as soon as Meta allows it.
export const DEFAULT_BLOCKED_PREFIXES = ['+963', '+53', '+98', '+850'];

// Template names in WhatsApp Manager, by message (appointment messages by the appointment's new status).
export const TEMPLATES = {code: 'shc_login_code', confirmed: 'shc_appointment_confirmed', declined: 'shc_appointment_declined',
    cancelled_by_doctor: 'shc_appointment_cancelled'};

// Template values may not contain line breaks, tabs or more than four spaces in a row.
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || '-';

export function createWhatsApp(config) {
    const {provider, phoneNumberId, token, apiVersion} = config.whatsapp;
    if (!provider) return null;
    if (provider === 'test') {
        const sent = [];
        return {sent, async sendTemplate(to, template) { sent.push({to, ...template}); }};
    }
    if (provider !== 'cloud') throw new Error(`Unknown WHATSAPP_PROVIDER ${provider}`);
    if (!phoneNumberId || !token) throw new Error('WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_TOKEN are required for WHATSAPP_PROVIDER=cloud');
    return {
        // `copyCode` adds the value for the "Copy code" button of an authentication template.
        async sendTemplate(to, {name, language, params, copyCode}) {
            const components = [{type: 'body', parameters: params.map(p => ({type: 'text', text: clean(p)}))}];
            if (copyCode) components.push({type: 'button', sub_type: 'url', index: '0', parameters: [{type: 'text', text: copyCode}]});
            const response = await fetch(`https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
                body: JSON.stringify({
                    messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, ''), type: 'template',
                    template: {name, language: {code: language}, components}
                }),
                signal: AbortSignal.timeout(10000)
            });
            if (!response.ok) {
                const detail = await response.json().catch(() => ({}));
                throw new Error(`WhatsApp API returned HTTP ${response.status}${detail.error?.code ? ` (code ${detail.error.code})` : ''}`);
            }
        }
    };
}
