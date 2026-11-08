// Changes to approved profiles (stage 2a). Details that identify the person or the place (name, specialty, area, address,
// licence) are held in `pending_changes` until an administrator accepts or rejects them. Other details apply at once.
// An approved profile keeps its status and its public listing while changes wait, so a change never locks anyone out.
export const DOCTOR_CRITICAL = ['specialty', 'governorate', 'area', 'clinic_name', 'clinic_address', 'licence_number'];
export const FACILITY_CRITICAL = ['facility_name', 'governorate', 'area', 'address', 'licence_number'];

// Splits a cleaned change set. A profile that is not approved yet has no critical fields: everything applies at once.
export function splitChanges(changes, critical) {
    const immediate = {}, held = {};
    for (const [key, value] of Object.entries(changes)) (critical.includes(key) ? held : immediate)[key] = value;
    return {immediate, held};
}

// Writes the immediate fields and holds the rest. Returns the row and the names of the held fields.
export async function saveChange(db, table, userId, changes, critical) {
    const {immediate, held} = splitChanges(changes, critical);
    const values = [userId], assigns = [];
    for (const [key, value] of Object.entries(immediate)) assigns.push(`${key} = $${values.push(value)}`);
    if (Object.keys(held).length) {
        assigns.push(`pending_changes = COALESCE(pending_changes, '{}'::jsonb) || $${values.push(JSON.stringify(held))}::jsonb`);
        assigns.push('changes_submitted_at = now()');
    }
    assigns.push('updated_at = now()');
    const {rows: [row]} = await db.query(`UPDATE ${table} SET ${assigns.join(', ')} WHERE user_id = $1 RETURNING *`, values);
    return {row, held: Object.keys(held)};
}

// Accepted: the held fields become the profile. Only fields in the critical list are ever written from here.
export async function acceptPending(db, table, userId, pending, critical) {
    const values = [userId], assigns = [];
    for (const key of Object.keys(pending)) {
        if (critical.includes(key)) assigns.push(`${key} = $${values.push(pending[key])}`);
    }
    assigns.push('pending_changes = NULL', 'changes_submitted_at = NULL', 'updated_at = now()');
    const {rows: [row]} = await db.query(`UPDATE ${table} SET ${assigns.join(', ')} WHERE user_id = $1 RETURNING *`, values);
    return row;
}

// Rejected: the held fields are dropped; the profile stays as it was.
export async function rejectPending(db, table, userId) {
    const {rows: [row]} = await db.query(
        `UPDATE ${table} SET pending_changes = NULL, changes_submitted_at = NULL, updated_at = now() WHERE user_id = $1 RETURNING *`, [userId]);
    return row;
}
