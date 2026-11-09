import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

// Two websites are built from this repository and link to each other:
// - syriahc.com, SyriaHC (صحة تك): health services. Doctors, dentists, hospitals, pharmacies, labs, blood banks,
//   emergency numbers, pregnancy planning and online booking.
// - syriahealthcare.com, Syria Healthcare: healthcare and NGO jobs and healthcare news, in its original green look.
// Both use pages/_layout.html, assets/style.css and assets/app.js.
const HC = 'https://syriahc.com/', NEWS = 'https://syriahealthcare.com/', PLATFORM = 'https://app.syriahc.com/';
// SyriaHC's directories. The installed app saves them all for use without internet.
const DIRECTORIES = ['doctors.json', 'dentists.json', 'labs.json', 'hospitals.json', 'pharmacies.json', 'blood-banks.json'];

// The stylesheet is written in SyriaHC colours; the Syria Healthcare copy swaps each for its original colour.
const SYRIA_HEALTHCARE_COLOURS = {
  '#1a3a5c': '#173e36', '#556578': '#53665c', '#fbfaf7': '#fafbf8', '#1d7470': '#21624d', '#f1dfb4': '#d7ed9f',
  '#e7f1f0': '#eaf1e8', '#dde3ea': '#dfe6dd', '#d3dde8': '#d2dfd8', '#238a85': '#7d9d63', '#e8eef3': '#e9eee2',
  '#c5d3df': '#c6d5b8', '#7fb3ae': '#8caa75', '#b9cfdb': '#b8cda3', '#1a3a5c12': '#173e3612', '#1a3a5c15': '#173e3615',
  '#c4d4e0': '#c4d7cb', '#1a3a5c04': '#173e3604', '#637489': '#6e8075', '#a7b6c6': '#a9bca8', '#1a3a5c08': '#173e3608',
  '#bcc8d4': '#becbb8', '#7fa8b0': '#88a179', '#d6dfe8': '#d8e1d3', '#d2dde8': '#d2e0d8', '#aab9c8': '#abbeb1',
  'rgba(26,58,92,.12)': 'rgba(23,62,54,.12)', '#9fb0c2': '#9fb2a4'
};

const page = (name, label, title, description, options = {}) => ({name, nav: true, label, title, description, ...options});
const notFound = brand => page('404', ['Page not found', 'الصفحة غير موجودة'], [`Page not found — ${brand[0]}`, `الصفحة غير موجودة — ${brand[1]}`],
  ['This page could not be found.', 'تعذر العثور على هذه الصفحة.'], {nav: false, footer: false, sitemap: false});
// Shown by the installed app (sw.js) when a page was never opened before and there is no connection.
const offline = brand => page('offline', ['Offline', 'دون اتصال'], [`You are offline — ${brand[0]}`, `أنت غير متصل — ${brand[1]}`],
  ['This page needs an internet connection.', 'تحتاج هذه الصفحة إلى اتصال بالإنترنت.'], {nav: false, footer: false, sitemap: false});
const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const menuLink = (href, label) => `<a href="${href}" data-en="${escape(label[0])}" data-ar="${escape(label[1])}">${escape(label[0])}</a>`;

