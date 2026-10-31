// SPDX-License-Identifier: MIT
import {createReadStream, constants} from 'node:fs';
import {mkdir, stat, copyFile, chmod, rename, open, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {PassThrough} from 'node:stream';
import {AppError, ensure} from './errors.mjs';

const require = createRequire(import.meta.url);
const MAX_FILE = 100 * 1024 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'video/mp4', 'video/webm']);
const safeTeam = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);
const safeHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const safeSize = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_FILE;
const storageError = (code, message, status = 502) => new AppError(status, code, message);
const readError = () => storageError('STORAGE_READ_FAILED', '素材文件暂时无法读取，请稍后重试。');
const headerMap = value => Object.fromEntries(Object.entries(value || {}).map(([key, v]) => [key.toLowerCase(), String(v)]));
const headersOf = response => headerMap(response?.res?.headers || response?.headers);
function safePrefix(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200 && value.split('/').every(part => /^[a-zA-Z0-9_-]+$/.test(part));
}
function validateFile(teamId, file) {
  ensure(safeTeam(teamId) && file && safeHash(file.sha256) && safeSize(file.size) && MIME_TYPES.has(file.mime), 400, 'INVALID_FILE_REFERENCE', '素材文件记录无效，请重新上传。');
}
export function parseRange(value, size) {
  ensure(safeSize(size), 400, 'INVALID_FILE_REFERENCE', '素材文件大小无效。');
  if (value === undefined || value === null) return null;
  const fail = () => { throw new AppError(416, 'INVALID_RANGE', '请求的素材范围无效。', {contentRange: `bytes */${size}`}); };
  if (typeof value !== 'string') return fail();
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return fail();
  let start, end;
  if (!match[1]) {
    const length = Number(match[2]);
    if (!Number.isSafeInteger(length) || length <= 0) return fail();
    start = Math.max(0, size - length); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return fail();
    end = Math.min(end, size - 1);
  }
  return {start, end, contentLength: end - start + 1, contentRange: `bytes ${start}-${end}/${size}`};
}
function configuration(env) {
  const provider = env.MEDIA_STORAGE || 'local';
  ensure(['local', 'oss'].includes(provider), 500, 'INVALID_STORAGE_CONFIG', '素材存储类型需要配置为 local 或 oss。');
  const bucket = env.OSS_BUCKET || '', region = env.OSS_REGION || '', prefix = env.OSS_PREFIX || 'ad-growth-console';
  const endpoint = env.OSS_ENDPOINT || (region ? `https://${region}.aliyuncs.com` : '');
  let validEndpoint = false;
  try {
    const url = new URL(endpoint);
    validEndpoint = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && (url.pathname === '' || url.pathname === '/') && [region + '.aliyuncs.com', region + '-internal.aliyuncs.com'].includes(url.hostname);
  } catch { /* A missing or malformed configuration remains unavailable. */ }
  const ossConfigured = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) && /^oss-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(region) && safePrefix(prefix) && validEndpoint && typeof env.OSS_ACCESS_KEY_ID === 'string' && Boolean(env.OSS_ACCESS_KEY_ID.trim()) && typeof env.OSS_ACCESS_KEY_SECRET === 'string' && Boolean(env.OSS_ACCESS_KEY_SECRET.trim());
  return {provider, bucket, region, prefix, endpoint, ossConfigured, accessKeyId: env.OSS_ACCESS_KEY_ID, accessKeySecret: env.OSS_ACCESS_KEY_SECRET, stsToken: env.OSS_STS_TOKEN || undefined};
}
async function sourceDigest(filePath, expectedSize) {
  const info = await stat(filePath);
  ensure(info.isFile() && info.size === expectedSize, 400, 'FILE_INTEGRITY_FAILED', '素材文件大小与上传记录不一致，请重新上传。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}
function isolatedStream(input) {
  const output = new PassThrough();
  input.once('error', () => output.destroy(readError()));
  output.once('close', () => input.destroy());
  input.pipe(output);
  return output;
}

export function createMediaStorage({dataDir, env = process.env, ossClient} = {}) {
  ensure(typeof dataDir === 'string' && dataDir.length > 0, 500, 'INVALID_STORAGE_CONFIG', '请配置私有数据目录。');
  const cfg = configuration(env), privateDir = resolve(dataDir);
  let client = ossClient, verified = false;
  const configured = cfg.provider === 'local' || cfg.ossConfigured;
  const status = () => ({provider: cfg.provider, configured, ready: cfg.provider === 'local' || verified});
  function cloud() {
    ensure(cfg.ossConfigured, 503, 'OSS_NOT_CONFIGURED', '阿里云 OSS 尚未配置完整，请部署者完成私有存储配置。');
    if (!client) {
      try {
        const OSS = require('ali-oss');
        client = new OSS({region: cfg.region, bucket: cfg.bucket, endpoint: cfg.endpoint, accessKeyId: cfg.accessKeyId, accessKeySecret: cfg.accessKeySecret, ...(cfg.stsToken ? {stsToken: cfg.stsToken} : {}), authorizationV4: true, secure: true, timeout: 60000});
      } catch { throw storageError('OSS_CLIENT_UNAVAILABLE', 'OSS 存储组件未就绪，请检查部署配置。', 503); }
    }
    return client;
  }
  const objectKey = (teamId, sha256) => `${cfg.prefix}/materials/${teamId}/${sha256}`;
  const localPath = (teamId, sha256) => join(privateDir, 'uploads', 'materials', teamId, sha256);
  async function verifiedHead(teamId, file) {
    const storage = file.storage;
    ensure(storage && storage.provider === 'oss' && storage.bucket === cfg.bucket && storage.region === cfg.region && storage.key === objectKey(teamId, file.sha256), 400, 'INVALID_STORAGE_REFERENCE', '素材存储位置与当前团队或存储配置不一致。');
    const result = await cloud().head(storage.key), headers = headersOf(result);
    ensure((result.res?.status ?? result.status) === 200 && Number(headers['content-length']) === file.size && (headers['x-oss-meta-sha256'] || result.meta?.sha256) === file.sha256, 502, 'STORAGE_INTEGRITY_FAILED', 'OSS 中的素材记录未通过完整性检查，请重新上传或恢复文件。');
    return {result, headers};
  }
  async function putFile({teamId, sha256, filePath, size, mime}) {
    validateFile(teamId, {sha256, size, mime});
    ensure(typeof filePath === 'string' && filePath, 400, 'INVALID_FILE_REFERENCE', '请提供待保存的素材文件。');
    if (cfg.provider === 'oss') cloud(); // Explicit OSS never falls back to local.
    let actualHash;
    try { actualHash = await sourceDigest(filePath, size); }
    catch (error) { if (error instanceof AppError) throw error; throw storageError('FILE_READ_FAILED', '上传文件暂时无法读取，请重新上传。'); }
    ensure(actualHash === sha256, 400, 'FILE_INTEGRITY_FAILED', '素材文件与上传指纹不一致，请重新上传。');
    if (cfg.provider === 'local') {
      const path = localPath(teamId, sha256), directory = join(privateDir, 'uploads', 'materials', teamId), temporary = join(directory, `.store-${randomUUID()}`);
      try {
        await mkdir(directory, {recursive: true, mode: 0o700});
        try {
          const existingHash = await sourceDigest(path, size);
          ensure(existingHash === sha256, 502, 'STORAGE_INTEGRITY_FAILED', '已有素材文件未通过完整性检查，请先恢复存储。');
          return {provider: 'local'};
        } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        await copyFile(filePath, temporary, constants.COPYFILE_EXCL); await chmod(temporary, 0o600);
        const handle = await open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, path);
        return {provider: 'local'};
      } catch (error) { if (error instanceof AppError) throw error; throw storageError('STORAGE_WRITE_FAILED', '素材文件未能保存，请稍后重试。'); }
      finally { await rm(temporary, {force: true}).catch(() => {}); }
    }
    const storage = {provider: 'oss', key: objectKey(teamId, sha256), bucket: cfg.bucket, region: cfg.region};
    const source = createReadStream(filePath);
    try {
      const result = await cloud().putStream(storage.key, source, {contentLength: size, headers: {'Content-Type': mime, 'x-oss-object-acl': 'private', 'x-oss-meta-sha256': sha256}});
      ensure((result?.res?.status ?? result?.status) >= 200 && (result?.res?.status ?? result?.status) < 300, 502, 'STORAGE_WRITE_FAILED', 'OSS 未确认本次素材上传，请稍后重试。');
      await verifiedHead(teamId, {sha256, size, mime, storage});
      verified = true;
      return storage;
    } catch (error) { if (error instanceof AppError) throw error; throw storageError('STORAGE_WRITE_FAILED', 'OSS 素材上传未完成，请检查存储配置后重试。'); }
    finally { source.destroy(); }
  }
  async function openRead({teamId, file, range} = {}) {
    validateFile(teamId, file);
    const requested = parseRange(range, file.size), response = {size: file.size, contentLength: requested?.contentLength ?? file.size, ...(requested ? {contentRange: requested.contentRange} : {}), status: requested ? 206 : 200};
    const provider = file.storage?.provider || 'local';
    ensure(['local', 'oss'].includes(provider), 400, 'INVALID_STORAGE_REFERENCE', '素材存储记录不受支持。');
    if (provider === 'local') {
      try {
        const path = localPath(teamId, file.sha256), info = await stat(path);
        ensure(info.isFile() && info.size === file.size, 502, 'STORAGE_INTEGRITY_FAILED', '素材文件未通过完整性检查，请恢复文件。');
        return {...response, stream: isolatedStream(createReadStream(path, requested ? {start: requested.start, end: requested.end} : {}))};
      } catch (error) { if (error instanceof AppError) throw error; throw readError(); }
    }
    try {
      await verifiedHead(teamId, file);
      const result = await cloud().getStream(file.storage.key, requested ? {headers: {Range: `bytes=${requested.start}-${requested.end}`}} : {}), headers = headersOf(result);
      const valid = (result.res?.status ?? result.status) === response.status && Number(headers['content-length']) === response.contentLength && (!requested || headers['content-range'] === requested.contentRange) && result.stream?.pipe;
      if (!valid) { result.stream?.destroy(); throw storageError('STORAGE_INTEGRITY_FAILED', 'OSS 返回的素材范围未通过检查，请稍后重试。'); }
      verified = true;
      return {...response, stream: isolatedStream(result.stream)};
    } catch (error) { if (error instanceof AppError) throw error; throw readError(); }
  }
  return {provider: cfg.provider, configured, status, putFile, openRead};
}
