// The app's pages, served from memory with versioned asset links (performance).
// At start-up every file in public/assets gets a short content hash, and every page's links to /assets/... get "?v=<hash>".
// Assets requested with ?v= can then be kept by browsers for a year (they change URL when they change), and pages are
// always fetched fresh (they are small) with an ETag, so a phone on a slow network revalidates one page, not every script.
import {createHash} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

const hash = data => createHash('sha256').update(data).digest('base64url').slice(0, 12);

async function filesIn(dir, prefix = '') {
    const out = [];
    for (const entry of await readdir(dir, {withFileTypes: true})) {
        const rel = prefix + entry.name;
        if (entry.isDirectory()) out.push(...await filesIn(path.join(dir, entry.name), rel + '/'));
        else out.push(rel);
    }
    return out;
}

// "/assets/app.css" -> version, for every file under public/assets.
export async function assetVersions(publicDir) {
    const versions = new Map();
    for (const rel of await filesIn(path.join(publicDir, 'assets'))) {
        versions.set('/assets/' + rel, hash(await readFile(path.join(publicDir, 'assets', rel))));
    }
    return versions;
}

// Adds ?v=<hash> to src="/assets/..." and href="/assets/..." (only for files that exist, and only once).
export function versionLinks(html, versions) {
    return html.replace(/\b(src|href)="(\/assets\/[^"?#]+)"/g, (whole, attr, url) => versions.has(url) ? `${attr}="${url}?v=${versions.get(url)}"` : whole);
}

// name ("index", "file", ...) -> {html, etag}, for every public/*.html.
export async function loadPages(publicDir, versions) {
    const pages = new Map();
    for (const name of (await readdir(publicDir)).filter(f => f.endsWith('.html'))) {
        const html = versionLinks(await readFile(path.join(publicDir, name), 'utf8'), versions);
        pages.set(name.slice(0, -5), {html, etag: `"${hash(html)}"`});
    }
    return pages;
}

export default async function pageRoutes(app, {publicDir}) {
    const versions = await assetVersions(publicDir);
    const pages = await loadPages(publicDir, versions);
    const send = (request, reply, page) => {
        reply.header('Cache-Control', 'no-cache').header('ETag', page.etag);
        if (request.headers['if-none-match'] === page.etag) return reply.code(304).send();
        return reply.type('text/html; charset=utf-8').send(page.html);
    };
    app.get('/', (request, reply) => send(request, reply, pages.get('index')));
    // "/file" and "/file.html" are pages; anything else at the top level (sw.js, manifest, icons) is a plain file.
    app.get('/:name', (request, reply) => {
        const name = request.params.name.replace(/\.html$/, '');
        const page = pages.get(name);
        return page ? send(request, reply, page) : reply.sendFile(request.params.name);
    });
}

// How long browsers may keep an asset: a year with ?v=<hash> (the URL changes with the file), else 5 minutes.
export const assetCacheControl = url => /[?&]v=/.test(url) ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
