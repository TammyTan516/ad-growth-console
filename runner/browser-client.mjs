// SPDX-License-Identifier: MIT
// This is a workspace task bridge. Browser actions run in desktop Codex/Cua.
import {readFile, lstat, mkdir, open, rm, rename, chmod} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {join, isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ConnectorError, normalizeServer, defaultStateDir, readPrivate, writePrivate, acquireRunnerLock, clearStaleRunnerLock} from './client.mjs';
import {loadConnector} from './connect.mjs';

export const BROWSER_PLATFORMS = Object.freeze(['Google', 'Meta', 'TikTok']);
export const EVIDENCE_STAGES = Object.freeze(['preflight', 'before_publish', 'after_publish', 'before_enable', 'after_enable', 'reconcile']);
export const MAX_EVIDENCE_BYTES = 3 * 1024 * 1024;
const MAX_JSON_BYTES = 256 * 1024, MAX_REQUEST_BYTES = 5 * 1024 * 1024;
export const MAX_MATERIAL_BYTES = 100 * 1024 * 1024;
const MATERIAL_MIMES = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm'};
const ID = /^[A-Za-z0-9_-]{1,100}$/, SECRET = /^[A-Za-z0-9_-]{24,256}$/;
const HOSTS = {Google: ['ads.google.com'], Meta: ['adsmanager.facebook.com', 'business.facebook.com'], TikTok: ['ads.tiktok.com']};
const OUTCOMES = ['paused_verified', 'enabled_verified', 'unknown', 'failed_before_publish', 'blocked'];
const RESOLUTIONS = ['found_paused', 'found_enabled', 'not_found', 'still_unknown'];
const fail = (code, message) => {throw new ConnectorError(code, message);};
function id(value) {if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ID', '请使用工作区显示的任务编号。'); return value;}
function platform(value) {if (!BROWSER_PLATFORMS.includes(value)) fail('INVALID_PLATFORM', '请选择 Google、Meta 或 TikTok。'); return value;}
function plain(value) {return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;}
function fields(value, keys) {if (!plain(value) || Object.keys(value).some(k => !keys.includes(k))) fail('INVALID_INPUT', '记录包含不支持的字段，请按说明填写。'); return value;}
function text(value, max = 1000, allowEmpty = false) {if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail('INVALID_INPUT', '记录文字为空、过长或含不支持的字符。'); return value;}
function expiry(value) {if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_RESPONSE', '工作区未返回有效的任务期限。'); return value;}
function secret(value) {if (typeof value !== 'string' || !SECRET.test(value)) fail('INVALID_RESPONSE', '工作区未返回完整的任务凭据。'); return value;}
export function validatePlatformUrl(value, selectedPlatform) {
  platform(selectedPlatform); let url;
  try {url = new URL(value);} catch {fail('INVALID_PLATFORM_URL', '请填写当前广告后台页面的完整网址。');}
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !HOSTS[selectedPlatform].includes(url.hostname)) fail('INVALID_PLATFORM_URL', '页面网址与所选广告平台不一致。');
  if ([...url.searchParams.keys()].some(k => /^(?:access_token|refresh_token|token|password|session|authorization|code|api_key|secret)$/i.test(k)) || /(?:access_token|refresh_token|password|authorization)=/i.test(url.hash)) fail('INVALID_PLATFORM_URL', '后台网址不能包含登录密钥或临时授权码。');
  return url.href;
}
function evidenceIds(value) {if (!Array.isArray(value) || value.length > 30) fail('INVALID_INPUT', '请提供工作区保存的截图编号列表。'); return value.map(id);}
function objects(value, selectedPlatform) {
  if (!Array.isArray(value) || value.length > 50) fail('INVALID_INPUT', '请提供实际创建或查到的对象列表。');
  const seen = new Set();
  return value.map(item => {
    fields(item, ['level', 'id', 'parentId', 'status', 'url']);
    if (!['campaign', 'adGroup', 'ad'].includes(item.level) || !['paused', 'enabled', 'unknown'].includes(item.status)) fail('INVALID_INPUT', '请分别记录广告计划、广告组和广告的实际状态。');
    const remoteId = text(item.id, 200); if (!/^[A-Za-z0-9_.:-]+$/.test(remoteId) || seen.has(item.level + ':' + remoteId)) fail('INVALID_INPUT', '广告对象编号格式错误或重复。');
    seen.add(item.level + ':' + remoteId);
    const parentId = text(item.parentId ?? '', 200, true); if (parentId && !/^[A-Za-z0-9_.:-]+$/.test(parentId)) fail('INVALID_INPUT', '父级对象编号格式错误。');
    return {level: item.level, id: remoteId, parentId, status: item.status, url: validatePlatformUrl(item.url, selectedPlatform)};
  });
}
function observation(value, selectedPlatform) {
  fields(value, ['accountId', 'currency', 'timeZone', 'campaignType', 'parentCampaignId', 'canPublishPaused', 'pausedScopes', 'url', 'objects']);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(value.accountId || '') || !/^[A-Z]{3}$/.test(value.currency || '') || typeof value.canPublishPaused !== 'boolean' || !Array.isArray(value.pausedScopes) || value.pausedScopes.length > 3 || value.pausedScopes.some(x => !['campaign', 'adGroup', 'ad'].includes(x)) || new Set(value.pausedScopes).size !== value.pausedScopes.length) fail('INVALID_INPUT', '请核对账户编号、币种和能否以暂停状态提交。');
  let accountId = value.accountId;
  if (selectedPlatform === 'Google' && /^\d{3}-\d{3}-\d{4}$/.test(accountId)) accountId = accountId.replaceAll('-', '');
  if (selectedPlatform === 'Meta' && /^act_\d+$/.test(accountId)) accountId = accountId.slice(4);
  const parentCampaignId = text(value.parentCampaignId ?? '', 200, true); if (parentCampaignId && !/^[A-Za-z0-9_.:-]+$/.test(parentCampaignId)) fail('INVALID_INPUT', '父广告计划编号格式错误。');
  return {accountId, currency: value.currency, timeZone: text(value.timeZone, 100), campaignType: text(value.campaignType, 100), parentCampaignId, canPublishPaused: value.canPublishPaused, pausedScopes: value.pausedScopes, url: validatePlatformUrl(value.url, selectedPlatform), ...(value.objects === undefined ? {} : {objects: objects(value.objects, selectedPlatform)})};
}
// A server response can never turn a token or local path into public CLI output.
function publicValue(value, secrets = [], depth = 0) {
  if (depth > 30) fail('INVALID_RESPONSE', '工作区返回结构过深。');
  if (typeof value === 'string') return secrets.reduce((out, key) => key ? out.replaceAll(key, '[private]') : out, value);
  if (Array.isArray(value)) return value.map(v => publicValue(v, secrets, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|secret|password|authorization|cookie|base64|filePath|localPath)/i.test(key)).map(([key, v]) => [key, publicValue(v, secrets, depth + 1)]));
  return value;
}
const pickPublic = (data, keys, secrets) => publicValue(Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]])), secrets);

