(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    let lang = 'en',
        saved = new Set();
    try {
        lang = localStorage.getItem('shc-lang') === 'ar' ? 'ar' : 'en';
        const stored = JSON.parse(localStorage.getItem('shc-saved') || '[]');
        if (Array.isArray(stored)) saved = new Set(stored.filter(x => typeof x === 'string'));
    } catch (_) {}
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
    const value = (item, key) => item[key + '_' + lang] || item[key + '_en'] || item[key] || '';
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

    function date(raw) {
        const d = new Date(raw);
        return raw && !isNaN(d) ? d.toLocaleDateString(lang === 'ar' ? 'ar' : 'en-GB', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC'
        }) : '';
    }

    function normalize(text) {
        return String(text).normalize('NFKD').replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, '').toLocaleLowerCase();
    }

    function matches(item) {
        return !query || normalize(['title', 'title_en', 'title_ar', 'source', 'organisation', 'location'].map(k => item[k] || '').join(' ')).includes(query);
    }

    function openJobs() {
        const today = new Date().toISOString().slice(0, 10);
        return feeds.jobs.items.filter(j => /^\d{4}-\d{2}-\d{2}$/.test(j.deadline || '') && date(j.deadline) && j.deadline >= today && (!j.deadline_at || new Date(j.deadline_at).getTime() >= Date.now()) && Date.now() - new Date(j.verified_at).getTime() <= 72 * 3600000);
    }

    function staticText() {
        document.documentElement.lang = lang;
        document.documentElement.dir = document.body.dir = lang === 'ar' ? 'rtl' : 'ltr';
        document.querySelectorAll('[data-en]').forEach(n => {
            n.textContent = n.dataset[lang] || n.dataset.en;
        });
        document.querySelectorAll('[data-label-en]').forEach(n => n.setAttribute('aria-label', n.getAttribute('data-label-' + lang)));
        document.querySelectorAll('[data-placeholder-en]').forEach(n => n.placeholder = n.getAttribute('data-placeholder-' + lang));
        $('langToggle').textContent = tr('العربية', 'English');
        $('langToggle').lang = tr('ar', 'en');
        $('langToggle').setAttribute('aria-label', tr('Switch to Arabic', 'التبديل إلى الإنجليزية'));
    }

    function stamp(kind) {
        const f = feeds[kind],
            n = $(kind + 'Stamp'),
            checked = date(f.updated);
        const stale = checked && Date.now() - new Date(f.updated).getTime() > 48 * 3600000;
        n.textContent = checked ? tr('Last checked: ', 'آخر فحص: ') + checked + (stale ? tr(' · Updates delayed', ' · التحديثات متأخرة') : '') : '';
        if (f.status === 'partial' || f.status === 'error') n.textContent += tr(' · Some sources unavailable', ' · بعض المصادر غير متاحة');
        n.classList.toggle('stale', Boolean(stale || f.status === 'partial' || f.status === 'error'));
    }

    function clearFilters() {
        query = '';
        topic = 'all';
        location = '';
        organisation = '';
        sector = 'all';
        newsLimit = 6;
        $('search').value = '';
        renderAll();
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
            a.href = '#sources';
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
        const present = ['all', ...new Set(feeds.news.items.map(n => n.topic || 'other'))];
        if (!present.includes(topic)) topic = 'all';
        $('newsFilters').replaceChildren();
        present.forEach(t => {
            const b = node('button', '', label(t));
            b.type = 'button';
            b.setAttribute('aria-pressed', String(topic === t));
            b.onclick = () => {
                topic = t;
                newsLimit = 6;
                $('newsFilters').querySelectorAll('button').forEach(n => n.setAttribute('aria-pressed', String(n === b)));
                renderNews();
            };
            $('newsFilters').append(b);
        });
        location = selectOptions('location', tr('All locations', 'جميع المواقع'), [...new Set(openJobs().map(j => j.location).filter(Boolean))].sort(), location);
        organisation = selectOptions('organisation', tr('All organizations', 'جميع المنظمات'), [...new Set(openJobs().map(j => j.organisation).filter(Boolean))].sort(), organisation);
        $('sectorFilters').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sector === sector)));
        $('jobSort').value = sort;
    }

    function renderNews() {
        const items = feeds.news.items.filter(n => (topic === 'all' || (n.topic || 'other') === topic) && matches(n));
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
            } catch (_) {}
            renderJobs();
            const again = Array.from(document.querySelectorAll('.save-job')).find(n => n.dataset.key === id);
            (again || document.querySelector('[data-sector="saved"]')).focus();
        };
        return b;
    }

    function renderFeatured() {
        const all = openJobs(),
            first = [...all].sort((a, b) => a.deadline.localeCompare(b.deadline))[0];
        $('heroJobCount').textContent = all.length;
        $('heroOrgCount').textContent = new Set(all.map(j => j.organisation)).size;
        document.querySelector('.spotlight-top .pill').hidden = !first;
        if (!first) {
            $('featuredOrg').textContent = tr('From original employers', 'من الجهات الموظفة الأصلية');
            $('featuredTitle').textContent = tr('Find work that matters.', 'ابحث عن عمل يصنع فرقاً.');
            $('featuredMeta').textContent = '';
            $('featuredLink').href = '#jobs';
            return;
        }
        $('featuredOrg').textContent = first.organisation;
        $('featuredTitle').textContent = value(first, 'title');
        $('featuredTitle').dir = 'auto';
        $('featuredMeta').textContent = first.location + ' · ' + tr('Closes ', 'يغلق في ') + date(first.deadline);
        $('featuredLink').href = safeURL(first.url);
    }

    function renderJobs() {
        let items = openJobs().filter(j => (!location || j.location === location) && (!organisation || j.organisation === organisation) && (sector === 'all' || (sector === 'saved' ? saved.has(key(j)) : (j.sector || 'healthcare') === sector)) && matches(j));
        items.sort((a, b) => sort === 'deadline' ? a.deadline.localeCompare(b.deadline) : (b.published || '').localeCompare(a.published || ''));
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
            if (j.reference && j.listing_page) li.append(node('p', 'job-reference', tr('Vacancy reference: ', 'رقم الوظيفة: ') + j.reference));
            const bottom = node('div', 'job-card-bottom'),
                deadline = node('p', 'job-deadline', tr('Closes ', 'يغلق في ') + date(j.deadline));
            if (new Date(j.deadline).getTime() - Date.now() < 3 * 86400000) deadline.classList.add('urgent');
            bottom.append(deadline, link(j.listing_page ? tr('View openings ↗', 'عرض الوظائف ↖') : tr('View role ↗', 'عرض الوظيفة ↖'), j.url, 'apply-link'));
            li.append(bottom);
            $('jobsList').append(li);
        });
        emptyState('jobs', items.length > 0, filtered);
        stamp('jobs');
        renderFeatured();
        $('jobsResult').textContent = tr(`${items.length} opportunities shown`, `${items.length} فرص معروضة`);
    }

    function renderSources() {
        $('sourceList').replaceChildren();
        ['news', 'jobs'].forEach(kind => (sources[kind] || []).forEach(s => {
            if (!safeURL(s.website || s.url)) return;
            const li = node('li'),
                a = link(s.name, s.website || s.url);
            a.append(node('small', '', kind === 'news' ? tr('NEWS ↗', 'أخبار ↖') : tr('JOBS ↗', 'وظائف ↖')));
            li.append(a);
            const status = sourceStatus[s.id];
            li.append(node('p', 'source-status', status ? (status.state === 'ok' ? (status.accepted ? tr('Available · ', 'متاح · ') + status.accepted + tr(' matching items', ' مواد مطابقة') : tr('Available · no recent matching items', 'متاح · لا توجد مواد حديثة مطابقة')) : tr('Temporarily unavailable', 'غير متاح مؤقتاً')) : tr('Status not yet available', 'الحالة غير متاحة بعد')));
            $('sourceList').append(li);
        }));
        $('externalJobs').replaceChildren();
        (sources.directories || []).forEach(s => {
            if (!safeURL(s.url)) return;
            const li = node('li');
            li.append(link(lang === 'ar' ? s.name_ar || s.name : s.name, s.url));
            $('externalJobs').append(li);
        });
    }

    function renderEditor() {
        $('editorNote').hidden = !(editor.enabled === true && value(editor, 'title') && value(editor, 'body'));
        $('editorHeading').textContent = value(editor, 'title');
        $('editorBody').textContent = value(editor, 'body');
        $('editorLink').hidden = !safeURL(editor.url);
        $('editorLink').href = safeURL(editor.url);
        $('editorLink').textContent = value(editor, 'link');
    }

    function renderAll() {
        staticText();
        filters();
        renderNews();
        renderJobs();
        renderSources();
        renderEditor();
    }
    async function json(path) {
        const r = await fetch(path, {
            cache: 'no-cache'
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    }
    async function loadFeed(kind) {
        feeds[kind].loading = true;
        feeds[kind].error = false;
        kind === 'news' ? renderNews() : renderJobs();
        try {
            const data = await json(`data/${kind}.json`);
            if (!Array.isArray(data.items)) throw new Error('Invalid feed');
            feeds[kind] = {
                items: data.items.filter(i => i && typeof i === 'object' && i.verification_version === 2 && safeURL(i.url) && value(i, 'title') && date(i.published) && new Date(i.published).getTime() <= Date.now() + 3600000 && (kind !== 'news' || Date.now() - new Date(i.published).getTime() <= 45 * 86400000)),
                updated: data.updated,
                status: data.status,
                loading: false
            };
        } catch (_) {
            feeds[kind].loading = false;
            feeds[kind].error = true;
        }
        filters();
        renderNews();
        renderJobs();
    }
    async function loadStatus() {
        try {
            const data = await json('data/status.json');
            sourceStatus = Object.fromEntries((data.sources || []).map(s => [s.id, s]));
            renderSources();
        } catch (_) {}
    }
    $('langToggle').onclick = () => {
        lang = lang === 'en' ? 'ar' : 'en';
        try {
            localStorage.setItem('shc-lang', lang);
        } catch (_) {}
        renderAll();
    };
    $('search').addEventListener('input', e => {
        query = normalize(e.target.value.trim());
        newsLimit = 6;
        renderNews();
        renderJobs();
    });
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
    $('moreNews').onclick = () => {
        newsLimit += 6;
        renderNews();
    };
    renderAll();
    loadFeed('news');
    loadFeed('jobs');
    loadStatus();
    json('sources.json').then(data => {
        sources = data;
        renderSources();
    }).catch(() => {
        $('sourceError').hidden = false;
    });
    json('data/editor.json').then(data => {
        editor = data;
        renderEditor();
    }).catch(() => {});
    setInterval(() => {
        loadFeed('news');
        loadFeed('jobs');
        loadStatus();
    }, 15 * 60 * 1000);
})();
