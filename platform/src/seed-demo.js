// Fills a database with clearly marked demo data for previewing the platform locally.
//   DATABASE_URL=postgres://.../shc_preview npm run seed:demo
// Refuses to run in production.
import {config} from './config.js';
import {createPool} from './db.js';
import {migrate} from './migrate.js';
import {hashPassword} from './security.js';

if (config.production) {
    console.error('seed:demo is for local previews only and will not run in production.');
    process.exit(1);
}
const pool = createPool(config.databaseUrl);
await migrate(pool);

const doctors = [
    {email: 'demo-doctor@demo.local', name: '[DEMO] Dr. Sara Haddad', specialty: 'pediatrics', governorate: 'damascus', area: 'Al Mazzeh',
        clinic: 'Demo Children\'s Clinic', address: 'Mezzeh Highway, Building 12 (demo address)', phone: '+963110000001', bio: 'Demo profile for testing. Children and newborns.'},
    {email: 'demo-cardio@demo.local', name: '[DEMO] Dr. Omar Khalil', specialty: 'cardiology', governorate: 'aleppo', area: 'Al Furqan',
        clinic: 'Demo Heart Clinic', address: 'Al Furqan Street 4 (demo address)', phone: '+963210000002', bio: 'Demo profile for testing. Adult cardiology.'},
    {email: 'demo-obgyn@demo.local', name: '[DEMO] Dr. Rana Saleh', specialty: 'obgyn', governorate: 'homs', area: 'Al Inshaat',
        clinic: 'Demo Women\'s Clinic', address: 'Al Inshaat Street 7 (demo address)', phone: '+963310000003', bio: 'Demo profile for testing. Pregnancy care and gynecology.'}
];
const doctorHash = await hashPassword('demo doctor 123');
for (const d of doctors) {
    const {rows: [user]} = await pool.query(
        `INSERT INTO users (role, name, email, password_hash, consented_at) VALUES ('doctor', $1, $2, $3, now())
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [d.name, d.email, doctorHash]);
    await pool.query(
        `INSERT INTO doctor_profiles (user_id, status, specialty, governorate, area, clinic_name, clinic_address, clinic_phone, licence_number, bio, submitted_at, reviewed_at)
         VALUES ($1, 'approved', $2, $3, $4, $5, $6, $7, 'DEMO-0000', $8, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET status = 'approved', specialty = $2, governorate = $3, area = $4, clinic_name = $5, clinic_address = $6, clinic_phone = $7, bio = $8`,
        [user.id, d.specialty, d.governorate, d.area, d.clinic, d.address, d.phone, d.bio]);
    await pool.query(`INSERT INTO doctor_schedules (doctor_id, slot_minutes, booking_window_days, min_notice_hours) VALUES ($1, 30, 30, 1)
        ON CONFLICT (doctor_id) DO NOTHING`, [user.id]);
    await pool.query('DELETE FROM weekly_hours WHERE doctor_id = $1', [user.id]);
    for (const weekday of [6, 0, 1, 2, 3]) {  // Saturday to Wednesday
        await pool.query("INSERT INTO weekly_hours (doctor_id, weekday, starts_at, ends_at) VALUES ($1, $2, '10:00', '14:00'), ($1, $2, '17:00', '20:00')", [user.id, weekday]);
    }
}
await pool.query(
    `INSERT INTO users (role, name, email, password_hash, consented_at) VALUES ('admin', '[DEMO] Admin', 'demo-admin@demo.local', $1, now())
     ON CONFLICT (email) DO NOTHING`, [await hashPassword('demo admin 123')]);
console.log('Demo data ready: 3 approved demo doctors and a demo admin.');
await pool.end();
