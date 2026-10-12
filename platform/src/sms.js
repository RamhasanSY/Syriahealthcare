// Sends SMS codes. Syrian SMS gateways differ, so the "http" provider posts JSON
// {to, message, sender} with a bearer token; adapt sendHttp() to the chosen gateway's API.
export function createSms(config, log) {
    if (config.smsProvider === 'console') {
        return {
            async send(to, message) {
                log.warn({to}, `[development SMS] ${message}`);
            }
        };
    }
    if (config.smsProvider === 'http') {
        if (!config.smsHttp.url || !config.smsHttp.token) throw new Error('SMS_HTTP_URL and SMS_HTTP_TOKEN are required for SMS_PROVIDER=http');
        return {
            async send(to, message) {
                const response = await fetch(config.smsHttp.url, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json', Authorization: `Bearer ${config.smsHttp.token}`},
                    body: JSON.stringify({to, message, sender: config.smsHttp.sender}),
                    signal: AbortSignal.timeout(10000)
                });
                if (!response.ok) throw new Error(`SMS gateway returned HTTP ${response.status}`);
            }
        };
    }
    if (config.smsProvider === 'test') {
        const sent = [];
        return {sent, async send(to, message) { sent.push({to, message}); }};
    }
    throw new Error(`Unknown SMS_PROVIDER ${config.smsProvider}`);
}
