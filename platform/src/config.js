// All settings come from environment variables (see .env.example). Missing secrets stop the server in production.
const env = process.env;
const production = env.NODE_ENV === 'production';

function required(name, fallback) {
    const value = env[name] ?? (production ? undefined : fallback);
    if (value === undefined || value === '') throw new Error(`Missing required setting ${name}`);
    return value;
}

export const config = {
    production,
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    databaseUrl: required('DATABASE_URL', 'postgres://postgres@127.0.0.1:54329/shc_dev'),
    // Public address of the platform, e.g. https://app.syriahealthcare.com. State-changing requests must come from it.
    appOrigin: required('APP_ORIGIN', 'http://127.0.0.1:3000'),
    // Signs SMS codes. At least 32 random characters; generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    otpSecret: required('OTP_SECRET', 'development-only-otp-secret-change-me'),
    // "console" prints codes to the server log (development only); "http" posts to an SMS gateway.
    smsProvider: env.SMS_PROVIDER || (production ? 'http' : 'console'),
    smsHttp: {url: env.SMS_HTTP_URL, token: env.SMS_HTTP_TOKEN, sender: env.SMS_SENDER || 'SyriaHealth'},
    sessionDays: {patient: 30, doctor: 7, admin: 1},
    trustProxy: env.TRUST_PROXY === 'true'
};

if (production && config.otpSecret.length < 32) throw new Error('OTP_SECRET must be at least 32 characters');
if (production && config.smsProvider === 'console') throw new Error('SMS_PROVIDER=console is not allowed in production');
