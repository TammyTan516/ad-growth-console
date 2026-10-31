// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {createMediaStorage, parseRange} from '../server/media-storage.mjs';

const env = {MEDIA_STORAGE: 'oss', OSS_BUCKET: 'synthetic-media-bucket', OSS_REGION: 'oss-cn-hangzhou', OSS_ACCESS_KEY_ID: 'synthetic-key-id', OSS_ACCESS_KEY_SECRET: 'synthetic-secret-value', OSS_PREFIX: 'ad-growth-console'};
const media = Buffer.from('synthetic media content for storage tests');
const sha256 = createHash('sha256').update(media).digest('hex');
const file = {sha256, name: 'synthetic.png', size: media.length, mime: 'image/png'};
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ad-media-storage-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const filePath = join(dataDir, 'upload.tmp'); await writeFile(filePath, media, {mode: 0o600});
  return {dataDir, filePath};
}
async function bytes(stream) { const chunks = []; for await (const part of stream) chunks.push(part); return Buffer.concat(chunks); }
function fakeOSS() {
  const objects = new Map(), calls = [];
  return {objects, calls,
    async putStream(key, stream, options) {
      const body = await bytes(stream); calls.push({type: 'put', key, options});
      objects.set(key, {body, sha256: options.headers['x-oss-meta-sha256']});
      return {res: {status: 200}};
    },
    async head(key) {
      calls.push({type: 'head', key}); const item = objects.get(key);
      if (!item) throw new Error('synthetic unavailable ' + env.OSS_ACCESS_KEY_SECRET);
      return {res: {status: 200, headers: {'content-length': String(item.body.length), 'x-oss-meta-sha256': item.sha256}}};
    },
    async getStream(key, options) {
      calls.push({type: 'get', key, options}); const item = objects.get(key), range = options.headers?.Range;
      if (range) {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range).map(Number);
        const body = item.body.subarray(start, end + 1);
        return {stream: Readable.from(body), res: {status: 206, headers: {'content-length': String(body.length), 'content-range': `bytes ${start}-${end}/${item.body.length}`}}};
      }
      return {stream: Readable.from(item.body), res: {status: 200, headers: {'content-length': String(item.body.length)}}};
    }
  };
}

test('local private content-addressed storage deduplicates media and supports old records after selecting OSS', async t => {
  const f = await fixture(t), store = createMediaStorage({dataDir: f.dataDir, env: {MEDIA_STORAGE: 'local'}});
  assert.deepEqual(store.status(), {provider: 'local', configured: true, ready: true});
  const storage = await store.putFile({teamId: 'team-a', ...file, filePath: f.filePath});
  assert.deepEqual(storage, {provider: 'local'});
  const path = join(f.dataDir, 'uploads', 'materials', 'team-a', sha256), first = await stat(path);
  assert.deepEqual(await readFile(path), media); assert.equal(first.mode & 0o777, 0o600);
  await store.putFile({teamId: 'team-a', ...file, filePath: f.filePath});
  assert.equal((await stat(path)).mtimeMs, first.mtimeMs, 'same content reuses the stored file');
  const selectedOSS = createMediaStorage({dataDir: f.dataDir, env: {MEDIA_STORAGE: 'oss'}});
  assert.deepEqual(selectedOSS.status(), {provider: 'oss', configured: false, ready: false});
  const legacy = await selectedOSS.openRead({teamId: 'team-a', file, range: 'bytes=2-7'});
  assert.equal(legacy.status, 206); assert.equal(legacy.contentRange, `bytes 2-7/${media.length}`);
  assert.deepEqual(await bytes(legacy.stream), media.subarray(2, 8));
  await assert.rejects(selectedOSS.openRead({teamId: 'team-b', file}), {code: 'STORAGE_READ_FAILED'});
  await writeFile(f.filePath, Buffer.alloc(media.length, 0));
  await assert.rejects(store.putFile({teamId: 'team-a', ...file, filePath: f.filePath}), {code: 'FILE_INTEGRITY_FAILED'});
});

