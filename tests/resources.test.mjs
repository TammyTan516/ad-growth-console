// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {fixture, ok, error, MATERIAL, LANDING} from './phase34-fixture.mjs';
import {parseAudienceCSV} from '../server/resources.mjs';
import {parseSitemap, publicAddress, httpsURL, chooseSitemapChildren} from '../server/resources-network.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=', 'base64');
const uploadMaterial = {name: 'Synthetic one pixel image', source: 'upload', sourceUrl: '', mediaType: 'image', notes: 'Generated integration fixture', adCode: ''};
const flattenFiles = async directory => (await Promise.all((await readdir(directory, {withFileTypes: true})).map(async file => file.isDirectory() ? flattenFiles(join(directory, file.name)) : join(directory, file.name)))).flat();

test('media upload is private, versioned, signature-checked and available to signed-in team members', {timeout: 90000}, async t => {
  const f = await fixture(t), actor = f.admin;
  error(await f.request('/api/resources'), 401);
  const created = ok(await f.request('/api/materials', {method: 'POST', actor, body: uploadMaterial}), 201).item;
  assert.equal(created.ready, false);
  const wrongBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  error(await f.request(`/api/materials/${created.id}/file?expectedRevision=${created.revision}`, {method: 'PUT', actor, rawBody: wrongBytes, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': 'malicious.png'}}), [400, 415], 'extension must not bypass content validation');
  const uploaded = ok(await f.request(`/api/materials/${created.id}/file?expectedRevision=${created.revision}`, {method: 'PUT', actor, rawBody: PNG, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': 'pixel.png'}})).item;
  assert.equal(uploaded.revision, created.revision + 1);
  assert.equal(uploaded.ready, true);
  assert.equal(uploaded.file.name, 'pixel.png');
  assert.equal(uploaded.file.size, PNG.length);
  assert.equal(uploaded.file.mime, 'image/png');
  assert.equal(uploaded.file.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.ok(!JSON.stringify(uploaded).includes(f.directory), 'response must never reveal an absolute server path');
  const download = `/api/materials/${created.id}/file?revision=${uploaded.revision}`;
  error(await f.request(download), 401, 'no public material URL');
  const viewer = await f.invitedMember(actor, 'viewer@example.com', 'viewer');
  const read = await f.request(download, {actor: viewer});
  ok(read);
  assert.deepEqual(read.bytes, PNG);
  assert.match(read.headers.get('content-type'), /^image\/png/);
  assert.equal(read.headers.get('cache-control'), 'no-store');
  const range = await f.request(download, {actor: viewer, headers: {Range: 'bytes=0-7'}});
  ok(range, 206);
  assert.deepEqual(range.bytes, PNG.subarray(0, 8));
  assert.equal(range.headers.get('content-range'), `bytes 0-7/${PNG.length}`);
  const suffix = await f.request(download, {actor: viewer, headers: {Range: 'bytes=-4'}});
  ok(suffix, 206);
  assert.deepEqual(suffix.bytes, PNG.subarray(-4));
  const invalidRange = await f.request(download, {actor: viewer, headers: {Range: 'bytes=999999-'}});
  assert.equal(invalidRange.status, 416);
  assert.equal(invalidRange.headers.get('content-range'), `bytes */${PNG.length}`);
  error(await f.request(`/api/materials/${created.id}`, {method: 'PATCH', actor: viewer, body: {expectedRevision: uploaded.revision, name: 'Viewer rename'}}), 403);
  error(await f.request(`/api/materials/${created.id}/file?expectedRevision=${uploaded.revision}`, {method: 'PUT', actor: viewer, rawBody: PNG, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': 'pixel.png'}}), 403);
  const renamed = ok(await f.request(`/api/materials/${created.id}`, {method: 'PATCH', actor, body: {expectedRevision: uploaded.revision, name: 'Renamed material'}})).item;
  assert.equal(renamed.revision, uploaded.revision + 1);
  assert.deepEqual((await f.request(download, {actor})).bytes, PNG, 'old selected file revision stays available');
  error(await f.request(`/api/materials/${created.id}`, {method: 'PATCH', actor, body: {expectedRevision: uploaded.revision, name: 'Stale rename'}}), 409);
  const other = await f.outsider();
  error(await f.request(download, {actor: other}), 404, 'cross-team file access denied');
  assert.equal(ok(await f.request('/api/resources', {actor: other})).materials.length, 0);
  await f.restart();
  assert.deepEqual((await f.request(download, {actor})).bytes, PNG, 'private uploaded bytes survive restart');
});

test('supplier and creator sources are explicit; creator codes remain private and never leak through catalogs', {timeout: 60000}, async t => {
  const f = await fixture(t), actor = f.admin;
  const creator = ok(await f.request('/api/materials', {method: 'POST', actor, body: MATERIAL}), 201).item;
  assert.equal(creator.ready, true);
  assert.equal(creator.hasAdCode, true);
  assert.ok(!JSON.stringify(creator).includes(MATERIAL.adCode));
  const supplier = ok(await f.request('/api/materials', {method: 'POST', actor, body: {...MATERIAL, name: 'Synthetic supplier video', source: 'supplier', adCode: ''}}), 201).item;
  assert.equal(supplier.ready, false, 'a Feishu/source link is not proof the file was downloaded');
  const catalog = ok(await f.request('/api/resources', {actor}));
  assert.equal(catalog.materials.length, 2);
  assert.ok(!JSON.stringify(catalog).includes(MATERIAL.adCode));
  error(await f.request('/api/materials', {method: 'POST', actor, body: {...MATERIAL, sourceUrl: 'javascript:alert(1)'}}), 400);
});

test('audience CSV import normalizes, deduplicates and privately hashes emails without publishing identifiers', {timeout: 90000}, async t => {
  const f = await fixture(t), actor = f.admin;
  const csv = 'email,name\r\n" Alice@Example.com ",Synthetic\r\nalice@example.com,Duplicate\r\nbob@example.com,Synthetic\r\nnot-email,Bad\r\n,Blank\r\n';
  error(await f.request('/api/audiences', {method: 'POST', actor, body: {name: 'Synthetic payers', type: 'historical_paid', description: 'Synthetic import only', csv, authorized: false}}), 400);
  const audience = ok(await f.request('/api/audiences', {method: 'POST', actor, body: {name: 'Synthetic payers', type: 'historical_paid', description: 'Synthetic import only', csv, authorized: true}}), 201).item;
  assert.equal(audience.type, 'historical_paid');
  assert.equal(audience.counts.unique, 2);
  assert.equal(audience.counts.duplicate, 1);
  assert.equal(audience.counts.invalid, 2);
  const publicJson = JSON.stringify(audience).toLowerCase();
  for (const value of ['alice@example.com', 'bob@example.com', createHash('sha256').update('alice@example.com').digest('hex')]) assert.ok(!publicJson.includes(value), 'catalog contains aggregate counts only');
  const files = await flattenFiles(f.directory);
  for (const file of files) {
    const bytes = await readFile(file);
    assert.ok(!bytes.includes(Buffer.from('Alice@Example.com')) && !bytes.includes(Buffer.from('alice@example.com')) && !bytes.includes(Buffer.from('bob@example.com')), `raw audience PII was not persisted: ${file.slice(f.directory.length)}`);
  }
  const updated = ok(await f.request(`/api/audiences/${audience.id}`, {method: 'PATCH', actor, body: {expectedRevision: audience.revision, description: 'Updated usage note'}})).item;
  assert.equal(updated.revision, audience.revision + 1);
  assert.equal(updated.counts.unique, 2);
  for (const type of ['current_paid', 'active_users', 'campaign_participants', 'custom']) {
    const entry = ok(await f.request('/api/audiences', {method: 'POST', actor, body: {name: `Synthetic ${type}`, type, description: '', csv: 'email\nsynthetic@example.com', authorized: true}}), 201).item;
    assert.equal(entry.type, type);
  }
  error(await f.request('/api/audiences', {method: 'POST', actor, body: {name: 'Unsupported DB fetch', type: 'custom', description: '', source: 'database', csv, authorized: true}}), 400, 'future DB pull must not pretend to work');
  const other = await f.outsider();
  assert.equal(ok(await f.request('/api/resources', {actor: other})).audiences.length, 0);
  error(await f.request(`/api/audiences/${audience.id}`, {method: 'PATCH', actor: other, body: {expectedRevision: updated.revision, description: 'Cross-team'}}), 404);
});

test('landing labels and activity pages are versioned; unsafe sitemap fetches fail without changing the library', {timeout: 90000}, async t => {
  const f = await fixture(t), actor = f.admin;
  const landing = ok(await f.request('/api/landings', {method: 'POST', actor, body: LANDING}), 201).item;
  assert.deepEqual(landing.tags, LANDING.tags);
  const changed = ok(await f.request(`/api/landings/${landing.id}`, {method: 'PATCH', actor, body: {expectedRevision: landing.revision, tags: ['video', 'activity'], description: 'Manually categorized activity landing'}})).item;
  assert.equal(changed.revision, landing.revision + 1);
  assert.deepEqual(changed.tags, ['video', 'activity']);
  const before = ok(await f.request('/api/resources', {actor}));
  for (const sitemapUrl of ['http://127.0.0.1/sitemap.xml', 'https://127.0.0.1/sitemap.xml', 'https://[::1]/sitemap.xml', 'https://169.254.169.254/latest/meta-data/', 'https:' + '//user:password@example.com/sitemap.xml']) {
    error(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl}}), [400, 403], 'private/local/credential URL rejected before fetch');
  }
  error(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl: 'https://example.com/sitemap.xml'}}), 429, 'bounded sync attempts per team');
  const after = ok(await f.request('/api/resources', {actor}));
  assert.deepEqual(after.landings, before.landings, 'failed sync must not partially add/remove pages or overwrite manual categories');
  assert.equal(after.landings[0].source, 'manual');
  error(await f.request('/api/landings', {method: 'POST', actor, body: {...LANDING, url: 'javascript:alert(1)'}}), 400);
  const viewer = await f.invitedMember(actor, 'viewer@example.com', 'viewer');
  error(await f.request('/api/landings/sync', {method: 'POST', actor: viewer, body: {sitemapUrl: 'https://example.com/sitemap.xml'}}), 403);
  error(await f.request('/api/landings', {method: 'POST', actor: viewer, body: LANDING}), 403);
});


test('sitemap parser handles indexes and escaped URLs while rejecting entities, malformed structure and oversized maps', () => {
  assert.throws(() => httpsURL('file:///etc/passwd'), error => error.code === 'INVALID_URL');
  const index = {url: 'https://example.com/sitemap.xml', kind: 'sitemapindex', children: ['https://example.com/tools.xml', 'https://example.com/blog.xml']};
  assert.throws(() => chooseSitemapChildren(index), failure => failure.status === 409 && failure.code === 'SITEMAP_SELECTION_REQUIRED' && JSON.stringify(failure.extra.sitemap) === JSON.stringify(index));
  assert.deepEqual(chooseSitemapChildren(index, [index.children[0]]), [index.children[0]]);
  for (const selected of [[index.children[0], index.children[0]], ['https://example.com/undeclared.xml'], ['https://other.example.com/tools.xml']]) assert.throws(() => chooseSitemapChildren(index, selected), failure => failure.status === 400 && failure.code === 'INVALID_SITEMAP_SELECTION');
  assert.deepEqual(chooseSitemapChildren({...index, kind: 'urlset', children: []}, []), []);
  assert.throws(() => chooseSitemapChildren({...index, kind: 'urlset', children: []}, [index.children[0]]), failure => failure.status === 400);

  const map = parseSitemap('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/create?one=1&amp;two=2</loc><lastmod>2026-10-27</lastmod></url></urlset>');
  assert.deepEqual(map, {kind: 'urlset', locations: ['https://example.com/create?one=1&two=2']});
  assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc><![CDATA[https://example.com/part.xml]]></loc></sitemap></sitemapindex>'), {kind: 'sitemapindex', locations: ['https://example.com/part.xml']});
  for (const xml of [
    '<!DOCTYPE urlset [<!ENTITY leak SYSTEM "file:///etc/passwd">]><urlset><url><loc>&leak;</loc></url></urlset>',
    '<urlset><url><loc>https://example.com/</url></loc></urlset>',
    '<urlset><url><loc><nested>https://example.com/</nested></loc></url></urlset>',
    '<urlset><url><loc>&unsupported;</loc></url></urlset>',
    '<urlset></urlset><urlset></urlset>',
    '<html><body>Sign in required</body></html>',
  ]) assert.throws(() => parseSitemap(xml), error => error.status === 400 && error.code === 'INVALID_SITEMAP');
  assert.throws(() => parseSitemap('<urlset>' + '<url><loc>https://example.com/</loc></url>'.repeat(2001) + '</urlset>'), error => error.status === 413);
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.31.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001::1', '2001:0000::1', '2001:2::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(publicAddress(ip), true, ip);
});

test('audience CSV parser supports quoted/multiline fields and rejects malformed or ambiguous imports', () => {
  const parsed = parseAudienceCSV('name,email,comment\n"A, User",ALICE@example.com,"two\nlines"\nB,bob@example.com,ok\n');
  assert.deepEqual(parsed.counts, {rows: 2, valid: 2, unique: 2, invalid: 0, duplicate: 0});
  assert.equal(parsed._hashes.length, 2);
  assert.ok(parsed._hashes.every(hash => /^[a-f0-9]{64}$/.test(hash)));
  assert.equal(parseAudienceCSV('single@example.com\nSINGLE@example.com').counts.unique, 1);
  assert.throws(() => parseAudienceCSV('name,address\nA,a@example.com'), error => error.code === 'EMAIL_COLUMN_REQUIRED');
  assert.throws(() => parseAudienceCSV('email\n"unclosed@example.com'), error => error.code === 'INVALID_CSV');
  assert.throws(() => parseAudienceCSV('email\ninvalid'), error => error.code === 'EMPTY_AUDIENCE');
});


test('successful sitemap refresh preserves labels and activity pages, marks missing pages unavailable and commits atomically', {timeout: 90000}, async t => {
  let urls = ['https://example.com/tool-a', 'https://example.com/tool-b'];
  let fail = false, selectedSeen = [];
  const selectedSitemaps = ['https://example.com/tools.xml'];
  const f = await fixture(t, {sitemapReader: async (url, options) => {
    selectedSeen = options.selectedSitemaps;
    if (fail) throw new Error('synthetic incomplete sitemap response');
    return {url, urls: [...urls], selectedSitemaps: [...options.selectedSitemaps]};
  }}), actor = f.admin;
  const manual = ok(await f.request('/api/landings', {method: 'POST', actor, body: {...LANDING, url: 'https://example.com/activity', name: 'Manual activity'}}), 201).item;
  const first = ok(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl: 'https://example.com/sitemap.xml', selectedSitemaps}}));
  assert.deepEqual(selectedSeen, selectedSitemaps, 'selected index branches are passed to the network reader');
  assert.deepEqual(first.sitemap.selectedSitemaps, selectedSitemaps, 'selected branches are saved with the refresh configuration');
  assert.equal(first.result.added, 2);
  assert.equal(first.result.total, 2);
  assert.equal(first.landings.length, 3);
  const a = first.landings.find(page => page.url === urls[0]), b = first.landings.find(page => page.url === urls[1]);
  assert.equal(a.source, 'sitemap');
  const categorized = ok(await f.request(`/api/landings/${a.id}`, {method: 'PATCH', actor, body: {expectedRevision: a.revision, name: 'User title', tags: ['video', 'creator'], description: 'User-written description', language: 'English', objective: 'registration'}})).item;
  urls = ['https://example.com/tool-a', 'https://example.com/tool-c'];
  const second = ok(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl: 'https://example.com/sitemap.xml'}}));
  assert.equal(second.result.added, 1);
  assert.equal(second.result.removed, 1);
  const retained = second.landings.find(page => page.id === a.id);
  assert.equal(retained.name, categorized.name);
  assert.deepEqual(retained.tags, categorized.tags);
  assert.equal(retained.description, categorized.description);
  assert.equal(retained.revision, categorized.revision, 'unchanged sitemap membership does not create a resource revision');
  assert.equal(second.landings.find(page => page.id === b.id).available, false);
  assert.equal(second.landings.find(page => page.id === manual.id).available, true, 'a sitemap never removes a manually registered activity page');
  const oldB = ok(await f.request(`/api/landings/${b.id}?revision=${b.revision}`, {actor})).item;
  assert.equal(oldB.available, true, 'selected historic versions remain inspectable');
  const beforeFailure = ok(await f.request('/api/resources', {actor}));
  urls = ['https://example.com/uncommitted-new'];
  fail = true;
  error(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl: 'https://example.com/sitemap.xml'}}), [400, 500]);
  assert.deepEqual(ok(await f.request('/api/resources', {actor})), beforeFailure, 'failed retrieval must leave the full inventory and sync marker unchanged');
  fail = false;
  f.app.db.exec("CREATE TRIGGER phase34_abort_sync BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic atomic sync failure'); END;");
  error(await f.request('/api/landings/sync', {method: 'POST', actor, body: {sitemapUrl: 'https://example.com/sitemap.xml'}}), 500);
  f.app.db.exec('DROP TRIGGER phase34_abort_sync');
  assert.deepEqual(ok(await f.request('/api/resources', {actor})), beforeFailure, 'resource revisions, availability, audit and sync marker roll back together');
});
