(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    // Links shared before the site had separate pages (e.g. /#jobs) open the new page instead.
    const moved = {jobs: 'jobs.html', saved: 'jobs.html#saved', toolkit: 'jobs.html#toolkit', news: 'news.html', doctors: 'doctors.html', labs: 'labs.html',
        hospitals: 'hospitals.html', pregnancy: 'pregnancy.html', about: 'about.html', sources: 'about.html#sources'};
    const openMoved = () => {
        const target = moved[window.location.hash.slice(1)];
        if (target && $('homeJobs')) window.location.replace(target);
        return Boolean(target && $('homeJobs'));
    };
    if (openMoved()) return;
    window.addEventListener('hashchange', openMoved);
    // On phones the menu scrolls sideways: bring the current page's link into view without moving the page.
    const menu = document.querySelector('.header-nav'), current = menu?.querySelector('[aria-current=page]');
    if (current && menu.scrollWidth > menu.clientWidth) {
        menu.scrollLeft += current.getBoundingClientRect().left - menu.getBoundingClientRect().left - (menu.clientWidth - current.offsetWidth) / 2;
    }
    let canPersist = true;
    let lang = 'en',
        saved = new Set();
    try {
        lang = localStorage.getItem('shc-lang') === 'ar' ? 'ar' : 'en';
        const stored = JSON.parse(localStorage.getItem('shc-saved') || '[]');
        if (Array.isArray(stored)) saved = new Set(stored.filter(x => typeof x === 'string'));
    } catch (_) { canPersist = false; }
    let topic = 'all',
        location = '',
        organisation = '',
        sector = 'all',
        sort = 'newest',
        query = '',
        newsLimit = 6;
    let sources = {},
        editor = {},
        sourceStatus = {};
    const feeds = {
        news: {
            items: [],
            loading: true
        },
        jobs: {
            items: [],
            loading: true
        }
    };
    const topics = {
        all: ['All stories', 'كل الأخبار'],
        hospitals: ['Hospitals & clinics', 'المشافي والعيادات'],
        'public-health': ['Public health', 'الصحة العامة'],
        aid: ['Aid & funding', 'الإغاثة والتمويل'],
        workforce: ['Workforce', 'الكوادر الصحية'],
        policy: ['Policy', 'السياسات'],
        other: ['Other', 'أخرى']
    };
    const tr = (en, ar) => lang === 'ar' ? ar : en;
    const value = (item, key) => item[key + '_' + lang] || item[key + '_en'] || item[key] || item[key + '_ar'] || '';
    const label = key => (topics[key] || topics.other)[lang === 'ar' ? 1 : 0];
    const key = item => item.id || item.url;

    function node(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    }

    function safeURL(raw) {
        try {
            const u = new URL(raw);
            return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : '';
        } catch (_) {
            return '';
        }
    }

    function link(text, url, cls) {
        const a = node('a', cls, text);
        a.href = safeURL(url);
        a.rel = 'noopener noreferrer';
        return a;
    }

    function timestamp(raw) {
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)) return NaN;
        const day = raw.slice(0, 10), calendar = new Date(day + 'T00:00:00Z');
        if (isNaN(calendar) || calendar.toISOString().slice(0, 10) !== day) return NaN;
        // Date.parse accepts 24:00 by rolling into tomorrow; feeds must use real times.
        if (raw.length > 10 && (+raw.slice(11, 13) > 23 || +raw.slice(14, 16) > 59 || +raw.slice(17, 19) > 59)) return NaN;
        return Date.parse(raw);
    }

    function date(raw) {
        const d = new Date(timestamp(raw));
        return !isNaN(d) ? d.toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC'
        }) : '';
    }

    function checkedTime(raw) {
        const d = new Date(timestamp(raw));
        return !isNaN(d) ? d.toLocaleString(lang === 'ar' ? 'ar' : 'en-GB', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'
        }) + ' UTC' : '';
    }

    function deadlineTime(job) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(job.deadline || '') || !Number.isFinite(timestamp(job.deadline))) return NaN;
        return job.deadline_at ? timestamp(job.deadline_at) : timestamp(job.deadline) + 86400000 - 1;
    }

    function validRecord(item, kind) {
        if (!item || typeof item !== 'object' || item.verification_version !== 2 || !safeURL(item.url) || !value(item, 'title')) return false;
        const now = Date.now(), published = timestamp(item.published), verified = timestamp(item.verified_at);
        if (!Number.isFinite(published) || !Number.isFinite(verified) || published > now + 3600000 || verified > now + 3600000) return false;
        return kind === 'news' ? now - published <= 45 * 86400000 : deadlineTime(item) >= now && now - verified <= 72 * 3600000;
    }

    function openNews() {
        return feeds.news.items.filter(n => validRecord(n, 'news'));
    }

    function preserveFocus(render) {
        const active = document.activeElement,
            href = active?.tagName === 'A' ? active.href : '',
            parentClass = active?.parentElement?.className;
        render();
        if (!active || active.isConnected) return;
        let replacement = active.id ? $(active.id) : null;
        if (href) replacement = [...document.querySelectorAll('a')].find(n => n.href === href && n.className === active.className && n.parentElement.className === parentClass);
        if (active.dataset.key) replacement = [...document.querySelectorAll('.save-job')].find(n => n.dataset.key === active.dataset.key) || document.querySelector('[data-sector="saved"]');
        if (active.dataset.topic && $('newsFilters')) replacement = [...$('newsFilters').querySelectorAll('button')].find(n => n.dataset.topic === active.dataset.topic);
        if (active.closest('.empty') || active.id === 'clearFilters') replacement = $('search');
        (replacement || $('search'))?.focus({preventScroll: true});
    }

    function normalize(text) {
        return String(text).normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').toLocaleLowerCase();
    }

    function matches(item) {
        return !query || normalize(['title', 'title_en', 'title_ar', 'source', 'organisation', 'location'].map(k => item[k] || '').join(' ')).includes(query);
    }

    function openJobs() {
        return feeds.jobs.items.filter(j => validRecord(j, 'jobs'));
    }

    function staticText() {
        document.documentElement.lang = lang;
        document.documentElement.dir = document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelectorAll('[data-en]').forEach(n => {
            n.textContent = n.dataset[lang] || n.dataset.en;
        });
        document.querySelectorAll('[data-label-en]').forEach(n => n.setAttribute('aria-label', n.getAttribute('data-label-' + lang)));
        document.querySelectorAll('[data-placeholder-en]').forEach(n => n.placeholder = n.getAttribute('data-placeholder-' + lang));
        const page = document.documentElement.dataset;
        if (page.titleEn) document.title = tr(page.titleEn, page.titleAr || page.titleEn);
        if (page.descEn) document.querySelector('meta[name=description]').content = tr(page.descEn, page.descAr || page.descEn);
        $('langToggle').textContent = tr('العربية', 'English');
        $('langToggle').lang = tr('ar', 'en');
        $('langToggle').setAttribute('aria-label', tr('Switch to Arabic', 'التبديل إلى الإنجليزية'));
        savedHint();
    }

    function savedHint() {
        if (!$('savedHint')) return;
        $('savedHint').textContent = canPersist ? tr('Save a role to revisit on this device.', 'احفظ الوظيفة للعودة إليها على هذا الجهاز.') : tr('Bookmarks last only while this page stays open.', 'تبقى الوظائف المحفوظة متاحة ما دامت هذه الصفحة مفتوحة.');
    }

    function stamp(kind) {
        const f = feeds[kind],
            n = $(kind + 'Stamp'),
            checked = checkedTime(f.updated);
        if (!n) return;
        const stale = checked && Date.now() - new Date(f.updated).getTime() > 48 * 3600000;
        n.textContent = checked ? tr('Last checked: ', 'آخر فحص: ') + checked + (stale ? tr(' · Updates delayed', ' · التحديثات متأخرة') : '') : '';
        if (f.status === 'partial' || f.status === 'error') n.textContent += tr(' · Some sources unavailable', ' · بعض المصادر غير متاحة');
        if (f.error) n.textContent += f.items.length ? tr(' · Refresh failed. Showing previously loaded results.', ' · تعذر التحديث. نعرض النتائج المحمّلة سابقاً.') : tr(' · Feed unavailable. Try again below.', ' · الخلاصة غير متاحة. حاول مجدداً أدناه.');
        n.classList.toggle('stale', Boolean(stale || f.error || f.status === 'partial' || f.status === 'error'));
        $(kind + 'List').setAttribute('aria-busy', String(f.loading));
    }

    function clearFilters() {
        query = '';
        topic = 'all';
        location = '';
        organisation = '';
        sector = 'all';
        newsLimit = 6;
        if ($('search')) $('search').value = '';
        renderAll();
        $('search')?.focus({preventScroll: true});
    }

    function emptyState(kind, hasResults, filtered) {
        const box = $(kind + 'Empty'),
            f = feeds[kind];
        box.hidden = hasResults;
        box.replaceChildren();
        if (hasResults) return;
        let heading, body;
        if (f.loading) {
            heading = tr('Finding the latest updates…', 'جارٍ جلب آخر التحديثات…');
            body = tr('Loading available content from our source checks.', 'نحمّل المحتوى المتاح من فحوص مصادرنا.');
        } else if (f.error) {
            heading = tr('Unable to load this feed', 'تعذر تحميل هذه الخلاصة');
            body = tr('Please try again, or explore the original sources below.', 'حاول مجدداً أو تصفح المصادر الأصلية أدناه.');
        } else if (kind === 'jobs' && sector === 'saved' && !saved.size) {
            heading = tr('Your next step, saved for later.', 'خطوتك القادمة، محفوظة لوقت لاحق.');
            body = tr('Use the bookmark on any job card to save it on this device.', 'استخدم علامة الحفظ على بطاقة الوظيفة لحفظها على هذا الجهاز.');
        } else if (filtered) {
            heading = tr('No matching results', 'لا توجد نتائج مطابقة');
            body = tr('Try another keyword, location or organization.', 'جرّب كلمة أو موقعاً أو منظمة أخرى.');
        } else {
            heading = kind === 'news' ? tr('More stories are on the way', 'المزيد من الأخبار قريباً') : tr('No current openings', 'لا توجد وظائف حالية');
            body = tr('Check the original sources for more information.', 'راجع المصادر الأصلية للمزيد من المعلومات.');
        }
        const symbol = node('span', 'empty-symbol', '✳');
        symbol.setAttribute('aria-hidden', 'true');
        box.append(symbol, node('h3', '', heading), node('p', '', body));
        if (f.error || filtered) {
            const b = node('button', '', f.error ? tr('Try again', 'حاول مجدداً') : tr('Clear filters', 'مسح التصفية'));
            b.type = 'button';
            b.onclick = () => f.error ? loadFeed(kind) : clearFilters();
            box.append(b);
        } else if (!f.loading) {
            const a = node('a', '', tr('Explore our sources →', 'تصفح مصادرنا ←'));
            a.href = 'about.html#sources';
            box.append(a);
        }
    }

    function selectOptions(id, all, values, selected) {
        const select = $(id),
            first = node('option', '', all);
        first.value = '';
        select.replaceChildren(first);
        values.forEach(v => {
            const option = node('option', '', v);
            option.value = v;
            select.append(option);
        });
        select.value = selected;
        if (select.selectedIndex < 0) {
            select.value = '';
            return '';
        }
        return selected;
    }

    function filters() {
        if ($('newsFilters')) newsFilters();
        if (!$('location')) return;
        location = selectOptions('location', tr('All locations', 'جميع المواقع'), [...new Set(openJobs().map(j => j.location).filter(Boolean))].sort(), location);
        organisation = selectOptions('organisation', tr('All organizations', 'جميع المنظمات'), [...new Set(openJobs().map(j => j.organisation).filter(Boolean))].sort(), organisation);
        $('sectorFilters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sector === sector)));
        $('jobSort').value = sort;
    }

    function newsFilters() {
        const present = ['all', ...new Set(openNews().map(n => n.topic || 'other'))];
        if (!present.includes(topic)) topic = 'all';
        $('newsFilters').replaceChildren();
        present.forEach(t => {
            const b = node('button', '', label(t));
            b.type = 'button';
            b.dataset.topic = t;
            b.setAttribute('aria-pressed', String(topic === t));
            b.onclick = () => {
                topic = t;
                newsLimit = 6;
                $('newsFilters').querySelectorAll('button').forEach(n => n.setAttribute('aria-pressed', String(n === b)));
                renderNews();
            };
            $('newsFilters').append(b);
        });
    }

    function renderNews() {
        renderHomeNews();
        renderStats();
        if (!$('newsList')) return;
        const items = openNews().filter(n => (topic === 'all' || (n.topic || 'other') === topic) && matches(n));
        $('newsList').replaceChildren();
        $('newsCount').textContent = tr(`${items.length} stories`, `${items.length} أخبار`);
        items.slice(0, newsLimit).forEach(n => {
            const li = node('li'),
                meta = node('div', 'card-meta');
            meta.append(node('span', 'topic', label(n.topic)), node('span', '', n.source));
            if (date(n.published)) {
                const time = node('time', '', date(n.published));
                time.dateTime = n.published;
                meta.append(time);
            }
            const title = node('h3', 'card-title');
            title.dir = 'auto';
            title.append(link(value(n, 'title'), n.url));
            li.append(meta, title, node('p', 'card-summary', n.language === 'ar' ? tr('Original headline in Arabic', 'العنوان الأصلي بالعربية') : tr('Original headline in English', 'العنوان الأصلي بالإنجليزية')), link(tr('Read the original story ↗', 'اقرأ الخبر الأصلي ↖'), n.url, 'read-link'));
            $('newsList').append(li);
        });
        $('moreNews').hidden = items.length <= newsLimit;
        emptyState('news', items.length > 0, Boolean(query || topic !== 'all'));
        stamp('news');
        $('newsResult').textContent = tr(`${items.length} matching stories`, `${items.length} أخبار مطابقة`);
    }

    function avatarName(job) {
        const names = {
            'sams-jobs': 'SAMS',
            'ida-jobs': 'IDA',
            'nrc-jobs': 'NRC',
            'drc-jobs': 'DRC'
        };
        return names[job.source_id] || (job.organisation || job.source || 'NGO').split(/\s+/).slice(0, 3).map(x => x[0]).join('').toUpperCase();
    }

    function bookmark(job) {
        const b = node('button', 'save-job');
        b.type = 'button';
        b.dataset.key = key(job);
        b.setAttribute('aria-pressed', String(saved.has(key(job))));
        b.setAttribute('aria-label', (saved.has(key(job)) ? tr('Unsave job: ', 'إلغاء حفظ الوظيفة: ') : tr('Save job: ', 'حفظ الوظيفة: ')) + value(job, 'title'));
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 20 24');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M4 3h12v18l-6-4-6 4z');
        svg.append(path);
        b.append(svg);
        b.onclick = () => {
            const id = key(job);
            saved.has(id) ? saved.delete(id) : saved.add(id);
            try {
                localStorage.setItem('shc-saved', JSON.stringify([...saved]));
            } catch (_) { canPersist = false; }
            savedHint();
            renderJobs();
            const again = Array.from(document.querySelectorAll('.save-job')).find(n => n.dataset.key === id);
            (again || document.querySelector('[data-sector="saved"]')).focus();
        };
        return b;
    }

    function renderFeatured() {
        const all = openJobs(),
            first = [...all].sort((a, b) => deadlineTime(a) - deadlineTime(b))[0],
            pill = document.querySelector('.spotlight-top .pill');
        if (!$('heroJobCount')) return;
        $('heroJobCount').textContent = feeds.jobs.loading && !all.length ? '—' : all.length;
        $('heroOrgCount').textContent = feeds.jobs.loading && !all.length ? '—' : new Set(all.map(j => j.organisation).filter(Boolean)).size;
        pill.hidden = !first;
        pill.textContent = first && deadlineTime(first) - Date.now() <= 3 * 86400000 ? tr('Closing soon', 'الموعد يقترب') : tr('Featured opportunity', 'فرصة مميزة');
        if (!first) {
            $('featuredOrg').textContent = tr('From original employers', 'من الجهات الموظفة الأصلية');
            $('featuredTitle').textContent = tr('Find work that matters.', 'ابحث عن عمل يصنع فرقاً.');
            $('featuredMeta').textContent = '';
            $('featuredLink').href = 'jobs.html';
            return;
        }
        $('featuredOrg').textContent = first.organisation;
        $('featuredTitle').textContent = value(first, 'title');
        $('featuredTitle').dir = 'auto';
        $('featuredMeta').textContent = first.location + ' · ' + tr('Closes ', 'يغلق في ') + (first.deadline_at ? checkedTime(first.deadline_at) : date(first.deadline));
        $('featuredLink').href = safeURL(first.url);
    }

    function renderJobs() {
        renderFeatured();
        renderStats();
        renderHomeJobs();
        if (!$('jobsList')) return;
        let items = openJobs().filter(j => (!location || j.location === location) && (!organisation || j.organisation === organisation) && (sector === 'all' || (sector === 'saved' ? saved.has(key(j)) : (j.sector || 'healthcare') === sector)) && matches(j));
        items.sort((a, b) => sort === 'deadline' ? deadlineTime(a) - deadlineTime(b) : (b.published || '').localeCompare(a.published || ''));
        const filtered = Boolean(query || location || organisation || sector !== 'all');
        $('jobsList').replaceChildren();
        $('jobsCount').textContent = tr(`${items.length} opportunities found`, `${items.length} فرص متاحة`);
        $('clearFilters').hidden = !filtered;
        items.forEach(j => {
            const li = node('li'),
                top = node('div', 'job-card-top'),
                isNGO = j.sector === 'ngo';
            top.append(node('span', 'org-avatar' + (isNGO ? ' ngo' : ''), avatarName(j)), node('p', 'job-organisation', j.organisation || j.source), bookmark(j));
            const title = node('h3', 'job-title');
            title.dir = 'auto';
            title.append(link(value(j, 'title'), j.url));
            const tags = node('div', 'job-tags');
            tags.append(node('span', 'pill' + (isNGO ? ' warm' : ''), isNGO ? tr('NGO & humanitarian', 'منظمات وعمل إنساني') : j.role_type === 'clinical' ? tr('Clinical / healthcare', 'طبي / صحي') : tr('Health-sector support', 'دعم القطاع الصحي')));
            if (j.contract) tags.append(node('span', 'pill', j.contract));
            li.append(top, title, node('p', 'job-location', j.location), tags);
            if (j.reference && j.listing_page) li.append(node('p', 'job-reference', tr('Opens the employer’s vacancy board. Find reference ', 'يفتح قائمة وظائف الجهة الموظفة. ابحث عن الرقم ') + j.reference + tr(' and select “Register to Apply”.', ' ثم اختر «Register to Apply».')));
            const bottom = node('div', 'job-card-bottom'),
                deadline = node('p', 'job-deadline', tr('Closes ', 'يغلق في ') + (j.deadline_at ? checkedTime(j.deadline_at) : date(j.deadline)));
            if (deadlineTime(j) - Date.now() <= 3 * 86400000) deadline.classList.add('urgent');
            const tools = node('div', 'job-tools');
            tools.append(shareButton(j), calendarButton(j));
            bottom.append(deadline, tools, link(j.listing_page ? tr('View openings ↗', 'عرض الوظائف ↖') : tr('View role ↗', 'عرض الوظيفة ↖'), j.url, 'apply-link'));
            li.append(bottom);
            $('jobsList').append(li);
        });
        emptyState('jobs', items.length > 0, filtered);
        stamp('jobs');
        $('jobsResult').textContent = tr(`${items.length} opportunities shown`, `${items.length} فرص معروضة`);
    }

    function shareButton(job) {
        const b = node('button', 'tool-btn', tr('Share', 'مشاركة'));
        b.type = 'button';
        b.setAttribute('aria-label', tr('Share job: ', 'مشاركة الوظيفة: ') + value(job, 'title'));
        b.onclick = async () => {
            const title = value(job, 'title') + ' — ' + (job.organisation || job.source), url = safeURL(job.url);
            if (navigator.share) {
                try { await navigator.share({title, url}); } catch (_) {}
            } else {
                window.open('https://wa.me/?text=' + encodeURIComponent(title + '\n' + url), '_blank', 'noopener,noreferrer');
            }
        };
        return b;
    }

    function calendarButton(job) {
        const b = node('button', 'tool-btn', tr('Remind me', 'ذكّرني'));
        b.type = 'button';
        b.setAttribute('aria-label', tr('Add deadline to calendar: ', 'إضافة الموعد إلى التقويم: ') + value(job, 'title'));
        b.onclick = () => {
            const d = job.deadline.replace(/-/g, ''),
                next = new Date(timestamp(job.deadline) + 86400000).toISOString().slice(0, 10).replace(/-/g, '');
            const esc = t => String(t).replace(/[\\;,]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
            const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Syria Healthcare//EN', 'BEGIN:VEVENT',
                'UID:' + d + '-' + Math.abs([...key(job)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) + '@syriahealthcare.com',
                'DTSTAMP:' + new Date().toISOString().replace(/[-:]|\.\d{3}/g, ''),
                'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + next,
                'SUMMARY:' + esc('Deadline: ' + value(job, 'title') + ' (' + (job.organisation || job.source) + ')'),
                'DESCRIPTION:' + esc('Confirm the closing time in the original announcement: ' + safeURL(job.url)),
                'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
            const a = node('a');
            a.href = URL.createObjectURL(new Blob([ics], {type: 'text/calendar'}));
            a.download = 'deadline.ics';
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        };
        return b;
    }

    function renderStats() {
        if (!$('statJobs')) return;
        const jobs = openJobs(), loading = feeds.jobs.loading && !jobs.length;
        $('statJobs').textContent = loading ? '—' : jobs.length;
        $('statClosing').textContent = loading ? '—' : jobs.filter(j => deadlineTime(j) - Date.now() <= 7 * 86400000).length;
        $('statNews').textContent = feeds.news.loading && !feeds.news.items.length ? '—' : openNews().length;
        $('statSources').textContent = (sources.news || []).length + (sources.jobs || []).length || '—';
    }

    function renderChecklist(listId = 'checklist', storageKey = 'shc-checklist', progressId = 'toolkitProgress') {
        if (!$(progressId)) return;
        let done = [];
        try { done = JSON.parse(localStorage.getItem(storageKey) || '[]'); } catch (_) {}
        const boxes = [...document.querySelectorAll('#' + listId + ' input')];
        boxes.forEach(b => {
            b.checked = Array.isArray(done) && done.includes(b.dataset.item);
            b.onchange = () => {
                try { localStorage.setItem(storageKey, JSON.stringify(boxes.filter(x => x.checked).map(x => x.dataset.item))); } catch (_) {}
                renderChecklist(listId, storageKey, progressId);
            };
        });
        const n = boxes.filter(b => b.checked).length;
        $(progressId).textContent = n === boxes.length ? tr('All set — good luck!', 'كل شيء جاهز، بالتوفيق!') : tr(`${n} of ${boxes.length} ready`, `${n} من ${boxes.length} جاهز`);
    }

    // Directories of doctors, labs and hospitals. Records come only from data/*.json; nothing is generated.
    const availability = {
        accepting: ['Accepting patients', 'يستقبل المرضى'],
        limited: ['Limited availability', 'مواعيد محدودة'],
        not_accepting: ['Not accepting new patients', 'لا يستقبل مرضى جدداً']
    };
    const directories = {
        doctors: {
            // Platform doctors are bookable online; hand-added entries state their availability.
            valid: d => value(d, 'name') && value(d, 'specialty') && value(d, 'city') && (safeURL(d.booking_url) || availability[d.availability]),
            text: d => [d.name, d.name_ar, d.specialty, d.specialty_ar, d.city, d.city_ar, d.address],
            filters: {
                Specialty: {all: ['All specialties', 'جميع الاختصاصات'], values: d => [value(d, 'specialty')]},
                City: {all: ['All cities', 'جميع المدن'], values: d => [value(d, 'city')]},
                Availability: {all: ['Any availability', 'أي توفر'], values: d => [safeURL(d.booking_url) ? tr('Book online', 'حجز عبر الإنترنت') : availability[d.availability][lang === 'ar' ? 1 : 0]]}
            },
            count: n => tr(n === 1 ? '1 doctor found' : `${n} doctors found`, `${n} أطباء`),
            card: (li, d) => {
                const tags = node('div', 'job-tags');
                const online = safeURL(d.booking_url);
                tags.append(online ? node('span', 'pill', tr('Online booking', 'حجز إلكتروني')) : node('span', 'pill' + (d.availability === 'accepting' ? '' : ' warm'), availability[d.availability][lang === 'ar' ? 1 : 0]));
                li.append(node('p', 'job-organisation', value(d, 'specialty')), heading(value(d, 'name')), node('p', 'job-location', [value(d, 'city'), d.address].filter(Boolean).join(' · ')), tags);
                if (value(d, 'hours')) li.append(node('p', 'job-reference', value(d, 'hours')));
                contact(li, d, online ? link(tr('Book online ↗', 'احجز موعداً ↖'), online, 'apply-link') : undefined);
            }
        },
        labs: {
            valid: l => value(l, 'name') && value(l, 'city') && value(l, 'address'),
            text: l => [l.name, l.name_ar, l.city, l.city_ar, l.address, ...(l.tests || []), ...(l.tests_ar || [])],
            filters: {
                Test: {all: ['All tests', 'جميع التحاليل'], values: l => (lang === 'ar' && l.tests_ar) || l.tests || []},
                City: {all: ['All cities', 'جميع المدن'], values: l => [value(l, 'city')]}
            },
            count: n => tr(n === 1 ? '1 lab found' : `${n} labs found`, `${n} مخابر`),
            rank: l => l.platform === true ? 1 : 0,
            card: (li, l) => {
                li.append(node('p', 'job-organisation', [value(l, 'type'), value(l, 'city')].filter(Boolean).join(' · ')), heading(value(l, 'name')), node('p', 'job-location', value(l, 'address')));
                const tests = (lang === 'ar' && l.tests_ar) || l.tests || [];
                if (tests.length || l.platform === true) {
                    const tags = node('div', 'job-tags');
                    if (l.platform === true) tags.append(verifiedPill());
                    tests.forEach(t => tags.append(node('span', 'pill', t)));
                    li.append(tags);
                }
                if (value(l, 'hours')) li.append(node('p', 'job-reference', value(l, 'hours')));
                contact(li, l);
            }
        },
        hospitals: {
            valid: h => value(h, 'name') && value(h, 'city'),
            rank: h => (h.platform === true ? 8 : 0) + (h.phone ? 4 : 0) + (h.emergency === true ? 2 : 0) + (h.address ? 1 : 0),
            text: h => [h.name, h.name_ar, h.city, h.city_ar, h.address, h.address_ar],
            filters: {
                City: {all: ['All governorates', 'جميع المحافظات'], values: h => [value(h, 'city')]}
            },
            count: n => tr(n === 1 ? '1 hospital found' : `${n} hospitals found`, `${n} مشافٍ`),
            card: (li, h) => {
                const address = value(h, 'address');
                li.append(node('p', 'job-organisation', [value(h, 'type'), value(h, 'city')].filter(Boolean).join(' · ')), heading(value(h, 'name')));
                if (address) li.append(node('p', 'job-location', address));
                const services = (lang === 'ar' && h.services_ar) || h.services || [];
                if (h.emergency === true || h.platform === true || services.length) {
                    const tags = node('div', 'job-tags');
                    if (h.platform === true) tags.append(verifiedPill());
                    if (h.emergency === true) tags.append(node('span', 'pill warm', tr('Emergency department', 'قسم إسعاف')));
                    services.forEach(s => tags.append(node('span', 'pill', s)));
                    li.append(tags);
                }
                if (value(h, 'hours')) li.append(node('p', 'job-reference', value(h, 'hours')));
                contact(li, h, link(tr('Open in Google Maps ↗', 'افتح في خرائط Google ↖'), mapsURL(h), 'apply-link'));
            }
        }
    };
    const directoryState = Object.fromEntries(Object.keys(directories).map(k => [k, {items: [], loading: true, error: false, query: '', picks: {}, limit: 12}]));

    // A plain Maps search URL from the stored address fields: no API key, no coordinates.
    // Entries that came from the platform: their operating licence was checked by our team.
    const verifiedPill = () => node('span', 'pill verified', tr('Verified licence', 'ترخيص موثَّق'));

    function mapsURL(h) {
        return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent([h.name, h.address, h.city, h.country || 'Syria'].filter(Boolean).join(', '));
    }

    function heading(text) {
        const h = node('h3', 'job-title', text);
        h.dir = 'auto';
        return h;
    }

    function contact(li, item, action) {
        const bottom = node('div', 'job-card-bottom'), phone = String(item.phone || '').trim();
        if (phone) {
            const a = node('a', 'job-deadline', phone);
            a.href = 'tel:' + phone.replace(/[^\d+]/g, '');
            a.dir = 'ltr';
            bottom.append(a);
        }
        if (safeURL(item.source_url)) bottom.append(link(item.osm ? tr('OpenStreetMap ↗', 'OpenStreetMap ↖') : tr('Source ↗', 'المصدر ↖'), item.source_url, 'read-link'));
        if (action) bottom.append(action);
        if (bottom.children.length) li.append(bottom);
    }

    function renderDirectory(kind) {
        if (!$(kind + 'List')) return;
        const cfg = directories[kind], st = directoryState[kind], all = st.items.filter(cfg.valid);
        Object.entries(cfg.filters).forEach(([name, f]) => {
            const options = [...new Set(all.flatMap(f.values).filter(Boolean))].sort((a, b) => a.localeCompare(b, lang));
            st.picks[name] = selectOptions(kind + name, tr(...f.all), options, st.picks[name] || '');
        });
        const items = all.filter(i => (!st.query || normalize(cfg.text(i).filter(Boolean).join(' ')).includes(st.query))
            && Object.entries(cfg.filters).every(([name, f]) => !st.picks[name] || f.values(i).includes(st.picks[name])));
        const filtered = Boolean(st.query || Object.values(st.picks).some(Boolean));
        if (cfg.rank) items.sort((a, b) => cfg.rank(b) - cfg.rank(a));
        $(kind + 'List').replaceChildren();
        $(kind + 'List').setAttribute('aria-busy', String(st.loading));
        items.slice(0, st.limit).forEach(i => {
            const li = node('li');
            cfg.card(li, i);
            $(kind + 'List').append(li);
        });
        const more = $(kind + 'More');
        more.hidden = items.length <= st.limit;
        more.textContent = tr(`Show more (${items.length - st.limit} more)`, `عرض المزيد (${items.length - st.limit})`);
        more.onclick = () => {
            const next = st.limit;
            st.limit += 12;
            renderDirectory(kind);
            $(kind + 'List').children[next]?.querySelector('a')?.focus({preventScroll: true});
        };
        $(kind + 'Count').textContent = st.loading ? '' : cfg.count(items.length);
        $(kind + 'Result').textContent = st.loading ? '' : cfg.count(items.length);
        const box = $(kind + 'Empty');
        box.hidden = items.length > 0;
        box.replaceChildren();
        if (items.length) return;
        const symbol = node('span', 'empty-symbol', '✳');
        symbol.setAttribute('aria-hidden', 'true');
        let title, body;
        if (st.loading) [title, body] = [tr('Loading the directory…', 'جارٍ تحميل الدليل…'), ''];
        else if (st.error) [title, body] = [tr('Unable to load this directory', 'تعذر تحميل هذا الدليل'), tr('Please try again later.', 'يرجى المحاولة لاحقاً.')];
        else if (filtered) [title, body] = [tr('No matching results', 'لا توجد نتائج مطابقة'), tr('Try another keyword or filter.', 'جرّب كلمة أو تصفية أخرى.')];
        else [title, body] = [tr('Coming soon', 'قريباً'), tr('We only list entries we have checked, so this directory is still being prepared.', 'لا ندرج إلا ما تحققنا منه، لذلك ما زال هذا الدليل قيد الإعداد.')];
        box.append(symbol, node('h3', '', title));
        if (body) box.append(node('p', '', body));
        if (!st.loading && !filtered && kind !== 'hospitals') {
            const a = node('a', '', tr('Meanwhile, find a hospital near you →', 'في الأثناء، ابحث عن مشفى قريب منك ←'));
            a.href = 'hospitals.html';
            box.append(a);
        }
        if (filtered && !st.loading) {
            const b = node('button', '', tr('Clear filters', 'مسح التصفية'));
            b.type = 'button';
            b.onclick = () => {
                st.query = '';
                st.picks = {};
                st.limit = 12;
                $(kind + 'Search').value = '';
                renderDirectory(kind);
                $(kind + 'Search').focus();
            };
            box.append(b);
        }
    }

    // Once the booking platform is connected, the Doctors page invites patients to book online.
    function renderBookingBanner(platformUrl) {
        const banner = $('bookingBanner'), url = safeURL(platformUrl || '');
        if (!banner || !url) return;
        $('bookingLink').href = new URL('/doctors', url).href;
        banner.hidden = false;
    }

    const joinPaths = {doctors: '/staff#register', labs: '/staff#register-lab', hospitals: '/staff#register-hospital'};
    function renderJoinLink(kind, platformUrl) {
        const box = $(kind + 'Join'), url = safeURL(platformUrl || '');
        if (!box || !url) return;
        $(kind + 'JoinLink').href = new URL(joinPaths[kind], url).href;
        box.hidden = false;
    }

    function loadDirectory(kind) {
        json(`data/${kind}.json`).then(data => {
            if (!Array.isArray(data.items)) throw new Error('Invalid directory');
            directoryState[kind].items = data.items.filter(i => i && typeof i === 'object');
            if (kind === 'doctors') renderBookingBanner(data.platform_url);
            renderJoinLink(kind, data.platform_url);
        }).catch(() => {
            directoryState[kind].error = true;
        }).finally(() => {
            directoryState[kind].loading = false;
            preserveFocus(() => renderDirectory(kind));
        });
    }

    // Pregnancy planner: WHO's eight antenatal contacts, dated from the last menstrual period.
    const contactWeeks = [12, 20, 26, 30, 34, 36, 38, 40];

    function renderPlanner() {
        if (!$('lmpDate')) return;
        const out = $('plannerResult'), raw = $('lmpDate').value, lmp = timestamp(raw), day = 86400000;
        out.replaceChildren();
        $('lmpDate').max = new Date().toISOString().slice(0, 10);
        if (!raw) return;
        const days = Math.floor((Date.now() - lmp) / day);
        if (!Number.isFinite(lmp) || days < 0 || days > 44 * 7) {
            $('lmpDate').setAttribute('aria-invalid', 'true');
            out.append(node('p', 'planner-error', tr('Enter a date within the last 44 weeks.', 'أدخلي تاريخاً خلال آخر 44 أسبوعاً.')));
            return;
        }
        $('lmpDate').removeAttribute('aria-invalid');
        const fmt = t => new Date(t).toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', {day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'});
        const week = Math.floor(days / 7) + 1, trimester = week <= 12 ? 1 : week <= 27 ? 2 : 3;
        const summary = node('div', 'planner-summary');
        summary.append(node('p', '', tr('Estimated due date', 'موعد الولادة المتوقع')), node('strong', '', fmt(lmp + 280 * day)),
            node('p', '', tr(`Week ${week} · trimester ${trimester}`, `الأسبوع ${week} · الثلث ${trimester}`)));
        const list = node('ol', 'planner-visits');
        contactWeeks.forEach((w, i) => {
            const at = lmp + w * 7 * day, li = node('li', at < Date.now() ? 'past' : '');
            li.append(node('span', '', tr(`Visit ${i + 1} · week ${w}`, `الزيارة ${i + 1} · الأسبوع ${w}`)), node('time', '', (i === 0 ? tr('by ', 'قبل ') : tr('around ', 'نحو ')) + fmt(at)));
            list.append(li);
        });
        out.append(summary, node('p', 'planner-note', tr('Recommended checkups (WHO). Your health worker may suggest a different schedule.', 'الزيارات الموصى بها (منظمة الصحة العالمية). قد يقترح عليك العامل الصحي جدولاً مختلفاً.')), list,
            node('p', 'planner-note', tr('This is an estimate. Only an ultrasound or your health worker can confirm your due date.', 'هذا تقدير فقط. يؤكد التصوير بالأمواج فوق الصوتية أو العامل الصحي موعد الولادة.')));
    }

    function renderSources() {
        renderStats();
        if ($('sourceList')) renderSourceList();
        if ($('externalJobs')) renderExternalJobs();
    }

    function renderSourceList() {
        $('sourceList').replaceChildren();
        ['news', 'jobs'].forEach(kind => (sources[kind] || []).forEach(s => {
            if (!safeURL(s.website || s.url)) return;
            const li = node('li'),
                a = link(lang === 'ar' ? s.name_ar || s.name : s.name, s.website || s.url);
            a.append(node('small', '', kind === 'news' ? tr('NEWS ↗', 'أخبار ↖') : tr('JOBS ↗', 'وظائف ↖')));
            li.append(a);
            const status = sourceStatus[s.id];
            li.append(node('p', 'source-status', status ? (status.state === 'ok' ? (status.accepted ? tr('Available · ', 'متاح · ') + status.accepted + tr(' matching items', ' مواد مطابقة') : tr('Available · no recent matching items', 'متاح · لا توجد مواد حديثة مطابقة')) : tr('Temporarily unavailable', 'غير متاح مؤقتاً')) : tr('Status not yet available', 'الحالة غير متاحة بعد')));
            if (status && checkedTime(status.checked_at)) {
                const checked = node('p', 'source-status', tr('Checked: ', 'آخر فحص: ') + checkedTime(status.checked_at));
                if (Date.now() - timestamp(status.checked_at) > 48 * 3600000) checked.append(tr(' · Updates delayed', ' · التحديثات متأخرة'));
                li.append(checked);
            }
            $('sourceList').append(li);
        }));
    }

    function renderExternalJobs() {
        $('externalJobs').replaceChildren();
        (sources.directories || []).forEach(s => {
            if (!safeURL(s.url)) return;
            const li = node('li');
            li.append(link(lang === 'ar' ? s.name_ar || s.name : s.name, s.url));
            if (new URL(s.url).hostname === 'www.linkedin.com') li.append(node('p', 'source-status', tr('Opens LinkedIn jobs from the past week. LinkedIn may ask you to sign in; results can be empty.', 'يفتح وظائف لينكدإن من الأسبوع الماضي. قد يُطلب تسجيل الدخول وقد لا تظهر نتائج.')));
            $('externalJobs').append(li);
        });
    }

    function renderEditor() {
        if (!$('editorNote')) return;
        $('editorNote').hidden = !(editor.enabled === true && value(editor, 'title') && value(editor, 'body'));
        $('editorHeading').textContent = value(editor, 'title');
        $('editorBody').textContent = value(editor, 'body');
        $('editorLink').hidden = !safeURL(editor.url);
        $('editorLink').href = safeURL(editor.url);
        $('editorLink').textContent = value(editor, 'link');
    }

    // Home page: the three roles closing soonest and the three latest stories.
    function preview(id, items, fill, emptyText) {
        const list = $(id);
        if (!list) return;
        list.replaceChildren();
        list.setAttribute('aria-busy', String(feeds[id === 'homeJobs' ? 'jobs' : 'news'].loading));
        items.slice(0, 3).forEach(i => {
            const li = node('li');
            fill(li, i);
            list.append(li);
        });
        if (!items.length) list.append(node('li', 'preview-empty', emptyText));
    }

    function renderHomeJobs() {
        const loading = feeds.jobs.loading && !openJobs().length;
        preview('homeJobs', [...openJobs()].sort((a, b) => deadlineTime(a) - deadlineTime(b)), (li, j) => {
            const title = node('h3', 'preview-title');
            title.dir = 'auto';
            title.append(link(value(j, 'title'), j.url));
            const meta = node('p', 'preview-meta', (j.organisation || j.source) + ' · ' + j.location);
            const due = node('p', 'job-deadline' + (deadlineTime(j) - Date.now() <= 3 * 86400000 ? ' urgent' : ''), tr('Closes ', 'يغلق في ') + (j.deadline_at ? checkedTime(j.deadline_at) : date(j.deadline)));
            li.append(title, meta, due);
        }, loading ? tr('Loading roles…', 'جارٍ تحميل الوظائف…') : tr('No open roles right now — check back soon.', 'لا توجد وظائف متاحة حالياً — عد قريباً.'));
    }

    function renderHomeNews() {
        const loading = feeds.news.loading && !openNews().length;
        preview('homeNews', openNews(), (li, n) => {
            const title = node('h3', 'preview-title');
            title.dir = 'auto';
            title.append(link(value(n, 'title'), n.url));
            li.append(title, node('p', 'preview-meta', [n.source, date(n.published)].filter(Boolean).join(' · ')));
        }, loading ? tr('Loading stories…', 'جارٍ تحميل الأخبار…') : tr('More stories are on the way.', 'المزيد من الأخبار قريباً.'));
    }

    function renderAll() {
        staticText();
        filters();
        renderNews();
        renderJobs();
        renderSources();
        renderEditor();
        renderStats();
        renderChecklist();
        renderChecklist('pregnancyChecklist', 'shc-pregnancy-checklist', 'pregnancyProgress');
        Object.keys(directories).forEach(renderDirectory);
        renderPlanner();
    }
    async function json(path) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
        try {
            const r = await fetch(path, {cache: 'no-cache', signal: controller.signal});
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return await r.json();
        } finally {
            clearTimeout(timer);
        }
    }
    async function loadFeed(kind) {
        if (feeds[kind].requestPending) return;
        feeds[kind].requestPending = true;
        feeds[kind].loading = true;
        feeds[kind].error = false;
        preserveFocus(() => kind === 'news' ? renderNews() : renderJobs());
        try {
            const data = await json(`data/${kind}.json`);
            if (!Array.isArray(data.items)) throw new Error('Invalid feed');
            feeds[kind] = {
                items: data.items.filter(i => validRecord(i, kind)),
                updated: data.updated,
                status: data.status,
                loading: false
            };
        } catch (_) {
            feeds[kind].loading = false;
            feeds[kind].error = true;
        }
        feeds[kind].requestPending = false;
        preserveFocus(() => {
            filters();
            renderNews();
            renderJobs();
        });
    }
    async function loadStatus() {
        try {
            const data = await json('data/status.json');
            sourceStatus = Object.fromEntries((data.sources || []).map(s => [s.id, s]));
            preserveFocus(renderSources);
        } catch (_) {}
    }
    $('langToggle').onclick = () => {
        lang = lang === 'en' ? 'ar' : 'en';
        try {
            localStorage.setItem('shc-lang', lang);
        } catch (_) {}
        preserveFocus(renderAll);
    };
    $('search')?.addEventListener('input', e => {
        query = normalize(e.target.value.trim());
        newsLimit = 6;
        renderNews();
        renderJobs();
    });
    if ($('jobsList')) {
        $('location').onchange = e => {
            location = e.target.value;
            renderJobs();
        };
        $('organisation').onchange = e => {
            organisation = e.target.value;
            renderJobs();
        };
        $('jobSort').onchange = e => {
            sort = e.target.value;
            renderJobs();
        };
        $('sectorFilters').querySelectorAll('button').forEach(b => b.onclick = () => {
            sector = b.dataset.sector;
            $('sectorFilters').querySelectorAll('button').forEach(n => n.setAttribute('aria-pressed', String(n === b)));
            renderJobs();
        });
        $('clearFilters').onclick = clearFilters;
        // jobs.html#saved opens the saved-jobs view (linked from the home page).
        if (window.location.hash === '#saved') sector = 'saved';
        window.addEventListener('hashchange', () => {
            if (window.location.hash !== '#saved') return;
            sector = 'saved';
            filters();
            renderJobs();
        });
    }
    Object.keys(directories).filter(kind => $(kind + 'List')).forEach(kind => {
        $(kind + 'Search').addEventListener('input', e => {
            directoryState[kind].query = normalize(e.target.value.trim());
            directoryState[kind].limit = 12;
            renderDirectory(kind);
        });
        Object.keys(directories[kind].filters).forEach(name => $(kind + name).onchange = e => {
            directoryState[kind].picks[name] = e.target.value;
            directoryState[kind].limit = 12;
            renderDirectory(kind);
        });
        loadDirectory(kind);
    });
    if ($('lmpDate')) {
        $('lmpDate').addEventListener('change', renderPlanner);
        $('lmpDate').addEventListener('input', renderPlanner);
        $('planner').addEventListener('submit', e => e.preventDefault());
    }
    if ($('moreNews')) $('moreNews').onclick = () => {
        const next = newsLimit;
        newsLimit += 6;
        renderNews();
        $('newsList').children[next]?.querySelector('.card-title a')?.focus({preventScroll: true});
    };
    // Each page loads only the feeds it shows.
    const needs = {
        news: ['newsList', 'homeNews', 'statNews'].some($),
        jobs: ['jobsList', 'homeJobs', 'heroJobCount', 'statJobs'].some($),
        status: Boolean($('sourceList'))
    };
    const refresh = () => {
        if (needs.news) loadFeed('news');
        if (needs.jobs) loadFeed('jobs');
        if (needs.status) loadStatus();
    };
    renderAll();
    refresh();
    if (['sourceList', 'externalJobs', 'statSources'].some($)) json('sources.json').then(data => {
        sources = data;
        preserveFocus(renderSources);
    }).catch(() => {
        if ($('sourceError')) $('sourceError').hidden = false;
    });
    if ($('editorNote')) json('data/editor.json').then(data => {
        editor = data;
        renderEditor();
    }).catch(() => {});
    setInterval(refresh, 15 * 60 * 1000);
    // Expire loaded records even while the visitor leaves the tab open.
    setInterval(() => {
        const news = openNews(), jobs = openJobs();
        if (news.length === feeds.news.items.length && jobs.length === feeds.jobs.items.length) return;
        feeds.news.items = news;
        feeds.jobs.items = jobs;
        preserveFocus(() => {
            filters();
            renderNews();
            renderJobs();
        });
    }, 60000);
})();