export function createBrowserTransport(server, token, {fetchImpl = fetch, timeoutMs = 15000} = {}) {
  const origin = normalizeServer(server);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) fail('INVALID_TOKEN', '本机工作区连接无效，请重新连接。');
  return async (path, body = {}, {binary = false} = {}) => {
    if (typeof path !== 'string' || !(path === '/api/runner/browser/claim' || /^\/api\/runner\/browser\/jobs\/[A-Za-z0-9_-]{1,100}\/(?:heartbeat|evidence|preflight|intent|checkpoint|result|reconcile|material)$/.test(path))) fail('INVALID_ROUTE', '浏览器任务请求地址不正确。');
    if (binary !== path.endsWith('/material')) fail('INVALID_ROUTE', '素材只能通过专用下载命令读取。');
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) fail('REQUEST_TOO_LARGE', '截图或记录过大，未发送。');
    let response;
    try {response = await fetchImpl(origin + path, {method: 'POST', redirect: 'manual', credentials: 'omit', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token}, body: payload, signal: AbortSignal.timeout(binary ? Math.max(120000, timeoutMs) : timeoutMs)});} catch {fail('NETWORK_ERROR', '暂时无法连接工作区。若已点击提交，请先核对广告后台，勿重复创建。');}
    if (response.status >= 300 && response.status < 400) {await response.body?.cancel().catch(() => {}); throw new ConnectorError('REDIRECT_BLOCKED', '工作区发生跳转，已停止发送凭据。请核对原地址。', response.status);}
    if (binary && response.ok) return response;
    const chunks = []; let size = 0;
    try {for await (const chunk of response.body || []) {size += chunk.length; if (size > 1024 * 1024) fail('RESPONSE_TOO_LARGE', '工作区返回内容过大。'); chunks.push(chunk);}} catch (error) {if (error instanceof ConnectorError) throw error; fail('NETWORK_ERROR', '工作区响应中断。若已提交广告，请先核对结果，勿重复创建。');}
    let data; try {data = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {fail('INVALID_RESPONSE', '工作区返回格式不正确。');}
    if (!response.ok) {
      const code = /^[A-Z0-9_]{1,80}$/.test(data?.error?.code || '') ? data.error.code : 'REQUEST_FAILED';
      const message = response.status === 401 ? '连接已失效，请重新连接。' : response.status === 403 ? '当前成员或电脑无权执行这个任务。' : [409, 410].includes(response.status) ? '任务、方案或确认已变化。请回到工作区核对；不要重复提交广告。' : response.status === 422 || response.status === 400 ? '记录尚不完整或与审核方案不一致，请核对后重试。' : '工作区暂时无法完成请求。若已提交广告，请先核对结果。';
      throw new ConnectorError(code, message, response.status);
    }
    if (!plain(data)) fail('INVALID_RESPONSE', '工作区返回格式不正确。');
    return data;
  };
}
async function readInputFile(path, limit) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('INVALID_FILE', '请提供已明确选择的本机文件完整路径。');
  try {const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail('INVALID_FILE', '文件不是普通文件或超过大小限制。'); const bytes = await readFile(path); if (bytes.length > limit) fail('INVALID_FILE', '文件超过大小限制。'); return bytes;} catch (error) {if (error instanceof ConnectorError) throw error; fail('INVALID_FILE', '无法读取所选文件，请核对文件是否存在。');}
}
async function jsonFile(path) {let data; try {data = JSON.parse((await readInputFile(path, MAX_JSON_BYTES)).toString('utf8'));} catch (error) {if (error instanceof ConnectorError) throw error; fail('INVALID_INPUT', '所选记录文件不是有效 JSON。');} if (!plain(data)) fail('INVALID_INPUT', '所选记录文件需要是 JSON 对象。'); return data;}