test('explicit OSS remains unavailable without valid private configuration and never falls back to local', async t => {
  const f = await fixture(t);
  for (const config of [{MEDIA_STORAGE: 'oss'}, {...env, OSS_ACCESS_KEY_SECRET: ''}, {...env, OSS_ENDPOINT: 'http://oss-cn-hangzhou.aliyuncs.com'}, {...env, OSS_ENDPOINT: 'https://untrusted.example.com'}, {...env, OSS_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com'}, {...env, OSS_PREFIX: '../outside'}]) {
    const store = createMediaStorage({dataDir: f.dataDir, env: config});
    assert.equal(store.status().configured, false);
    await assert.rejects(store.putFile({teamId: 'team-a', ...file, filePath: f.filePath}), {code: 'OSS_NOT_CONFIGURED'});
    assert.ok(!JSON.stringify(store.status()).includes(env.OSS_ACCESS_KEY_SECRET));
  }
  await assert.rejects(stat(join(f.dataDir, 'uploads')), {code: 'ENOENT'});
});

test('OSS upload verifies remote size/hash before returning a private reference and download stays within the team key', async t => {
  const f = await fixture(t), client = fakeOSS(), store = createMediaStorage({dataDir: f.dataDir, env, ossClient: client});
  assert.deepEqual(store.status(), {provider: 'oss', configured: true, ready: false}, 'configuration alone does not prove cloud access');
  const storage = await store.putFile({teamId: 'team-a', ...file, filePath: f.filePath});
  assert.deepEqual(storage, {provider: 'oss', key: `ad-growth-console/materials/team-a/${sha256}`, bucket: env.OSS_BUCKET, region: env.OSS_REGION});
  assert.equal(store.status().ready, true);
  assert.equal(client.calls[0].options.contentLength, media.length);
  assert.equal(client.calls[0].options.headers['x-oss-object-acl'], 'private');
  assert.equal(client.calls[0].options.headers['x-oss-meta-sha256'], sha256);
  assert.ok(!JSON.stringify(storage).includes('https:'));
  const full = await store.openRead({teamId: 'team-a', file: {...file, storage}});
  assert.equal(full.status, 200); assert.deepEqual(await bytes(full.stream), media);
  const part = await store.openRead({teamId: 'team-a', file: {...file, storage}, range: 'bytes=-7'});
  assert.equal(part.status, 206); assert.deepEqual(await bytes(part.stream), media.subarray(-7));
  const calls = client.calls.length;
  await assert.rejects(store.openRead({teamId: 'team-b', file: {...file, storage}}), {code: 'INVALID_STORAGE_REFERENCE'});
  await assert.rejects(store.openRead({teamId: 'team-a', file: {...file, storage: {...storage, bucket: 'another-bucket'}}}), {code: 'INVALID_STORAGE_REFERENCE'});
  assert.equal(client.calls.length, calls, 'forged cloud references are rejected before a storage request');
});

test('OSS integrity and SDK failures do not produce ready references or expose raw provider errors', async t => {
  const f = await fixture(t), client = fakeOSS();
  const originalHead = client.head;
  client.head = async key => { const value = await originalHead.call(client, key); value.res.headers['content-length'] = '1'; return value; };
  const store = createMediaStorage({dataDir: f.dataDir, env, ossClient: client});
  await assert.rejects(store.putFile({teamId: 'team-a', ...file, filePath: f.filePath}), {code: 'STORAGE_INTEGRITY_FAILED'});
  assert.equal(store.status().ready, false);
  const failing = createMediaStorage({dataDir: f.dataDir, env, ossClient: {async putStream() {throw new Error(env.OSS_ACCESS_KEY_SECRET);}}});
  await assert.rejects(failing.putFile({teamId: 'team-a', ...file, filePath: f.filePath}), error => error.code === 'STORAGE_WRITE_FAILED' && !JSON.stringify(error).includes(env.OSS_ACCESS_KEY_SECRET) && !error.message.includes(env.OSS_ACCESS_KEY_SECRET));
  const valid = fakeOSS(), goodStore = createMediaStorage({dataDir: f.dataDir, env, ossClient: valid});
  const storage = await goodStore.putFile({teamId: 'team-a', ...file, filePath: f.filePath});
  valid.getStream = async () => ({stream: Readable.from('wrong bytes'), res: {status: 200, headers: {'content-length': '11'}}});
  await assert.rejects(goodStore.openRead({teamId: 'team-a', file: {...file, storage}, range: 'bytes=0-3'}), {code: 'STORAGE_INTEGRITY_FAILED'});
});

test('single-range parsing bounds media reads and rejects malformed or unsupported ranges', () => {
  assert.equal(parseRange(undefined, 20), null);
  assert.deepEqual(parseRange('bytes=3-7', 20), {start: 3, end: 7, contentLength: 5, contentRange: 'bytes 3-7/20'});
  assert.deepEqual(parseRange('bytes=15-', 20), {start: 15, end: 19, contentLength: 5, contentRange: 'bytes 15-19/20'});
  assert.deepEqual(parseRange('bytes=-99', 20), {start: 0, end: 19, contentLength: 20, contentRange: 'bytes 0-19/20'});
  assert.deepEqual(parseRange('bytes=0-99', 20), {start: 0, end: 19, contentLength: 20, contentRange: 'bytes 0-19/20'});
  for (const range of ['bytes=20-', 'bytes=7-3', 'bytes=-0', 'bytes=0-2,5-8', 'bytes=-', 'items=0-1', 'bytes=999999999999999999999-']) assert.throws(() => parseRange(range, 20), error => error.status === 416 && error.extra.contentRange === 'bytes */20');
});
