// Sends sign-in codes through the Telegram Gateway API (core.telegram.org/gateway): about $0.01 per delivered code,
// refunded automatically if it is not delivered in time. It carries verification codes only, not other messages.
// The platform makes the code itself and checks it as for SMS; Telegram only delivers it.
const BASE = 'https://gatewayapi.telegram.org/';

export function createTelegramGateway(config) {
    const {provider, token} = config.telegram;
    if (!provider) return null;
    if (provider === 'test') {
        const sent = [], unreachable = new Set();
        return {sent, unreachable, async sendCode(phone, code, ttlSeconds) {
            if (unreachable.has(phone)) throw new Error('Telegram Gateway: PHONE_NUMBER_NOT_AVAILABLE');
            sent.push({to: phone, code, ttlSeconds});
        }};
    }
    if (provider !== 'gateway') throw new Error(`Unknown TELEGRAM_PROVIDER ${provider}`);
    if (!token) throw new Error('TELEGRAM_GATEWAY_TOKEN is required for the Telegram Gateway');

    async function call(method, params) {
        const response = await fetch(BASE + method, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${token}`},
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(10000)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) throw new Error(`Telegram Gateway: ${data.error || `HTTP ${response.status}`}`);
        return data.result;
    }
    return {
        // First asks whether the number can get Telegram messages (free when it cannot); the send itself then costs nothing extra.
        async sendCode(phone, code, ttlSeconds) {
            const {request_id} = await call('checkSendAbility', {phone_number: phone});
            await call('sendVerificationMessage', {phone_number: phone, request_id, code, ttl: ttlSeconds});
        }
    };
}
