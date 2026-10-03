(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let lang = 'en';
  try {
    lang = localStorage.getItem('shc-lang') === 'ar' ? 'ar' : 'en';
  } catch (_) {}
  let topic = 'all',
    location = '',
    query = '',
    sources = {},
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

  function node(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function safeURL(raw) {
    try {
      const u = new URL(raw);
      return ['https:', 'http:'].includes(u.protocol) ? u.href : '';
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
    return feeds.jobs.items.filter(j => /^\d{4}-\d{2}-\d{2}$/.test(j.deadline || '') && date(j.deadline) && j.deadline >= today && Date.now() - new Date(j.verified_at).getTime() <= 72 * 3600000);
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
      n = $(kind + 'Stamp');
    const checked = date(f.updated);
    const stale = checked && Date.now() - new Date(f.updated).getTime() > 48 * 3600000;
    n.textContent = checked ? tr('Last successful collection: ', 'آخر جمع ناجح: ') + checked + (stale ? tr(' · Updates delayed', ' · التحديثات متأخرة') : '') : '';
    n.classList.toggle('stale', Boolean(stale));
    if (f.status === 'partial' || f.status === 'error') {
      n.textContent += tr(' · Some sources are temporarily unavailable', ' · بعض المصادر غير متاحة مؤقتاً');
      n.classList.add('stale');
    }
  }

  function emptyState(kind, hasResults, filtered) {
    const box = $(kind + 'Empty'),
      f = feeds[kind];
    box.hidden = hasResults;
    box.replaceChildren();
    if (hasResults) return;
    let heading, body;
    if (f.loading) {
      heading = tr('Loading…', 'جارٍ التحميل…');
      body = tr('Fetching the latest available content.', 'جارٍ جلب أحدث المحتويات المتاحة.');
    } else if (f.error) {
      heading = tr('Unable to load this feed', 'تعذر تحميل هذه الخلاصة');
      body = tr('Please try again. You can also explore the original sources below.', 'يرجى المحاولة مجدداً. يمكنك أيضاً تصفح المصادر الأصلية أدناه.');
    } else if (filtered) {
      heading = tr('No matching results', 'لا توجد نتائج مطابقة');
      body = tr('Try a different search or clear your filters.', 'جرّب بحثاً آخر أو امسح عوامل التصفية.');
    } else {
      heading = kind === 'news' ? tr('The next stories belong here', 'الأخبار القادمة تجدها هنا') : tr('No current openings', 'لا توجد فرص حالية');
      body = tr('Explore the original sources while we collect more relevant updates.', 'تصفح المصادر الأصلية ريثما نجمع المزيد من التحديثات ذات الصلة.');
    }
    const symbol = node('span', 'empty-symbol', '✳');
    symbol.setAttribute('aria-hidden', 'true');
    box.append(symbol, node('h3', '', heading), node('p', '', body));
    if (f.error || filtered) {
      const b = node('button', '', f.error ? tr('Try again', 'حاول مجدداً') : tr('Clear filters', 'مسح التصفية'));
      b.type = 'button';
      b.onclick = () => {
        if (f.error) loadFeed(kind);
        else {
          query = '';
          topic = 'all';
          location = '';
          $('search').value = '';
          renderAll();
        }
      };
      box.append(b);
    } else if (!f.loading) {
      const a = node('a', '', tr('Explore our sources →', 'تصفح مصادرنا ←'));
      a.href = '#sources';
      box.append(a);
    }
  }

  function filters() {
    const present = ['all', ...new Set(feeds.news.items.map(n => n.topic || 'other'))];
    if (!present.includes(topic)) topic = 'all';
    $('newsFilters').replaceChildren();
    present.forEach(key => {
      const b = node('button', '', label(key));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(topic === key));
      b.onclick = () => {
        topic = key;
        $('newsFilters').querySelectorAll('button').forEach(n => n.setAttribute('aria-pressed', String(n === b)));
        renderNews();
      };
      $('newsFilters').append(b);
    });
    const select = $('location');
    select.replaceChildren();
    const all = node('option', '', tr('All locations', 'جميع المواقع'));
    all.value = '';
    select.append(all);
    [...new Set(openJobs().map(j => j.location).filter(Boolean))].sort().forEach(loc => {
      const o = node('option', '', loc);
      o.value = loc;
      select.append(o);
    });
    select.value = location;
    if (select.selectedIndex < 0) {
      location = '';
      select.value = '';
    }
  }

  function renderNews() {
    const items = feeds.news.items.filter(n => (topic === 'all' || (n.topic || 'other') === topic) && matches(n));
    $('newsList').replaceChildren();
    $('newsCount').textContent = items.length;
    items.forEach(n => {
      const li = node('li'),
        meta = node('div', 'card-meta');
      meta.append(node('span', 'topic', label(n.topic)));
      if (n.source) meta.append(node('span', '', n.source));
      if (date(n.published)) {
        const time = node('time', '', date(n.published));
        time.dateTime = n.published;
        meta.append(time);
      }
      const title = node('h3', 'card-title');
      title.dir = 'auto';
      title.append(link(value(n, 'title'), n.url));
      li.append(meta, title);
      li.append(node('p', 'card-summary', n.language === 'ar' ? tr('Original headline in Arabic', 'العنوان الأصلي بالعربية') : tr('Original headline in English', 'العنوان الأصلي بالإنجليزية')));
      li.append(link(tr('Read original story ↗', 'اقرأ الخبر الأصلي ↖'), n.url, 'read-link'));
      $('newsList').append(li);
    });
    emptyState('news', items.length > 0, Boolean(query || topic !== 'all'));
    stamp('news');
    $('newsResult').textContent = tr(`${items.length} stories shown`, `عدد الأخبار المعروضة: ${items.length}`);
  }

  function renderJobs() {
    const items = openJobs().filter(j => (!location || j.location === location) && matches(j));
    $('jobsList').replaceChildren();
    $('jobsCount').textContent = items.length;
    items.forEach(j => {
      const li = node('li'),
        title = node('h3', 'job-title');
      title.dir = 'auto';
      title.append(link(value(j, 'title'), j.url));
      li.append(title);
      li.append(node('p', 'job-meta', j.role_type === 'clinical' ? tr('Clinical / healthcare role', 'وظيفة طبية / صحية') : tr('Support role at a healthcare organization', 'وظيفة دعم في منظمة صحية')));
      li.append(node('p', 'job-meta', [j.organisation || j.source, j.location].filter(Boolean).join(' · ')));
      li.append(node('p', 'job-deadline', date(j.deadline) ? tr('Closes ', 'آخر موعد: ') + date(j.deadline) : tr('Closing date: check original listing', 'الموعد النهائي: راجع الإعلان الأصلي')));
      if (j.reference) li.append(node('p', 'job-meta', tr('Vacancy reference: ', 'رقم الوظيفة: ') + j.reference));
      li.append(link(j.reference ? tr('View employer listings ↗', 'عرض وظائف الجهة الموظفة ↖') : tr('View vacancy ↗', 'عرض الوظيفة ↖'), j.url, 'read-link'));
      $('jobsList').append(li);
    });
    emptyState('jobs', items.length > 0, Boolean(query || location));
    stamp('jobs');
    $('jobsResult').textContent = tr(`${items.length} opportunities shown`, `عدد الفرص المعروضة: ${items.length}`);
  }

  function renderSources() {
    $('sourceList').replaceChildren();
    ['news', 'jobs'].forEach(kind => (sources[kind] || []).forEach(s => {
      if (!safeURL(s.url)) return;
      const li = node('li'),
        a = link(s.name, s.website || s.url);
      a.append(node('small', '', kind === 'news' ? tr('News feed ↗', 'خلاصة أخبار ↖') : tr('Jobs feed ↗', 'خلاصة وظائف ↖')));
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
  $('langToggle').onclick = () => {
    lang = lang === 'en' ? 'ar' : 'en';
    try {
      localStorage.setItem('shc-lang', lang);
    } catch (_) {}
    renderAll();
  };
  $('search').addEventListener('input', e => {
    query = normalize(e.target.value.trim());
    renderNews();
    renderJobs();
  });
  $('location').onchange = e => {
    location = e.target.value;
    renderJobs();
  };
  renderAll();
  loadFeed('news');
  loadFeed('jobs');
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
  json('data/status.json').then(data => {
    sourceStatus = Object.fromEntries((data.sources || []).map(s => [s.id, s]));
    renderSources();
  }).catch(() => {});
  setInterval(() => { loadFeed('news'); loadFeed('jobs'); }, 15 * 60 * 1000);
})();
