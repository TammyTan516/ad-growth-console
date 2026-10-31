// SPDX-License-Identifier: MIT
import {randomUUID, createHash} from 'node:crypto';
import {mkdir, open, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {ensure} from './errors.mjs';
import {fields, text, revision as checkRevision} from './validation.mjs';
import {readSitemap, inspectSitemap, httpsURL} from './resources-network.mjs';
import {createMediaStorage} from './media-storage.mjs';

const EDITORS = ['admin', 'editor'];
const ALL_ROLES = [...EDITORS, 'viewer'];
const MAX_FILE = 100 * 1024 * 1024;
const AUDIENCE_TYPES = ['historical_paid', 'current_paid', 'active_users', 'campaign_participants', 'custom'];
const date = () => new Date().toISOString();
const idPattern = /^[a-zA-Z0-9-]{1,100}$/;
const digest = data => createHash('sha256').update(data).digest('hex');

function optionalURL(value, label) {
  if (!value) return '';
  return httpsURL(text(value, label, 2048), label, {allowFragment: true}).href;
}
function strings(value, label, maxItems = 20, maxLength = 80) {
  ensure(Array.isArray(value) && value.length <= maxItems, 400, 'INVALID_INPUT', `${label}最多填写 ${maxItems} 项。`);
  return [...new Set(value.map(v => text(v, label, maxLength, true)))];
}
function status(value) {
  ensure(['active', 'archived'].includes(value), 400, 'INVALID_INPUT', '资源状态不正确。');
  return value;
}
function metadata(kind, input, before = null) {
  const allowed = {
    material: ['name', 'source', 'sourceUrl', 'mediaType', 'notes', 'adCode', 'status', 'expectedRevision'],
    audience: ['name', 'type', 'description', 'csv', 'authorized', 'status', 'expectedRevision'],
    landing: ['name', 'url', 'description', 'tags', 'language', 'objective', 'status', 'expectedRevision'],
  };
  fields(input, allowed[kind]);
  const value = {...before, ...input};
  const name = text(value.name, '资源名称', 120, true);
  const nextStatus = status(value.status || 'active');
  if (kind === 'material') {
    ensure(['upload', 'supplier', 'creator'].includes(value.source), 400, 'INVALID_INPUT', '请选择上传素材、供应商素材或达人素材。');
    ensure(['image', 'video'].includes(value.mediaType), 400, 'INVALID_INPUT', '请选择图片或视频。');
    const adCode = text(value.adCode ?? '', '达人广告代码', 1000);
    ensure(!adCode || (value.source === 'creator' && value.mediaType === 'video'), 400, 'INVALID_INPUT', '广告代码仅适用于达人视频素材。');
    const _file = before?._file || null;
    ensure(!_file || _file.mime.startsWith(value.mediaType === 'image' ? 'image/' : 'video/'), 400, 'MATERIAL_TYPE_MISMATCH', '已上传文件与素材类型不一致，请新建另一份素材。');
    return {name, status: nextStatus, source: value.source, sourceUrl: optionalURL(value.sourceUrl ?? '', '素材来源链接'), mediaType: value.mediaType, notes: text(value.notes ?? '', '素材说明', 3000), adCode, _file};
  }
  if (kind === 'audience') {
    ensure(AUDIENCE_TYPES.includes(value.type), 400, 'INVALID_INPUT', '人群类型不正确。');
    ensure((before && input.csv === undefined) || input.authorized === true, 400, 'AUDIENCE_PERMISSION_REQUIRED', '请确认你有权将这份名单用于广告受众。');
    const parsed = input.csv !== undefined ? parseAudienceCSV(input.csv) : before;
    ensure(parsed?.counts && parsed?._hashes, 400, 'AUDIENCE_FILE_REQUIRED', '请上传含邮箱列的 CSV 名单。');
    return {name, status: nextStatus, type: value.type, description: text(value.description ?? '', '人群说明', 2000), source: 'upload', counts: parsed.counts, _hashes: parsed._hashes, authorizedAt: before?.authorizedAt || date()};
  }
  return {name, status: nextStatus, url: httpsURL(text(value.url, '落地页链接', 2048, true), '落地页链接', {allowFragment: true}).href, description: text(value.description ?? '', '页面说明', 3000), tags: strings(value.tags ?? [], '页面标签'), language: text(value.language ?? '', '页面语言', 80), objective: ['registration', 'first_subscription', 'both'].includes(value.objective) ? value.objective : (() => { ensure(false, 400, 'INVALID_INPUT', '请选择注册、首次订阅或两者均可。'); })(), source: before?.source || 'manual', available: before?.available ?? true};
}

// Supports quoted fields, escaped quotes, embedded line breaks and an optional
// named email column. Only irreversible normalized hashes leave this function.
export function parseAudienceCSV(value) {
  ensure(typeof value === 'string' && Buffer.byteLength(value) <= 5 * 1024 * 1024, 413, 'AUDIENCE_TOO_LARGE', 'CSV 名单不能超过 5 MB。');
  const content = value.replace(/^\uFEFF/, '');
  const records = [];
  let row = [], field = '', quoted = false, afterQuote = false;
  const finishField = () => { row.push(field); field = ''; afterQuote = false; };
  const finishRow = () => { finishField(); if (row.some(cell => cell.trim())) records.push(row); row = []; ensure(records.length <= 50001, 413, 'AUDIENCE_TOO_LARGE', '每份名单最多支持 50000 行。'); };
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quoted) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else field += ch;
    } else if (ch === ',') finishField();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && content[i + 1] === '\n') i++; finishRow(); }
    else if (ch === '"') { ensure(!field && !afterQuote, 400, 'INVALID_CSV', 'CSV 引号格式不正确，请重新导出。'); quoted = true; }
    else { ensure(!afterQuote || /[ \t]/.test(ch), 400, 'INVALID_CSV', 'CSV 引号后含有不支持的字符。'); if (!afterQuote) field += ch; }
    ensure(field.length <= 10000 && row.length <= 100, 400, 'INVALID_CSV', 'CSV 字段过长或列数过多。');
  }
  ensure(!quoted, 400, 'INVALID_CSV', 'CSV 引号未闭合，请重新导出。');
  if (field || row.length || afterQuote) finishRow();
  ensure(records.length > 0, 400, 'EMPTY_AUDIENCE', '名单中没有可用内容。');
  const header = records[0].map(cell => cell.trim().toLowerCase());
  const index = header.findIndex(cell => ['email', 'e-mail', 'email_address', 'email address', '邮箱', '邮箱地址'].includes(cell));
  ensure(index >= 0 || records[0].length === 1, 400, 'EMAIL_COLUMN_REQUIRED', '多列 CSV 需要一列名为 email 或邮箱。');
  const data = index >= 0 ? records.slice(1) : records;
  const hashes = new Set();
  let valid = 0, invalid = 0;
  for (const record of data) {
    const email = (record[index >= 0 ? index : 0] || '').trim().toLowerCase();
    if (email.length <= 254 && !/[\u0000-\u001f\u007f]/.test(email) && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) { valid++; hashes.add(digest(email)); }
    else invalid++;
  }
  ensure(hashes.size > 0, 400, 'EMPTY_AUDIENCE', '名单中没有有效邮箱，请检查后重新上传。');
  return {counts: {rows: data.length, valid, unique: hashes.size, invalid, duplicate: valid - hashes.size}, _hashes: [...hashes].sort()};
}

