import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const files = ['index.html', 'sources.json', 'CNAME', 'assets', 'data'];

// Validate feed syntax before producing a deployable copy of the static site.
for (const file of ['sources.json', 'data/news.json', 'data/jobs.json', 'data/status.json', 'data/editor.json']) {
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
await writeFile(path.join(output, '.nojekyll'), '');
console.log('Built static website in dist/ (HTML, assets, feeds and custom domain).');
