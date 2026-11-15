// A pharmacy's own duty times (src/pharmacy-duty.js): add (once or weekly), list, delete.
document.addEventListener('DOMContentLoaded', async () => {
    const {$, tr, api, showError, busy} = Shc;
    const TZ = 'Asia/Damascus';
    const el = (tag, props = {}, ...children) => {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    };
    const locale = () => Shc.lang === 'ar' ? 'ar' : 'en-GB';
    const when = iso => new Date(iso).toLocaleString(locale(), {weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: TZ});
    const hour = iso => new Date(iso).toLocaleTimeString(locale(), {hour: '2-digit', minute: '2-digit', timeZone: TZ});
    let data = null;

    function fillRepeat() {
        const keep = $('repeat').value || '0';
        $('repeat').replaceChildren(el('option', {value: '0', textContent: tr('Only this day', 'هذا اليوم فقط')}),
            ...[1, 2, 3, 4, 6, 8, 12].map(n => el('option', {value: String(n), textContent: tr(`And the next ${n} weeks`, `والأسابيع الـ${n} التالية`)})));
        $('repeat').value = keep;
    }

    async function load() {
        const res = await api('/api/pharmacy/duties');
        $('main').setAttribute('aria-busy', 'false');
        if (res.status === 401) return window.location.assign('/staff?next=/duties');
        if (!res.ok) return showError('pageError', res.data);
        data = res.data;
        $('addCard').hidden = false;
        $('notApproved').hidden = data.approved;
        const today = new Date().toLocaleDateString('en-CA', {timeZone: TZ});
        $('date').min = today;
        $('date').max = new Date(Date.parse(today) + data.limits.daysAhead * 86400000).toISOString().slice(0, 10);
        if (!$('date').value) $('date').value = today;
        render();
    }

    function render() {
        fillRepeat();
        $('announce').textContent = data.duties.length ? tr(`${data.duties.length} upcoming duties`, `${data.duties.length} مناوبات قادمة`) : tr('No upcoming duties.', 'لا توجد مناوبات قادمة.');
        $('list').replaceChildren(...data.duties.map(d => {
            const remove = el('button', {type: 'button', className: 'link-btn', textContent: tr('Delete', 'حذف')});
            remove.onclick = async () => {
                busy(remove, true);
                const res = await api(`/api/pharmacy/duties/${d.id}/delete`, {});
                busy(remove, false);
                if (!res.ok) return showError('pageError', res.data);
                await load();
                $('announce').focus();
            };
            return el('li', {className: 'appt'}, el('h3', {textContent: when(d.starts_at)}),
                el('p', {className: 'muted-small', textContent: tr(`Until ${hour(d.ends_at)}`, `حتى ${hour(d.ends_at)}`) + (d.note ? ' · ' + d.note : '')}), remove);
        }));
    }

    $('addForm').addEventListener('submit', async event => {
        event.preventDefault();
        $('pageError').hidden = true;
        busy($('add'), true);
        const res = await api('/api/pharmacy/duties', {date: $('date').value, from: $('from').value, to: $('to').value,
            repeat_weeks: Number($('repeat').value), ...($('note').value.trim() && {note: $('note').value})});
        busy($('add'), false);
        if (!res.ok) return showError('pageError', res.data);
        await load();
        $('announce').textContent = tr(`${res.data.duties.length} duties added.`, `أُضيفت ${res.data.duties.length} مناوبات.`);
        $('announce').focus();
    });
    document.addEventListener('shc:language', () => data && render());
    fillRepeat();
    load();
});