export function fileSignature(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return {mime: 'image/png', extension: 'png'};
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {mime: 'image/jpeg', extension: 'jpg'};
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return {mime: 'image/gif', extension: 'gif'};
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return {mime: 'image/webp', extension: 'webp'};
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return {mime: 'video/mp4', extension: 'mp4'};
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return {mime: 'video/webm', extension: 'webm'};
  ensure(false, 415, 'UNSUPPORTED_FILE', '请上传 PNG、JPG、GIF、WebP 图片或 MP4、WebM 视频。');
}

export function createResources({store, dataDir, sitemapReader = readSitemap, mediaStorage = createMediaStorage({dataDir, env: {}})}) {
  const db = store.db, privateDir = resolve(dataDir);
  const activeUploads = new Set();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_resource (
      id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES app_team(id),kind TEXT NOT NULL CHECK(kind IN ('material','audience','landing')),
      data_json TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),created_by TEXT NOT NULL REFERENCES user(id),
      updated_by TEXT NOT NULL REFERENCES user(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_resource_team ON app_resource(team_id,kind,updated_at);
    CREATE TABLE IF NOT EXISTS app_resource_version (
      resource_id TEXT NOT NULL REFERENCES app_resource(id),team_id TEXT NOT NULL,revision INTEGER NOT NULL,
      data_json TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES user(id),created_at TEXT NOT NULL,PRIMARY KEY(resource_id,revision)
    );
    CREATE TABLE IF NOT EXISTS app_sitemap (team_id TEXT PRIMARY KEY REFERENCES app_team(id),url TEXT NOT NULL,last_synced_at TEXT NOT NULL,selected_sitemaps_json TEXT NOT NULL DEFAULT '[]');
    INSERT OR IGNORE INTO app_migration VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  if (!db.prepare('PRAGMA table_info(app_sitemap)').all().some(column => column.name === 'selected_sitemaps_json')) db.exec("ALTER TABLE app_sitemap ADD COLUMN selected_sitemaps_json TEXT NOT NULL DEFAULT '[]'");
  function raw(teamId, id, version) {
    ensure(typeof id === 'string' && idPattern.test(id), 404, 'RESOURCE_NOT_FOUND', '没有找到该资源，或你无权查看。');
    const row = db.prepare('SELECT * FROM app_resource WHERE team_id=? AND id=?').get(teamId, id);
    ensure(row, 404, 'RESOURCE_NOT_FOUND', '没有找到该资源，或你无权查看。');
    if (version !== undefined) {
      const historic = db.prepare('SELECT * FROM app_resource_version WHERE team_id=? AND resource_id=? AND revision=?').get(teamId, id, checkRevision(version));
      ensure(historic, 404, 'RESOURCE_VERSION_NOT_FOUND', '没有找到所选资源版本。');
      row.data_json = historic.data_json; row.revision = historic.revision; row.updated_at = historic.created_at; row.updated_by = historic.actor_id;
    }
    return {id: row.id, kind: row.kind, revision: row.revision, ...JSON.parse(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at};
  }
  function safe(item) {
    const {_hashes, _file, adCode, ...result} = item;
    if (item.kind === 'material') {
      result.hasAdCode = Boolean(adCode); result.hasFile = Boolean(_file); result.ready = Boolean(_file || adCode);
      result.file = _file ? {name: _file.name, size: _file.size, mime: _file.mime, sha256: _file.sha256} : null;
    }
    return result;
  }
  function get(teamId, id, version) { return safe(raw(teamId, id, version)); }
  function save(member, kind, data, id, expectedRevision) {
    // Caller wraps writes in a short transaction. Authorization is deliberately
    // checked again after request bodies, uploads and network fetches complete.
    store.actor(member, EDITORS);
    if (kind === 'landing') ensure(!db.prepare("SELECT 1 FROM app_resource WHERE team_id=? AND kind='landing' AND json_extract(data_json,'$.url')=? AND id<>?").get(member.team_id, data.url, id || ''), 409, 'DUPLICATE_LANDING', '落地页库中已有这个地址，请编辑已有页面。');
    const timestamp = date();
    if (!id) {
      id = randomUUID();
      db.prepare('INSERT INTO app_resource VALUES(?,?,?,?,?,?,?,?,?)').run(id, member.team_id, kind, JSON.stringify(data), 1, member.user_id, member.user_id, timestamp, timestamp);
    } else {
      const before = raw(member.team_id, id);
      ensure(before.kind === kind, 404, 'RESOURCE_NOT_FOUND', '资源类型不匹配。');
      ensure(before.revision === expectedRevision, 409, 'RESOURCE_REVISION_CONFLICT', '资源已被更新，请刷新后重新操作。', {current: {item: safe(before)}});
      db.prepare('UPDATE app_resource SET data_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND team_id=? AND revision=?').run(JSON.stringify(data), member.user_id, timestamp, id, member.team_id, expectedRevision);
    }
    const item = raw(member.team_id, id);
    db.prepare('INSERT INTO app_resource_version VALUES(?,?,?,?,?,?)').run(id, member.team_id, item.revision, JSON.stringify(data), member.user_id, timestamp);
    store.audit(member.team_id, member.user_id, `${kind}.${item.revision === 1 ? 'created' : 'updated'}`, null, null, {resourceId: id, resourceRevision: item.revision});
    return safe(item);
  }
  function catalog(teamId) {
    const rows = db.prepare('SELECT id FROM app_resource WHERE team_id=? ORDER BY updated_at DESC,id DESC').all(teamId);
    const all = rows.map(row => get(teamId, row.id));
    const config = db.prepare('SELECT url,last_synced_at AS lastSyncedAt,selected_sitemaps_json FROM app_sitemap WHERE team_id=?').get(teamId);
    const sitemap = config ? {url: config.url, lastSyncedAt: config.lastSyncedAt, selectedSitemaps: JSON.parse(config.selected_sitemaps_json)} : {url: '', lastSyncedAt: null, selectedSitemaps: []};
    return {materials: all.filter(i => i.kind === 'material'), audiences: all.filter(i => i.kind === 'audience'), landings: all.filter(i => i.kind === 'landing'), sitemap};
  }
  function resolveSelections(teamId, selection = {}) {
    fields(selection, ['materials', 'audiences', 'landing']);
    function selected(list, kind, max) {
      ensure(Array.isArray(list) && list.length <= max, 400, 'INVALID_SELECTION', '所选资源数量不正确。');
      ensure(new Set(list.map(v => v?.id)).size === list.length, 400, 'INVALID_SELECTION', '同一份资源不能重复选择。');
      return list.map(ref => {
        fields(ref, kind === 'audience' ? ['id', 'revision', 'use'] : ['id', 'revision']);
        const item = get(teamId, ref.id, checkRevision(ref.revision));
        ensure(item.kind === kind, 400, 'INVALID_SELECTION', '所选资源类型不正确。');
        if (kind === 'audience') { ensure(['include', 'exclude'].includes(ref.use), 400, 'INVALID_SELECTION', '请选择包含或排除人群。'); item.use = ref.use; }
        return item;
      });
    }
    const materials = selected(selection.materials || [], 'material', 30), audiences = selected(selection.audiences || [], 'audience', 20);
    let landing = null;
    if (selection.landing) {
      fields(selection.landing, ['id', 'revision']);
      landing = get(teamId, selection.landing.id, checkRevision(selection.landing.revision));
      ensure(landing.kind === 'landing', 400, 'INVALID_SELECTION', '请选择有效的落地页。');
    }
    return {materials, audiences, landing};
  }
  function validateCurrent(teamId, selection) {
    const snapshot = resolveSelections(teamId, selection);
    for (const item of [...snapshot.materials, ...snapshot.audiences, ...(snapshot.landing ? [snapshot.landing] : [])]) {
      const latest = get(teamId, item.id);
      ensure(item.revision === latest.revision && latest.status === 'active' && latest.available !== false, 409, 'RESOURCE_CHANGED', '所选资源已有更新、已归档或已从 Sitemap 移除，请重新选择并审核。');
    }
    return snapshot;
  }
  async function receiveFile(req, member, material, expectedRevision) {
    ensure(/^application\/octet-stream(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 415, 'BINARY_REQUIRED', '请直接上传素材文件。');
    ensure(!activeUploads.has(member.user_id), 409, 'UPLOAD_IN_PROGRESS', '已有文件正在上传，请等待完成。');
    ensure(Number(req.headers['content-length'] || 0) <= MAX_FILE, 413, 'FILE_TOO_LARGE', '单份素材不能超过 100 MB。');
    const nameHeader = req.headers['x-file-name'];
    ensure(typeof nameHeader === 'string', 400, 'FILE_NAME_REQUIRED', '请提供文件名称。');
    let originalName;
    try { originalName = decodeURIComponent(nameHeader); } catch { ensure(false, 400, 'INVALID_FILE_NAME', '文件名称无效。'); }
    const name = text(originalName.split(/[\\/]/).at(-1), '文件名称', 200, true);
    const directory = join(privateDir, 'uploads', 'materials', member.team_id);
    activeUploads.add(member.user_id);
    const tempPath = join(directory, `.upload-${randomUUID()}`);
    let file;
    try {
      await mkdir(directory, {recursive: true, mode: 0o700});
      file = await open(tempPath, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0, first = Buffer.alloc(0);
      for await (const chunk of req) {
        size += chunk.length;
        ensure(size <= MAX_FILE, 413, 'FILE_TOO_LARGE', '单份素材不能超过 100 MB。');
        if (first.length < 32) first = Buffer.concat([first, chunk.subarray(0, 32 - first.length)]);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const {bytesWritten} = await file.write(chunk, offset, chunk.length - offset);
          ensure(bytesWritten > 0, 500, 'FILE_WRITE_FAILED', '素材文件未能完整保存，请重新上传。');
          offset += bytesWritten;
        }
      }
      ensure(size > 0, 400, 'EMPTY_FILE', '请上传有效的素材文件。');
      const signature = fileSignature(first), sha256 = hash.digest('hex');
      ensure(signature.mime.startsWith(material.mediaType === 'image' ? 'image/' : 'video/'), 400, 'MATERIAL_TYPE_MISMATCH', '上传文件与所选图片或视频类型不一致。');
      await file.sync(); await file.close(); file = null;
      // Content-addressed private files are written once and reused across
      // selections. Every resource version retains its own file reference.
      const storage = await mediaStorage.putFile({teamId: member.team_id, sha256, filePath: tempPath, size, mime: signature.mime});
      return store.transaction(() => {
        store.actor(member, EDITORS);
        const latest = raw(member.team_id, material.id);
        ensure(latest.status === 'active', 409, 'RESOURCE_ARCHIVED', '素材已归档，请恢复后再上传。');
        const {id, kind, revision, createdAt, updatedAt, ...data} = latest;
        data._file = {sha256, name, size, mime: signature.mime, storage};
        return save(member, 'material', data, id, expectedRevision);
      });
    } finally {
      if (file) await file.close().catch(() => {});
      await rm(tempPath, {force: true}).catch(() => {});
      activeUploads.delete(member.user_id);
    }
  }
  async function sync(member, sitemapUrl, selectedSitemaps) {
    const imported = await sitemapReader(sitemapUrl, {selectedSitemaps});
    return store.transaction(() => {
      store.actor(member, EDITORS);
      const rows = db.prepare("SELECT id FROM app_resource WHERE team_id=? AND kind='landing'").all(member.team_id).map(row => raw(member.team_id, row.id));
      const existing = new Map(rows.map(item => [item.url, item]));
      const urls = new Set(imported.urls);
      let added = 0, restored = 0, removed = 0;
      for (const url of urls) {
        const before = existing.get(url);
        if (!before) {
          const parsed = new URL(url);
          let pathLabel = parsed.pathname;
          try { pathLabel = decodeURIComponent(pathLabel); } catch { /* Keep the valid URL's escaped path. */ }
          save(member, 'landing', {name: pathLabel.replace(/\//g, ' ').trim().slice(0, 120) || parsed.hostname, status: 'active', url, description: '', tags: [], language: '', objective: 'both', source: 'sitemap', available: true});
          added++;
        } else if (before.source === 'sitemap' && !before.available) {
          const {id, kind, revision, createdAt, updatedAt, ...data} = before;
          save(member, 'landing', {...data, available: true}, id, revision); restored++;
        }
      }
      for (const before of rows) if (before.source === 'sitemap' && before.available && !urls.has(before.url)) {
        const {id, kind, revision, createdAt, updatedAt, ...data} = before;
        save(member, 'landing', {...data, available: false}, id, revision); removed++;
      }
      const syncedAt = date();
      db.prepare('INSERT INTO app_sitemap(team_id,url,last_synced_at,selected_sitemaps_json) VALUES(?,?,?,?) ON CONFLICT(team_id) DO UPDATE SET url=excluded.url,last_synced_at=excluded.last_synced_at,selected_sitemaps_json=excluded.selected_sitemaps_json').run(member.team_id, imported.url, syncedAt, JSON.stringify(imported.selectedSitemaps || selectedSitemaps));
      store.audit(member.team_id, member.user_id, 'landing.sitemap_synced', null, null, {added, restored, removed, total: urls.size});
      return {added, restored, removed, total: urls.size, lastSyncedAt: syncedAt};
    });
  }
  async function handle(req, res, url, member, helpers) {
    const {json, body, requireEditor} = helpers;
    const pathname = url.pathname;
    if (pathname === '/api/resources' && req.method === 'GET') { json(res, 200, catalog(member.team_id)); return true; }
    if (pathname === '/api/landings/inspect' && req.method === 'POST') {
      requireEditor(member);
      const input = fields(await body(req), ['sitemapUrl']);
      store.consumeLimit('sitemap-inspect:' + member.team_id, 10, 60000);
      const sitemap = await inspectSitemap(text(input.sitemapUrl, 'Sitemap 地址', 2048, true));
      store.actor(member, EDITORS);
      json(res, 200, {sitemap}); return true;
    }
    if (pathname === '/api/landings/sync' && req.method === 'POST') {
      requireEditor(member);
      const input = fields(await body(req), ['sitemapUrl', 'selectedSitemaps']);
      const selectedSitemaps = input.selectedSitemaps === undefined ? [] : strings(input.selectedSitemaps, 'Sitemap 分类', 20, 2048);
      store.consumeLimit('sitemap:' + member.team_id, 5, 60000);
      const result = await sync(member, text(input.sitemapUrl, 'Sitemap 地址', 2048, true), selectedSitemaps);
      json(res, 200, {result, ...catalog(member.team_id)}); return true;
    }
    const collection = pathname.match(/^\/api\/(materials|audiences|landings)$/);
    const kindFrom = value => ({materials: 'material', audiences: 'audience', landings: 'landing'})[value];
    if (collection && req.method === 'POST') {
      requireEditor(member);
      const kind = kindFrom(collection[1]), input = await body(req, kind === 'audience' ? 6 * 1024 * 1024 : undefined);
      const data = metadata(kind, input);
      const item = store.transaction(() => save(member, kind, data));
      json(res, 201, {item}); return true;
    }
    const resource = pathname.match(/^\/api\/(materials|audiences|landings)\/([a-zA-Z0-9-]+)(\/file|\/versions)?$/);
    if (!resource) return false;
    const [, collectionName, id, extra] = resource, kind = kindFrom(collectionName);
    const before = raw(member.team_id, id);
    ensure(before.kind === kind, 404, 'RESOURCE_NOT_FOUND', '没有找到该资源，或你无权查看。');
    if (extra === '/versions' && req.method === 'GET') {
      const items = db.prepare('SELECT revision FROM app_resource_version WHERE resource_id=? AND team_id=? ORDER BY revision DESC').all(id, member.team_id).map(v => get(member.team_id, id, v.revision));
      json(res, 200, {items}); return true;
    }
    if (!extra && req.method === 'GET') { json(res, 200, {item: get(member.team_id, id, url.searchParams.has('revision') ? checkRevision(Number(url.searchParams.get('revision'))) : undefined)}); return true; }
    if (!extra && req.method === 'PATCH') {
      requireEditor(member);
      const input = await body(req, kind === 'audience' ? 6 * 1024 * 1024 : undefined);
      const expectedRevision = checkRevision(input.expectedRevision);
      const item = store.transaction(() => {
        const current = raw(member.team_id, id);
        return save(member, kind, metadata(kind, input, current), id, expectedRevision);
      });
      json(res, 200, {item}); return true;
    }
    if (kind === 'material' && extra === '/file') {
      if (req.method === 'PUT') {
        requireEditor(member);
        const expectedRevision = checkRevision(Number(url.searchParams.get('expectedRevision')));
        ensure(before.revision === expectedRevision && before.status === 'active', 409, 'RESOURCE_REVISION_CONFLICT', '素材已被更新或归档，请刷新后重试。');
        store.consumeLimit('upload:' + member.user_id, 20, 60000);
        const item = await receiveFile(req, member, before, expectedRevision);
        json(res, 200, {item}); return true;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const selected = raw(member.team_id, id, url.searchParams.has('revision') ? checkRevision(Number(url.searchParams.get('revision'))) : undefined);
        ensure(selected._file && /^[a-f0-9]{64}$/.test(selected._file.sha256), 404, 'FILE_NOT_FOUND', '该素材尚未上传文件。');
        let opened;
        try { opened = await mediaStorage.openRead({teamId: member.team_id, file: selected._file, range: req.method === 'GET' ? req.headers.range : undefined}); }
        catch (error) { if (error.status === 416) res.setHeader('Content-Range', error.extra.contentRange); throw error; }
        try { store.actor(member, ALL_ROLES); } catch (error) {opened.stream.destroy(); throw error;}
        res.writeHead(opened.status, {
          'Content-Type': selected._file.mime, 'Content-Length': opened.contentLength, 'Accept-Ranges': 'bytes',
          ...(opened.contentRange ? {'Content-Range': opened.contentRange} : {}),
          'Content-Disposition': `inline; filename="asset"; filename*=UTF-8''${encodeURIComponent(selected._file.name)}`, 'Content-Security-Policy': "default-src 'none'; sandbox",
        });
        if (req.method === 'HEAD') {opened.stream.destroy(); res.end();}
        else {
          const stream = opened.stream;
          stream.on('error', () => res.destroy());
          res.once('close', () => stream.destroy());
          stream.pipe(res);
        }
        return true;
      }
    }
    return false;
  }
  async function openMaterial(member, ref) {
    store.actor(member, ['admin', 'editor']);
    const item = raw(member.team_id, ref.id, ref.revision);
    ensure(item.kind === 'material' && item._file, 404, 'FILE_NOT_FOUND', '该冻结素材没有已保存文件。');
    const opened = await mediaStorage.openRead({teamId: member.team_id, file: item._file});
    try { store.actor(member, ['admin', 'editor']); } catch (error) {opened.stream.destroy(); throw error;}
    return {...opened, file: {name: item._file.name, mime: item._file.mime, size: item._file.size, sha256: item._file.sha256}};
  }
  return {handle, catalog, get, resolveSelections, validateCurrent, openMaterial};
}
