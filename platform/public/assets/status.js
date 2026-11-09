// Admin page: system status (speed and health of the platform), loaded on request and refreshed every 30 seconds while open.
document.addEventListener('DOMContentLoaded', () => {
    const {$, tr, api, showError} = Shc;
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    let data = null, timer = null;
    const ms = n => `${n} ms`;
    const days = s => s >= 86400 ? tr(`${Math.floor(s / 86400)} d ${Math.floor(s % 86400 / 3600)} h`, `${Math.floor(s / 86400)} يوم ${Math.floor(s % 86400 / 3600)} ساعة`)
        : tr(`${Math.floor(s / 3600)} h ${Math.floor(s % 3600 / 60)} min`, `${Math.floor(s / 3600)} ساعة ${Math.floor(s % 3600 / 60)} دقيقة`);

    function table(caption, head, rows) {
        const t = el('table', {className: 'values'}, el('caption', {textContent: caption}));
        const tr_ = el('tr');
        head.forEach(h => tr_.append(el('th', {scope: 'col', textContent: h})));
        const body = el('tbody');
        rows.forEach(r => {
            const row = el('tr');
            r.forEach((cell, i) => row.append(i === 0 ? el('th', {scope: 'row', textContent: cell, dir: 'ltr'}) : el('td', {className: 'num', textContent: cell})));
            body.append(row);
        });
        t.append(el('thead', {}, tr_), body);
        return el('div', {className: 'values-box'}, t);
    }

    function render() {
        if (!data) return;
        const s = data.server, d = data.database;
        const warn = [];
        if (data.disk && data.disk.free_share < 0.1) warn.push(tr('Disk nearly full.', 'القرص شبه ممتلئ.'));
        if (data.email.failed_week) warn.push(tr(`${data.email.failed_week} emails could not be sent this week.`, `تعذر إرسال ${data.email.failed_week} رسالة هذا الأسبوع.`));
        if (data.requests.server_errors) warn.push(tr(`${data.requests.server_errors} server errors since the start.`, `${data.requests.server_errors} خطأ في الخادم منذ التشغيل.`));
        if (s.event_loop_ms.p99 > 100) warn.push(tr('The server is busy (slow event loop).', 'الخادم مشغول (تأخر في المعالجة).'));
        $('statusSummary').textContent = warn.length ? warn.join(' ') : tr('Everything looks healthy.', 'كل شيء يبدو سليماً.');
        $('statusSummary').className = 'msg ' + (warn.length ? 'error' : 'info');
        $('statusFacts').replaceChildren(table(tr('Server', 'الخادم'), [tr('Measure', 'المقياس'), tr('Value', 'القيمة')], [
            [tr('Running for', 'يعمل منذ'), days(s.uptime_s)], [tr('Memory', 'الذاكرة'), `${s.rss_mb} MB`],
            [tr('Delay p50 / p99', 'التأخير p50 / p99'), `${ms(s.event_loop_ms.p50)} / ${ms(s.event_loop_ms.p99)}`],
            [tr('Requests / errors', 'الطلبات / الأخطاء'), `${data.requests.requests} / ${data.requests.server_errors}`],
            [tr('Database', 'قاعدة البيانات'), `${d.size_mb} MB · ${d.connections} ${tr('connections', 'اتصالات')} · ${Math.round(d.cache_hit_ratio * 1000) / 10}% ${tr('from memory', 'من الذاكرة')}`],
            [tr('Email queue', 'طابور البريد'), `${data.email.waiting} ${tr('waiting', 'بالانتظار')} · ${data.email.failed_week} ${tr('failed (7 days)', 'فشلت (7 أيام)')}`],
            [tr('Disk', 'القرص'), data.disk ? `${data.disk.free_gb} / ${data.disk.total_gb} GB ${tr('free', 'متاح')}` : '—']
        ]));
        $('statusRoutes').replaceChildren(table(tr('Slowest routes (95% of answers faster than)', 'أبطأ المسارات (95% من الردود أسرع من)'),
            [tr('Route', 'المسار'), tr('Requests', 'الطلبات'), 'p50', 'p95', tr('Errors', 'أخطاء')],
            data.requests.slowest.map(r => [r.route, String(r.count), ms(r.p50), ms(r.p95), String(r.errors)])));
        $('statusTables').replaceChildren(table(tr('Largest tables', 'أكبر الجداول'), [tr('Table', 'الجدول'), tr('Rows (about)', 'الصفوف (تقريباً)'), 'MB'],
            d.largest_tables.map(t => [t.name, String(t.rows), String(t.size_mb)])));
        $('statusTime').textContent = tr('Checked at ', 'آخر فحص ') + new Date(data.checked_at).toLocaleTimeString(Shc.lang === 'ar' ? 'ar' : 'en-GB');
    }

    async function load() {
        const res = await api('/api/admin/status');
        if (!res.ok) return showError('statusError', res.data);
        data = res.data;
        $('statusBody').hidden = false;
        render();
    }

    $('statusBox').addEventListener('toggle', () => {
        clearInterval(timer);
        if ($('statusBox').open) {
            load();
            timer = setInterval(load, 30000);
        }
    });
    document.addEventListener('shc:language', render);
});