function materialDescriptors(snapshot) {
  const list = snapshot.selectionSnapshot?.materials;
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 50) fail('INVALID_JOB', '审核素材列表不正确。');
  return list.filter(m => m?.file).map(m => {
    if (!ID.test(m.id || '') || !Number.isSafeInteger(m.revision) || m.revision < 1 || !plain(m.file) || !/^[a-f0-9]{64}$/.test(m.file.sha256 || '') || !Number.isSafeInteger(m.file.size) || m.file.size < 1 || m.file.size > MAX_MATERIAL_BYTES || !Object.hasOwn(MATERIAL_MIMES, m.file.mime)) fail('INVALID_JOB', '审核素材缺少有效的版本、大小、类型或校验值。');
    return {id: m.id, revision: m.revision, file: {sha256: m.file.sha256, size: m.file.size, mime: m.file.mime}};
  });
}
async function verifiedCache(path, expected) {
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size) return false;
    const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== expected.sha256) return false;
    if (process.platform !== 'win32') await chmod(path, 0o600); return true;
  } catch (error) {if (error.code === 'ENOENT') return false; fail('INVALID_MATERIAL_CACHE', '本机素材缓存无法核对，请检查私有缓存目录。');}
}

export async function createBrowserBridge({stateDir = defaultStateDir(), server, fetchImpl, timeoutMs, now = Date.now} = {}) {
  const config = await loadConnector(stateDir, server), request = createBrowserTransport(config.server, config.token, {fetchImpl, timeoutMs});
  const directory = join(resolve(stateDir), 'browser-jobs');
  const secretValues = [config.token];
  async function lease(buildId, {allowExpired = false} = {}) {
    id(buildId); const state = await readPrivate(directory, buildId + '.json');
    if (!state || state.schemaVersion !== 1 || state.buildId !== buildId || state.server !== config.server || state.connectorId !== config.connectorId || !ID.test(state.jobId || '') || !SECRET.test(state.leaseToken || '') || !plain(state.intents) || !Array.isArray(state.platforms) || state.platforms.some(p => !BROWSER_PLATFORMS.includes(p)) || !Number.isFinite(Date.parse(state.expiresAt))) fail('NO_BROWSER_LEASE', '当前电脑尚未领取此任务，或记录属于另一工作区。请重新领取并核对。');
    if (!allowExpired && Date.parse(state.expiresAt) <= now()) fail('BROWSER_LEASE_EXPIRED', '任务期限已到，请重新领取同一任务并核对后台状态，勿重新创建。');
    return state;
  }
  const lockDirectory = buildId => join(directory, 'locks', id(buildId));
  async function lock(buildId, operation) {
    let release;
    try {release = await acquireRunnerLock(lockDirectory(buildId));}
    catch (error) {
      if (error.code === 'RUNNER_ALREADY_RUNNING') fail('BROWSER_COMMAND_BUSY', '此任务有另一个本机操作尚未结束，请等待后重试。');
      if (error.code === 'RUNNER_STALE_LOCK') fail('BROWSER_COMMAND_STALE', '上次本机命令未正常退出。确认旧命令已停止后，运行 unlock --build 清理记录；不会重建广告。');
      throw error;
    }
    try {return await operation();} finally {await release();}
  }
  function safe(data, state, keys = ['id', 'status', 'platform', 'stage', 'evidence', 'evidenceId', 'evidenceIds', 'expiresAt', 'objects', 'targets', 'message', 'resolution', 'outcome', 'instructions', 'allowed', 'scope', 'action', 'checkpoint']) {return pickPublic(data, keys, [...secretValues, state?.leaseToken, ...Object.values(state?.intents || {}).map(v => v?.token)]);}
  const route = (state, suffix) => `/api/runner/browser/jobs/${state.jobId}/${suffix}`;
  function selected(state, value) {platform(value); if (!state.platforms.includes(value)) fail('PLATFORM_NOT_IN_TASK', '此平台不在本次已审核任务中。'); return value;}
  return {
    async unlock(buildId) {return {id: id(buildId), cleared: await clearStaleRunnerLock(lockDirectory(buildId))};},
    async claim(buildId) {
      return lock(buildId, async () => {
        const data = await request('/api/runner/browser/claim', {buildId}), job = data.job;
        if (!plain(job) || !ID.test(job.id || '') || !['create_paused', 'enable'].includes(job.kind) || !Array.isArray(job.targets) || !job.targets.length || job.targets.length > 3 || !plain(job.snapshot)) fail('INVALID_JOB', '工作区返回的浏览器任务不完整。');
        const platforms = job.targets.map(t => platform(t.platform)); if (new Set(platforms).size !== platforms.length) fail('INVALID_JOB', '任务包含重复的平台。');
        const previous = await readPrivate(directory, buildId + '.json');
        const state = {schemaVersion: 1, server: config.server, connectorId: config.connectorId, buildId, jobId: id(job.id), leaseToken: secret(job.leaseToken), expiresAt: expiry(job.expiresAt), kind: job.kind, platforms, materials: materialDescriptors(job.snapshot), intents: {}, lastOutcomes: {}};
        if (previous?.server === state.server && previous?.connectorId === state.connectorId && previous?.jobId === state.jobId) {
          if (previous.leaseToken === state.leaseToken) {state.intents = previous.intents || {}; state.lastOutcomes = previous.lastOutcomes || {}; state.pendingReports = previous.pendingReports || {};}
          // An unacknowledged checkpoint may already be committed remotely. Keep
          // its exact scoped receipt across a lease renewal; never start again.
          state.pendingCheckpoints = previous.pendingCheckpoints || {};
          for (const p of Object.keys(state.pendingCheckpoints)) if (state.platforms.includes(p) && previous.intents?.[p]) state.intents[p] = previous.intents[p];
        }
        await writePrivate(directory, buildId + '.json', state);
        return safe(job, state, ['id', 'kind', 'parentBuildId', 'expiresAt', 'snapshot', 'targets', 'objects', 'instructions']);
      });
    },
    async heartbeat(buildId) {
      return lock(buildId, async () => {const state = await lease(buildId); const data = await request(route(state, 'heartbeat'), {leaseToken: state.leaseToken}); if (data.expiresAt) state.expiresAt = expiry(data.expiresAt); else if (data.job?.expiresAt) state.expiresAt = expiry(data.job.expiresAt); await writePrivate(directory, buildId + '.json', state); return safe(data, state);});
    },
    async evidence(buildId, options) {
      return lock(buildId, async () => {
        const state = await lease(buildId), p = selected(state, options.platform);
        if (!EVIDENCE_STAGES.includes(options.stage)) fail('INVALID_STAGE', '请选择当前步骤对应的截图用途。');
        const url = validatePlatformUrl(options.url, p), caption = text(options.note || '', 1000, true), bytes = await readInputFile(options.file, MAX_EVIDENCE_BYTES);
        const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        const jpeg = bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        if (!png && !jpeg) fail('INVALID_IMAGE', '请使用真实的 PNG 或 JPEG 截图文件。');
        const data = await request(route(state, 'evidence'), {leaseToken: state.leaseToken, platform: p, stage: options.stage, mime: png ? 'image/png' : 'image/jpeg', base64: bytes.toString('base64'), url, caption});
        return safe(data, state);
      });
    },
    async material(buildId, materialId, materialRevision) {
        const state = await lease(buildId); id(materialId);
        if (state.kind !== 'create_paused') fail('MATERIAL_SCOPE_MISMATCH', '启用任务不下载或重新上传素材。');
        if (!Number.isSafeInteger(materialRevision) || materialRevision < 1) fail('INVALID_MATERIAL_REVISION', '请选择审核方案中的素材版本。');
        const selectedMaterial = state.materials?.find(m => m.id === materialId && m.revision === materialRevision);
        if (!selectedMaterial) fail('MATERIAL_NOT_IN_TASK', '素材不属于本次已审核版本，或尚未上传可下载文件。');
        const file = selectedMaterial.file, cacheDir = join(resolve(stateDir), 'browser-assets');
        await mkdir(cacheDir, {recursive: true, mode: 0o700}); if (process.platform !== 'win32') await chmod(cacheDir, 0o700);
        const path = join(cacheDir, file.sha256 + '.' + MATERIAL_MIMES[file.mime]);
        if (await verifiedCache(path, file)) return {materialId, materialRevision, mime: file.mime, size: file.size, sha256: file.sha256, file: path, cached: true};
        const response = await request(route(state, 'material'), {leaseToken: state.leaseToken, materialId, materialRevision}, {binary: true});
        if ((response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() !== file.mime) {await response.body?.cancel().catch(() => {}); fail('MATERIAL_MISMATCH', '下载文件类型与已审核素材不一致，未保存。');}
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) !== file.size)) {await response.body?.cancel().catch(() => {}); fail('MATERIAL_MISMATCH', '下载文件大小与已审核素材不一致，未保存。');}
        const temp = join(cacheDir, '.pending-' + randomUUID()), hash = createHash('sha256'); let size = 0, handle;
        try {
          handle = await open(temp, 'wx', 0o600);
          for await (const chunk of response.body || []) {size += chunk.length; if (size > file.size || size > MAX_MATERIAL_BYTES) fail('MATERIAL_MISMATCH', '下载文件超过已审核大小，未保存。'); hash.update(chunk); await handle.writeFile(chunk);}
          if (size !== file.size || hash.digest('hex') !== file.sha256) fail('MATERIAL_MISMATCH', '下载文件校验失败，未保存。');
          await handle.sync(); await handle.close(); handle = null;
          await rename(temp, path); if (process.platform !== 'win32') await chmod(path, 0o600);
          return {materialId, materialRevision, mime: file.mime, size, sha256: file.sha256, file: path, cached: false};
        } catch (error) {if (error instanceof ConnectorError) throw error; fail('MATERIAL_DOWNLOAD_FAILED', '素材下载中断，未保存，请保留任务并重试下载。');}
        finally {if (handle) await handle.close().catch(() => {}); await rm(temp, {force: true}).catch(() => {});}
    },
    async preflight(buildId, p, input) {
      return lock(buildId, async () => {const state = await lease(buildId); selected(state, p); fields(input, ['observation', 'evidenceIds']); if (state.pendingCheckpoints?.[p]) fail('CHECKPOINT_PENDING', '上一步暂停对象的回填尚未确认，请先原样回填或核对，勿继续创建。'); if (state.kind === 'enable' && (!Array.isArray(input.observation?.objects) || !input.observation.objects.length)) fail('ENABLE_OBJECTS_REQUIRED', '启用前必须重新核对本次授权的已有对象编号和暂停状态。'); const data = await request(route(state, 'preflight'), {leaseToken: state.leaseToken, platform: p, observation: observation(input.observation, p), evidenceIds: evidenceIds(input.evidenceIds)}); return safe(data, state);});
    },
    async intent(buildId, p, action) {
      return lock(buildId, async () => {
        const state = await lease(buildId); selected(state, p); if (!['publish_paused', 'enable'].includes(action)) fail('INVALID_ACTION', '请选择暂停创建或单独确认后的启用。');
        if ((state.kind === 'create_paused' && action !== 'publish_paused') || (state.kind === 'enable' && action !== 'enable')) fail('WRONG_BROWSER_ACTION', '此任务不包含该操作；启用需要单独确认并领取启用任务。');
        if (state.pendingReports?.[p] || state.pendingCheckpoints?.[p] || state.lastOutcomes?.[p] === 'unknown') fail('RECONCILE_REQUIRED', '上次提交结果尚未确认，请先回填或核对后台，不能再次提交。');
        const data = await request(route(state, 'intent'), {leaseToken: state.leaseToken, platform: p, action});
        state.intents[p] = {token: secret(data.intentToken), expiresAt: expiry(data.expiresAt), action};
        await writePrivate(directory, buildId + '.json', state);
        return safe({...data, platform: p, action}, state);
      });
    },
    async checkpoint(buildId, p, input) {
      return lock(buildId, async () => {
        const state = await lease(buildId); selected(state, p); fields(input, ['objects', 'evidenceIds']);
        if (state.kind !== 'create_paused' || p !== 'Google') fail('CHECKPOINT_SCOPE_MISMATCH', '分步创建回填目前只适用于本次 Google 暂停搭建任务。');
        if (state.pendingReports?.[p] || state.lastOutcomes?.[p] === 'unknown') fail('RECONCILE_REQUIRED', '上次提交结果尚未确认，请先核对后台，不能覆盖回填记录。');
        const intent = state.intents[p];
        if (!intent || intent.action !== 'publish_paused') fail('NO_BROWSER_INTENT', '尚未取得本步暂停创建许可，不能记录已创建对象。');
        const observed = objects(input.objects, p), proof = evidenceIds(input.evidenceIds);
        if (!observed.length || observed.length > 3 || new Set(observed.map(o => o.level)).size !== observed.length || observed.some(o => o.status !== 'paused') || !proof.length) fail('INVALID_CHECKPOINT', '请提供本步实际创建并核对为暂停的对象编号和截图。');
        const payload = {leaseToken: state.leaseToken, platform: p, intentToken: secret(intent.token), objects: observed, evidenceIds: proof};
        state.pendingCheckpoints ||= {};
        const withoutLease = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'leaseToken'));
        if (state.pendingCheckpoints[p] && JSON.stringify(withoutLease(state.pendingCheckpoints[p])) !== JSON.stringify(withoutLease(payload))) fail('PENDING_CHECKPOINT_CHANGED', '上一步回填尚未确认，请原样重试该回填或核对后台，不能替换对象。');
        state.pendingCheckpoints[p] = payload; await writePrivate(directory, buildId + '.json', state);
        const data = await request(route(state, 'checkpoint'), payload), ack = data.checkpoint;
        if (!plain(ack) || ack.platform !== p || ack.status !== 'paused_partial' || ack.completed !== false || JSON.stringify(objects(ack.objects, p)) !== JSON.stringify(observed)) fail('INVALID_CHECKPOINT_ACK', '工作区没有确认本步暂停对象，保留回填记录；请先核对，勿继续创建。');
        const output = safe(data, state);
        delete state.pendingCheckpoints[p]; delete state.intents[p]; state.lastOutcomes ||= {}; state.lastOutcomes[p] = 'checkpoint_saved';
        await writePrivate(directory, buildId + '.json', state); return output;
      });
    },
    async result(buildId, p, input) {
      return lock(buildId, async () => {
        const state = await lease(buildId); selected(state, p); fields(input, ['outcome', 'objects', 'evidenceIds', 'message']);
        if (state.pendingCheckpoints?.[p]) fail('CHECKPOINT_PENDING', '上一步暂停对象的回填尚未确认，请先原样回填或核对，勿覆盖记录。');
        if (!OUTCOMES.includes(input.outcome)) fail('INVALID_OUTCOME', '请记录已核对的实际结果；不确定时选择 unknown。');
        const intent = state.intents[p];
        if (['paused_verified', 'enabled_verified'].includes(input.outcome) && !intent) fail('NO_BROWSER_INTENT', '尚未取得本次提交许可，不能回填已创建或启用。');
        if ((input.outcome === 'paused_verified' && intent?.action !== 'publish_paused') || (input.outcome === 'enabled_verified' && intent?.action !== 'enable')) fail('WRONG_BROWSER_INTENT', '回填结果与本次提交许可不一致。');
        const payload = {leaseToken: state.leaseToken, platform: p, ...(intent ? {intentToken: secret(intent.token)} : {}), outcome: input.outcome, objects: objects(input.objects, p), evidenceIds: evidenceIds(input.evidenceIds), message: text(input.message || '', 1000, true)};
        state.pendingReports ||= {};
        if (state.pendingReports[p] && JSON.stringify(state.pendingReports[p]) !== JSON.stringify(payload)) fail('PENDING_RESULT_CHANGED', '上次回填尚未确认，请先原样回填或核对后台，勿覆盖记录。');
        state.pendingReports[p] = payload; await writePrivate(directory, buildId + '.json', state);
        const data = await request(route(state, 'result'), payload);
        delete state.pendingReports[p]; state.lastOutcomes ||= {}; state.lastOutcomes[p] = input.outcome;
        await writePrivate(directory, buildId + '.json', state); return safe(data, state);
      });
    },
    async reconcile(buildId, p, input) {
      return lock(buildId, async () => {
        const state = await lease(buildId); selected(state, p); fields(input, ['resolution', 'objects', 'evidenceIds']);
        if (!RESOLUTIONS.includes(input.resolution)) fail('INVALID_RESOLUTION', '请记录重新打开广告后台后的核对结果。');
        const data = await request(route(state, 'reconcile'), {leaseToken: state.leaseToken, platform: p, resolution: input.resolution, objects: objects(input.objects, p), evidenceIds: evidenceIds(input.evidenceIds)});
        const platformStatus = data.item?.targets?.find(t => t.platform === p)?.status || data.status;
        if (input.resolution !== 'still_unknown' && platformStatus !== 'unknown') {delete state.intents[p]; delete state.pendingReports?.[p]; delete state.pendingCheckpoints?.[p]; state.lastOutcomes ||= {}; state.lastOutcomes[p] = input.resolution; await writePrivate(directory, buildId + '.json', state);}
        return safe(data, state);
      });
    }
  };
}

