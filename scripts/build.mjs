import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const site = 'https://syriahealthcare.com/';
const files = ['sources.json', 'CNAME', 'assets', 'data'];

// Every page shares pages/_layout.html; `nav` pages appear in the header menu, all pages in the footer.
const pages = [
  {name: 'index', nav: false, label: ['Home', 'الرئيسية'],
    title: ['Syria Healthcare — jobs, doctors, hospitals and health news', 'الرعاية الصحية في سوريا — وظائف وأطباء ومشافٍ وأخبار صحية'],
    description: ['Find healthcare and NGO jobs, doctors, labs and hospitals in Syria, plus healthcare news and pregnancy planning — in English and Arabic.', 'ابحث عن وظائف صحية وإنسانية وأطباء ومخابر ومشافٍ في سوريا، مع أخبار القطاع الصحي والتخطيط للحمل — بالعربية والإنجليزية.']},
  {name: 'jobs', nav: true, label: ['Jobs', 'الوظائف'],
    title: ['Healthcare and NGO jobs in Syria — Syria Healthcare', 'وظائف صحية وإنسانية في سوريا — الرعاية الصحية في سوريا'],
    description: ['Verified healthcare, humanitarian and NGO vacancies in Syria, directly from employers, with clear closing dates.', 'وظائف صحية وإنسانية وفي المنظمات داخل سوريا، موثقة ومباشرة من جهات التوظيف، مع مواعيد إغلاق واضحة.']},
  {name: 'doctors', nav: true, label: ['Doctors', 'الأطباء'],
    title: ['Find a doctor in Syria — Syria Healthcare', 'ابحث عن طبيب في سوريا — الرعاية الصحية في سوريا'],
    description: ['Search doctors in Syria by name, specialty and city.', 'ابحث عن الأطباء في سوريا حسب الاسم والاختصاص والمدينة.']},
  {name: 'hospitals', nav: true, label: ['Hospitals', 'المشافي'],
    title: ['Hospitals in Syria with directions — Syria Healthcare', 'المشافي في سوريا مع الاتجاهات — الرعاية الصحية في سوريا'],
    description: ['Hospitals in every Syrian governorate, in English and Arabic, with phone numbers where known and Google Maps directions.', 'مشافٍ في كل المحافظات السورية بالعربية والإنجليزية، مع أرقام الهاتف المتوفرة واتجاهات خرائط Google.']},
  {name: 'labs', nav: true, label: ['Labs', 'المخابر'],
    title: ['Medical labs in Syria — Syria Healthcare', 'المخابر الطبية في سوريا — الرعاية الصحية في سوريا'],
    description: ['Find medical laboratories in Syria and the tests they offer, with address and contact details.', 'ابحث عن المخابر الطبية في سوريا والتحاليل التي تقدمها، مع العنوان ووسائل التواصل.']},
  {name: 'pregnancy', nav: true, label: ['Pregnancy', 'الحمل'],
    title: ['Pregnancy planning: due date and checkups — Syria Healthcare', 'التخطيط للحمل: موعد الولادة والزيارات — الرعاية الصحية في سوريا'],
    description: ['A step-by-step pregnancy guide based on WHO recommendations, a due-date and checkup planner, warning signs and a birth checklist.', 'دليل للحمل خطوة بخطوة مبني على توصيات منظمة الصحة العالمية، ومخطط لموعد الولادة والزيارات، وعلامات الخطر وقائمة الاستعداد للولادة.']},
  {name: 'news', nav: true, label: ['News', 'الأخبار'],
    title: ['Syria healthcare news — Syria Healthcare', 'أخبار القطاع الصحي في سوريا — الرعاية الصحية في سوريا'],
    description: ['Original headlines from the Ministry of Health, WHO, the Red Crescent and NGOs about healthcare in Syria.', 'عناوين أصلية من وزارة الصحة ومنظمة الصحة العالمية والهلال الأحمر والمنظمات عن الرعاية الصحية في سوريا.']},
  {name: 'about', nav: true, label: ['About', 'من نحن'],
    title: ['About Syria Healthcare and our sources', 'عن الرعاية الصحية في سوريا ومصادرنا'],
    description: ['Who we are, how we select jobs and news, and the original sources we check twice daily.', 'من نحن، وكيف نختار الوظائف والأخبار، والمصادر الأصلية التي نفحصها مرتين يومياً.']},
  {name: '404', nav: false, footer: false, sitemap: false, label: ['Page not found', 'الصفحة غير موجودة'],
    title: ['Page not found — Syria Healthcare', 'الصفحة غير موجودة — الرعاية الصحية في سوريا'],
    description: ['This page could not be found.', 'تعذر العثور على هذه الصفحة.']}
];

const escape = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const href = page => page.name === 'index' ? './' : page.name + '.html';
const menu = (current, list) => list.map(p => `<a href="${href(p)}"${p === current ? ' aria-current="page"' : ''} data-en="${escape(p.label[0])}" data-ar="${escape(p.label[1])}">${escape(p.label[0])}</a>`).join('');

// Validate feed syntax before producing a deployable copy of the static site.
for (const file of ['sources.json', 'data/news.json', 'data/jobs.json', 'data/status.json', 'data/editor.json', 'data/doctors.json', 'data/labs.json', 'data/hospitals.json']) {
  JSON.parse(await readFile(path.join(root, file), 'utf8'));
}
if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== 'dist') {
  throw new Error('Build output must be the project dist directory.');
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) {
  await cp(path.join(root, file), path.join(output, file), { recursive: true });
}

// Cache-busting version from the shared CSS and JS, so browsers fetch them again after every change.
const hash = createHash('sha256');
for (const file of ['assets/app.js', 'assets/style.css']) hash.update(await readFile(path.join(root, file)));
const version = hash.digest('hex').slice(0, 10);
const layout = await readFile(path.join(root, 'pages', '_layout.html'), 'utf8');
for (const page of pages) {
  const body = await readFile(path.join(root, 'pages', page.name + '.html'), 'utf8');
  const fields = {
    title: escape(page.title[0]), title_ar: escape(page.title[1]),
    description: escape(page.description[0]), description_ar: escape(page.description[1]),
    url: site + (page.name === 'index' ? '' : page.name + '.html'), version,
    nav: menu(page, pages.filter(p => p.nav)), footer_nav: menu(page, pages.filter(p => p.footer !== false))
  };
  const html = layout.replace('{{content}}', () => body.trim()).replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in fields)) throw new Error(`Unknown placeholder ${match} in ${page.name}`);
    return fields[key];
  });
  await writeFile(path.join(output, page.name + '.html'), html);
}
const urls = pages.filter(p => p.sitemap !== false).map(p => `  <url><loc>${site}${p.name === 'index' ? '' : p.name + '.html'}</loc></url>`);
await writeFile(path.join(output, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
await writeFile(path.join(output, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${site}sitemap.xml\n`);
await writeFile(path.join(output, '.nojekyll'), '');
console.log(`Built ${pages.length} pages in dist/ (assets v${version}, feeds, sitemap and custom domain).`);