const sites = [{
  out: 'dist', url: HC, key: 'syriahc', brand: ['SyriaHC', 'صحة تك'], themeColor: '#1a3a5c', faviconVersion: 3,
  wordmark: '<span class="wordmark-en">SyriaHC</span><span class="wordmark-ar" lang="ar">صحة تك</span>',
  footerWordmark: 'SyriaHC',
  ogAlt: 'SyriaHC · صحة تك: doctors, labs and hospitals in Syria, with the square Kufic صحة تك logo in a gold ring.',
  utility: `<span data-en="An independent guide to healthcare in Syria" data-ar="دليل مستقل للرعاية الصحية في سوريا">An independent guide to healthcare in Syria</span><a href="${PLATFORM}"><span class="dot"></span><span data-en="Book a doctor online" data-ar="احجز موعداً مع طبيب">Book a doctor online</span></a>`,
  // The other website, at the end of the menus.
  elsewhere: menuLink(NEWS, ['Jobs & news ↗', 'الوظائف والأخبار ↖']),
  feeds: '',
  offlineNote: ['This page has not been saved on your phone yet. Emergency numbers, hospitals, pharmacies, labs and doctors, and every page you opened before, still work without internet:',
    'لم تُحفظ هذه الصفحة على هاتفك بعد. أرقام الطوارئ والمشافي والصيدليات والمخابر والأطباء وكل صفحة فتحتها سابقاً تعمل دون إنترنت:'],
  files: ['manifest.webmanifest', 'assets'],
  data: DIRECTORIES,
  pages: [
    page('index', ['Home', 'الرئيسية'], ['SyriaHC — doctors, labs and hospitals in Syria', 'صحة تك — أطباء ومخابر ومشافٍ في سوريا'],
      ['Find doctors, dentists, pharmacies, labs and hospitals in Syria, the emergency numbers, online booking with verified doctors and pregnancy planning — in English and Arabic.',
        'ابحث عن أطباء وأطباء أسنان وصيدليات ومخابر ومشافٍ في سوريا، وأرقام الطوارئ، واحجز موعداً عبر الإنترنت مع أطباء موثقين، وخطط لحملك — بالعربية والإنجليزية.'], {nav: false}),
    page('doctors', ['Doctors', 'الأطباء'], ['Find a doctor in Syria — SyriaHC', 'ابحث عن طبيب في سوريا — صحة تك'],
      ['Search doctors in Syria by name, specialty and city.', 'ابحث عن الأطباء في سوريا حسب الاسم والاختصاص والمدينة.']),
    // Dentists and blood banks are in the footer, on the home page and linked from related pages, so the menu stays short on phones.
    page('dentists', ['Dentists', 'أطباء الأسنان'], ['Find a dentist in Syria — SyriaHC', 'ابحث عن طبيب أسنان في سوريا — صحة تك'],
      ['Dentists and dental clinics in Syria with their location in Google Maps, and verified dentists you can book online.',
        'أطباء وعيادات أسنان في سوريا مع مواقعهم على خرائط Google، وأطباء أسنان موثَّقون يمكنك الحجز لديهم عبر الإنترنت.'], {nav: false}),
    page('hospitals', ['Hospitals', 'المشافي'], ['Hospitals in Syria with directions — SyriaHC', 'المشافي في سوريا مع الاتجاهات — صحة تك'],
      ['Hospitals in every Syrian governorate, in English and Arabic, with phone numbers where known and Google Maps directions.', 'مشافٍ في كل المحافظات السورية بالعربية والإنجليزية، مع أرقام الهاتف المتوفرة واتجاهات خرائط Google.']),
    page('pharmacies', ['Pharmacies', 'الصيدليات'], ['Pharmacies in Syria with directions — SyriaHC', 'الصيدليات في سوريا مع الاتجاهات — صحة تك'],
      ['Pharmacies in Syria by governorate, in English and Arabic, with phone numbers where known and Google Maps directions.',
        'صيدليات في سوريا حسب المحافظة بالعربية والإنجليزية، مع أرقام الهاتف المتوفرة واتجاهات خرائط Google.']),
    page('labs', ['Labs', 'المخابر'], ['Medical labs in Syria — SyriaHC', 'المخابر الطبية في سوريا — صحة تك'],
      ['Find medical laboratories in Syria and the tests they offer, with address and contact details.', 'ابحث عن المخابر الطبية في سوريا والتحاليل التي تقدمها، مع العنوان ووسائل التواصل.']),
    page('blood-banks', ['Blood banks', 'بنوك الدم'], ['Blood banks and blood donation in Syria — SyriaHC', 'بنوك الدم والتبرع بالدم في سوريا — صحة تك'],
      ['Where to give blood or ask for blood in Syria: blood banks and donation centres with directions.',
        'أين تتبرع بالدم أو تطلبه في سوريا: بنوك الدم ومراكز التبرع مع الاتجاهات.'], {nav: false}),
    page('emergency', ['Emergency numbers', 'أرقام الطوارئ'], ['Emergency numbers in Syria: ambulance, police, fire — SyriaHC', 'أرقام الطوارئ في سوريا: الإسعاف والشرطة والإطفاء — صحة تك'],
      ['Ambulance 110, police 112 and fire 113 in Syria, with tap-to-call links and the sources we checked.',
        'الإسعاف 110 والشرطة 112 والإطفاء 113 في سوريا، مع إمكانية الاتصال بلمسة والمصادر التي تحققنا منها.']),
    page('pregnancy', ['Pregnancy', 'الحمل'], ['Pregnancy planning: due date and checkups — SyriaHC', 'التخطيط للحمل: موعد الولادة والزيارات — صحة تك'],
      ['A step-by-step pregnancy guide based on WHO recommendations, a due-date and checkup planner, warning signs and a birth checklist.', 'دليل للحمل خطوة بخطوة مبني على توصيات منظمة الصحة العالمية، ومخطط لموعد الولادة والزيارات، وعلامات الخطر وقائمة الاستعداد للولادة.']),
    notFound(['SyriaHC', 'صحة تك']), offline(['SyriaHC', 'صحة تك'])
  ]
}, {
  out: 'dist-news', url: NEWS, key: 'syriahealthcare', brand: ['Syria Healthcare', 'الرعاية الصحية في سوريا'], themeColor: '#173e36', faviconVersion: 2,
  wordmark: '<span class="wordmark-en">Syria Healthcare<span>.</span></span><span class="wordmark-ar" lang="ar">الرعاية الصحية في سوريا</span>',
  footerWordmark: 'Syria Healthcare<span>.</span>',
  ogAlt: 'Syria Healthcare: healthcare and humanitarian opportunities in Syria, with a jasmine and courtyard arch logo.',
  utility: '<span data-en="An independent window into Syria’s health &amp; humanitarian sector" data-ar="نافذة مستقلة على القطاع الصحي والإنساني في سوريا">An independent window into Syria’s health &amp; humanitarian sector</span><a href="about.html#sources"><span class="dot"></span><span data-en="Checked twice daily" data-ar="تُفحص المصادر مرتين يومياً">Checked twice daily</span></a>',
  elsewhere: menuLink(HC, ['Doctors & hospitals ↗', 'الأطباء والمشافي ↖']),
  feeds: `<link rel="alternate" type="application/rss+xml" title="Syria Healthcare news" href="${NEWS}data/news.xml">
  <link rel="alternate" type="application/rss+xml" title="Syria Healthcare jobs" href="${NEWS}data/jobs.xml">`,
  offlineNote: ['This page has not been saved on your phone yet. Every page you opened before still works without internet:',
    'لم تُحفظ هذه الصفحة على هاتفك بعد. كل صفحة فتحتها سابقاً تعمل دون إنترنت:'],
  // Logo, icons, sharing image and app manifest of Syria Healthcare replace SyriaHC's.
  brandFiles: 'brands/syriahealthcare',
  colours: SYRIA_HEALTHCARE_COLOURS,
  files: ['sources.json', 'assets'],
  data: ['news.json', 'jobs.json', 'news.xml', 'jobs.xml', 'status.json', 'editor.json'],
  pages: [
    page('index', ['Home', 'الرئيسية'], ['Syria Healthcare — healthcare and NGO jobs and health news', 'الرعاية الصحية في سوريا — وظائف صحية وإنسانية وأخبار صحية'],
      ['Find healthcare and NGO jobs in Syria and follow healthcare news from original sources — in English and Arabic.', 'ابحث عن وظائف صحية وإنسانية في سوريا وتابع أخبار القطاع الصحي من مصادرها الأصلية — بالعربية والإنجليزية.'],
      {nav: false, source: 'home-news'}),
    page('jobs', ['Jobs', 'الوظائف'], ['Healthcare and NGO jobs in Syria — Syria Healthcare', 'وظائف صحية وإنسانية في سوريا — الرعاية الصحية في سوريا'],
      ['Verified healthcare, humanitarian and NGO vacancies in Syria, directly from employers, with clear closing dates.', 'وظائف صحية وإنسانية وفي المنظمات داخل سوريا، موثقة ومباشرة من جهات التوظيف، مع مواعيد إغلاق واضحة.']),
    page('news', ['News', 'الأخبار'], ['Syria healthcare news — Syria Healthcare', 'أخبار القطاع الصحي في سوريا — الرعاية الصحية في سوريا'],
      ['Original headlines from the Ministry of Health, WHO, the Red Crescent and NGOs about healthcare in Syria.', 'عناوين أصلية من وزارة الصحة ومنظمة الصحة العالمية والهلال الأحمر والمنظمات عن الرعاية الصحية في سوريا.']),
    page('about', ['About', 'من نحن'], ['About Syria Healthcare and our sources', 'عن الرعاية الصحية في سوريا ومصادرنا'],
      ['Who we are, how we select jobs and news, and the original sources we check twice daily.', 'من نحن، وكيف نختار الوظائف والأخبار، والمصادر الأصلية التي نفحصها مرتين يومياً.']),
    notFound(['Syria Healthcare', 'الرعاية الصحية في سوريا']), offline(['Syria Healthcare', 'الرعاية الصحية في سوريا'])
  ]
}];

