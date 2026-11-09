// Response times and errors per route since the server started, for the administrators' status page.
// Only route patterns ("/api/doctors/:id"), never URLs with ids or query strings, and nothing about who asked.
const KEEP = 500;  // the last 500 durations per route are enough for p50 and p95

export function createMetrics() {
    const routes = new Map();
    const startedAt = Date.now();
    let total = 0, errors = 0;
    return {
        record(method, route, status, ms) {
            const key = `${method} ${route}`;
            let r = routes.get(key);
            if (!r) routes.set(key, r = {count: 0, errors: 0, max: 0, recent: []});
            r.count++;
            total++;
            if (status >= 500) { r.errors++; errors++; }
            if (ms > r.max) r.max = ms;
            r.recent.push(ms);
            if (r.recent.length > KEEP) r.recent.shift();
        },
        summary({limit = 20} = {}) {
            const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
            const list = [...routes.entries()].map(([key, r]) => {
                const sorted = [...r.recent].sort((a, b) => a - b);
                return {route: key, count: r.count, errors: r.errors, p50: +pct(sorted, 0.5).toFixed(1), p95: +pct(sorted, 0.95).toFixed(1), max: +r.max.toFixed(1)};
            });
            return {since: new Date(startedAt).toISOString(), requests: total, server_errors: errors,
                slowest: list.sort((a, b) => b.p95 - a.p95).slice(0, limit),
                busiest: [...list].sort((a, b) => b.count - a.count).slice(0, limit)};
        }
    };
}