export const BROWSER_HELP = `浏览器投放任务桥接（不在命令行操作广告后台）
用法：node runner/browser-client.mjs <命令> --build <任务编号> [选项]
  claim                              读取本人已审核任务，私下保存任务凭据
  heartbeat                          续期；操作期间至少每 60 秒运行一次
  unlock                             仅清理已停止命令的本机运行记录，不触发广告操作
  material --material 素材编号 --revision 版本  下载并校验审核素材，复用私有缓存
  evidence --platform P --stage S --file /完整路径.png --url 后台网址 [--note 说明]
  preflight --platform P --file /完整路径.json
  intent --platform P --action publish_paused|enable
  checkpoint --platform Google --file /完整路径.json  保存本步暂停对象，继续前需重新预检
  result --platform P --file /完整路径.json
  reconcile --platform P --file /完整路径.json
P：Google、Meta、TikTok。S：preflight、before_publish、after_publish、before_enable、after_enable、reconcile。
通用选项：--state-dir 私有连接目录；--server 已连接的工作区地址。
广告页面由当前桌面 Codex 的浏览器工具操作。领取任务不代表已经创建广告。
启用必须先在网页单独确认。点击提交后不确定结果时，先核对，勿重复创建。`;
export function parseBrowserArgs(args) {
  if (!Array.isArray(args)) fail('INVALID_ARGUMENT', '命令参数格式不正确。');
  const command = args[0] || 'help'; if (['help', '--help', '-h'].includes(command)) return {command: 'help'};
  const commands = ['claim', 'heartbeat', 'unlock', 'material', 'evidence', 'preflight', 'intent', 'checkpoint', 'result', 'reconcile'];
  if (!commands.includes(command)) fail('INVALID_ARGUMENT', '命令不正确，请使用 help 查看用法。');
  const allowed = ['build', 'platform', 'stage', 'file', 'url', 'note', 'action', 'material', 'revision', 'state-dir', 'server'], values = {command};
  for (let n = 1; n < args.length; n += 2) {const key = args[n]; if (typeof key !== 'string' || !key.startsWith('--') || !allowed.includes(key.slice(2)) || values[key.slice(2)] !== undefined || typeof args[n + 1] !== 'string' || args[n + 1].startsWith('--')) fail('INVALID_ARGUMENT', '选项不正确、重复或缺少值，请使用 help 查看用法。'); values[key.slice(2)] = args[n + 1];}
  id(values.build);
  const required = {material: ['material', 'revision'], evidence: ['platform', 'stage', 'file', 'url'], preflight: ['platform', 'file'], intent: ['platform', 'action'], checkpoint: ['platform', 'file'], result: ['platform', 'file'], reconcile: ['platform', 'file']}[command] || [];
  if (required.some(k => values[k] === undefined)) fail('INVALID_ARGUMENT', '命令缺少必要选项，请使用 help 查看用法。');
  const applicable = new Set(['command', 'build', 'state-dir', 'server', ...required, ...(command === 'evidence' ? ['note'] : [])]);
  if (Object.keys(values).some(k => !applicable.has(k))) fail('INVALID_ARGUMENT', '此命令不支持指定选项，请使用 help 查看用法。');
  return values;
}
export async function runBrowserCommand(args, options = {}) {
  const parsed = parseBrowserArgs(args); if (parsed.command === 'help') return BROWSER_HELP;
  const bridge = await createBrowserBridge({...options, ...(parsed['state-dir'] ? {stateDir: parsed['state-dir']} : {}), ...(parsed.server ? {server: parsed.server} : {})});
  if (['claim', 'heartbeat', 'unlock'].includes(parsed.command)) return bridge[parsed.command](parsed.build);
  if (parsed.command === 'material') {if (!/^[1-9]\d{0,8}$/.test(parsed.revision)) fail('INVALID_MATERIAL_REVISION', '请选择审核方案中的素材版本。'); return bridge.material(parsed.build, parsed.material, Number(parsed.revision));}
  if (parsed.command === 'evidence') return bridge.evidence(parsed.build, parsed);
  if (parsed.command === 'intent') return bridge.intent(parsed.build, parsed.platform, parsed.action);
  return bridge[parsed.command](parsed.build, parsed.platform, await jsonFile(parsed.file));
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {const result = await runBrowserCommand(process.argv.slice(2)); process.stdout.write((typeof result === 'string' ? result : JSON.stringify(result, null, 2)) + '\n');}
  catch (error) {const safe = error instanceof ConnectorError ? {code: error.code, message: error.message} : {code: 'BROWSER_BRIDGE_FAILED', message: '本机任务桥接未完成，请保留记录并检查工作区。'}; process.stderr.write(JSON.stringify(safe) + '\n'); process.exitCode = 1;}
}