const href = page => page.name === 'index' ? './' : page.name + '.html';
const menu = (current, list) => list.map(p => `<a href="${href(p)}"${p === current ? ' aria-current="page"' : ''} data-en="${escape(p.label[0])}" data-ar="${escape(p.label[1])}">${escape(p.label[0])}</a>`).join('');
const recolour = (css, colours) => css.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi, colour => colours[colour.toLowerCase()] || colour);

// Validate feed syntax before producing a deployable copy of the static sites.
for (const file of ['sources.json', 'data/news.json', 'data/jobs.json', 'data/status.json', 'data/editor.json', ...DIRECTORIES.map(file => 'data/' + file)]) {
  JSON.parse(await readFile(path.join(root, file), 'utf8'));
}
const layout = await readFile(path.join(root, 'pages', '_layout.html'), 'utf8');
const worker = await readFile(path.join(root, 'scripts', 'sw.js'), 'utf8');

for (const site of sites) {
  const output = path.join(root, site.out);
  if (path.dirname(output) !== path.resolve(root) || !/^dist(-news)?$/.test(site.out)) throw new Error('Build output must be dist or dist-news in the project.');
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'data'), { recursive: true });
  for (const file of site.files) {
    await cp(path.join(root, file), path.join(output, file), { recursive: true, filter: source => !source.endsWith('syriahc-logo.png') });
  }
  for (const file of site.data) await cp(path.join(root, 'data', file), path.join(output, 'data', file));
  if (site.brandFiles) {
    for (const file of ['logo.svg', 'favicon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'social-card.png']) {
      await cp(path.join(root, site.brandFiles, file), path.join(output, 'assets', file));
    }
    await cp(path.join(root, site.brandFiles, 'manifest.webmanifest'), path.join(output, 'manifest.webmanifest'));
  }
  let css = await readFile(path.join(root, 'assets', 'style.css'), 'utf8');
  if (site.colours) {
    css = recolour(css, site.colours);
    await writeFile(path.join(output, 'assets', 'style.css'), css);
  }

  // Cache-busting version from this site's CSS and the shared JS, so browsers fetch them again after every change.
  const version = createHash('sha256').update(await readFile(path.join(root, 'assets', 'app.js'))).update(css).digest('hex').slice(0, 10);
  const shellHash = createHash('sha256');
  for (const page of site.pages) {
    const body = await readFile(path.join(root, 'pages', (page.source || page.name) + '.html'), 'utf8');
    const fields = {
      title: escape(page.title[0]), title_ar: escape(page.title[1]),
      description: escape(page.description[0]), description_ar: escape(page.description[1]),
      url: site.url + (page.name === 'index' ? '' : page.name + '.html'), site_url: site.url, version,
      site: site.key, brand: escape(site.brand[0]), theme_color: site.themeColor, favicon_version: String(site.faviconVersion),
      og_alt: escape(site.ogAlt), feeds: site.feeds, wordmark: site.wordmark, footer_wordmark: site.footerWordmark, utility: site.utility,
      offline_note: escape(site.offlineNote[0]), offline_note_ar: escape(site.offlineNote[1]),
      nav: menu(page, site.pages.filter(p => p.nav)) + site.elsewhere,
      footer_nav: menu(page, site.pages.filter(p => p.footer !== false)) + site.elsewhere
    };
    const html = layout.replace('{{content}}', () => body.trim()).replace(/\{\{(\w+)\}\}/g, (match, key) => {
      if (!(key in fields)) throw new Error(`Unknown placeholder ${match} in ${page.name}`);
      return fields[key];
    });
    await writeFile(path.join(output, page.name + '.html'), html);
    shellHash.update(html);
  }
  // The installed app saves every page, the style and script, and (on SyriaHC) the directories for offline use.
  // Its version follows every page and asset, so phones pick up each release.
  const shell = [...site.pages.filter(p => p.name !== '404').map(href),
    `assets/style.css?v=${version}`, `assets/app.js?v=${version}`, 'assets/logo.svg', `assets/favicon.svg?v=${site.faviconVersion}`, 'assets/icon-192.png',
    'manifest.webmanifest', ...site.data.filter(file => DIRECTORIES.includes(file)).map(file => 'data/' + file)];
  shellHash.update(version + worker + await readFile(path.join(output, 'manifest.webmanifest'), 'utf8'));
  await writeFile(path.join(output, 'sw.js'), `const VERSION = '${shellHash.digest('hex').slice(0, 10)}', SHELL = ${JSON.stringify(shell)};
${worker}`);
  const urls = site.pages.filter(p => p.sitemap !== false).map(p => `  <url><loc>${site.url}${p.name === 'index' ? '' : p.name + '.html'}</loc></url>`);
  await writeFile(path.join(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  await writeFile(path.join(output, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site.url}sitemap.xml\n`);
  console.log(`Built ${site.url} with ${site.pages.length} pages in ${site.out}/ (assets v${version}, sitemap, app manifest and service worker).`);
}
