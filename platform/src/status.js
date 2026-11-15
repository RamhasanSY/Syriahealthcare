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
        // Each figure on its own: one slow or failing query leaves its figure empty instead of failing the page.
        const figure = async (sql, fallback) => {
            try {
                return (await db.query(sql)).rows;
            } catch (error) {
                app.log.warn({err: error}, 'Status figure not available');
                return fallback;
            }
        };
        // The size is the sum of our own tables and indexes: pg_database_size() walks every file of the cluster and can
        // take seconds on slow disks.
        const [[conn], [hits], tables, [mail]] = await Promise.all([
            figure('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()', [{n: null}]),
            figure(`SELECT CASE WHEN blks_hit + blks_read = 0 THEN 1 ELSE blks_hit::float / (blks_hit + blks_read) END AS ratio
                    FROM pg_stat_database WHERE datname = current_database()`, [{ratio: null}]),
            figure(`SELECT c.relname AS name, greatest(c.reltuples, 0)::bigint AS rows, pg_total_relation_size(c.oid)::bigint AS bytes
                    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`, []),
            figure(`SELECT count(*) FILTER (WHERE sent_at IS NULL AND failed_at IS NULL)::int AS waiting,
                           count(*) FILTER (WHERE failed_at > now() - interval '7 days')::int AS failed_week
                    FROM email_outbox`, [{waiting: null, failed_week: null}])
        ]);
        const largest = [...tables].sort((a, b) => Number(b.bytes) - Number(a.bytes)).slice(0, 8);
        const totalBytes = tables.reduce((sum, t) => sum + Number(t.bytes), 0);
        const disk = await diskSpace(app.config.documentDir);
        const status = {
            checked_at: new Date().toISOString(),
            server: {uptime_s: Math.round(process.uptime()), node: process.version, rss_mb: mb(memory.rss), heap_used_mb: mb(memory.heapUsed),
                event_loop_ms: {p50: +(loop.percentile(50) / 1e6).toFixed(1), p99: +(loop.percentile(99) / 1e6).toFixed(1), max: +(loop.max / 1e6).toFixed(1)}},
            database: {size_mb: tables.length ? mb(totalBytes) : null, connections: conn.n, cache_hit_ratio: hits.ratio === null ? null : +Number(hits.ratio).toFixed(4),
                largest_tables: largest.map(t => ({name: t.name, rows: Number(t.rows), size_mb: mb(Number(t.bytes))}))},
            email: mail,
            disk: disk ? {free_gb: +(disk.free / 1024 ** 3).toFixed(1), total_gb: +(disk.total / 1024 ** 3).toFixed(1), free_share: +disk.share.toFixed(3)} : null,
            requests: app.metrics.summary({limit: 15})
        };
        loop.reset();
        return status;
    });
}
