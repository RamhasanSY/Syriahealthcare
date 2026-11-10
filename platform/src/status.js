// System status for administrators: is the platform healthy and fast? Uptime, memory, event loop delay, response times
// per route (src/metrics.js), database size and cache hit rate, the email queue and free disk space.
// Counts and sizes only: no names, no contents, nothing about patients.
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {requireRole} from './auth.js';
import {diskSpace} from './jobs.js';

const loop = monitorEventLoopDelay({resolution: 20});
loop.enable();
const mb = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10;

export default async function statusRoutes(app) {
    app.get('/api/admin/status', {preHandler: requireRole('admin')}, async () => {
        const memory = process.memoryUsage();
        const db = app.pg;
        const [{rows: [size]}, {rows: [conn]}, {rows: [hits]}, {rows: tables}, {rows: [mail]}] = await Promise.all([
            db.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
            db.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()'),
            db.query(`SELECT CASE WHEN blks_hit + blks_read = 0 THEN 1 ELSE blks_hit::float / (blks_hit + blks_read) END AS ratio
                      FROM pg_stat_database WHERE datname = current_database()`),
            db.query(`SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows, pg_total_relation_size(c.oid)::bigint AS bytes
                      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`),
            db.query(`SELECT count(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL)::int AS waiting,
                             count(*) FILTER (WHERE failed_at > now() - interval '7 days')::int AS failed_week
                      FROM email_outbox`)
        ]);
        const disk = await diskSpace(app.config.documentDir);
        const status = {
            checked_at: new Date().toISOString(),
            server: {uptime_s: Math.round(process.uptime()), node: process.version, rss_mb: mb(memory.rss), heap_used_mb: mb(memory.heapUsed),
                event_loop_ms: {p50: +(loop.percentile(50) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1)}},
            database: {size_mb: mb(Number(size.bytes)), connections: conn.n, cache_hit_ratio: +Number(hits.ratio).toFixed(4),
                largest_tables: tables.map(t => ({name: t.name, rows: Number(t.rows), size_mb: mb(Number(t.bytes))}))},
            email: mail,
            disk: disk ? {free_gb: +(disk.free / 1024 ** 3).toFixed(1), total_gb: +(disk.total / 1024 ** 3).toFixed(1), free_share: +disk.share.toFixed(3)} : null,
            requests: app.metrics.summary({limit: 15})
        };
        loop.reset();
        return status;
    });
}
