// SPDX-License-Identifier: MIT
import {mkdir, open, readFile, rename, rm, chmod, stat, lstat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';

export const VERSION = '0.5.0';
export const defaultStateDir = () => join(homedir(), '.ad-growth-console');
export class ConnectorError extends Error {
  constructor(code, message, status = 0) { super(message); Object.assign(this, {code, status}); }
}
export function normalizeServer(value) {
  let url;
  try {url = new URL(value);} catch {throw new ConnectorError('INVALID_SERVER', '请填写完整的工作区地址。');}
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) throw new ConnectorError('INVALID_SERVER', '工作区必须使用 HTTPS；本机开发地址可使用 HTTP。请勿填写路径、账号或密码。');
  return url.origin;
}
export async function readPrivate(stateDir, name) {
  const path = join(resolve(stateDir), name);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 512 * 1024) throw new ConnectorError('INVALID_LOCAL_STATE', '连接器本地记录无效，请重新连接。');
    if (process.platform !== 'win32' && info.mode & 0o077) await chmod(path, 0o600);
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError('INVALID_LOCAL_STATE', '连接器本地记录无法读取，请重新连接。');
  }
}
export async function writePrivate(stateDir, name, value) {
  const directory = resolve(stateDir);
  await mkdir(directory, {recursive: true, mode: 0o700});
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const path = join(directory, name), temp = join(directory, `.pending-${randomUUID()}`);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > 512 * 1024) throw new ConnectorError('LOCAL_STATE_TOO_LARGE', '连接器记录过大，未保存。');
  const file = await open(temp, 'wx', 0o600);
  try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}
  try {await rename(temp, path);} finally {await rm(temp, {force: true}).catch(() => {});}
  if (process.platform !== 'win32') await chmod(path, 0o600);
}
export const removePrivate = (stateDir, name) => rm(join(resolve(stateDir), name), {force: true});
function processAlive(pid) {
  try {process.kill(pid, 0); return true;} catch (error) {return error.code !== 'ESRCH';}
}
async function readLock(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw new ConnectorError('RUNNER_LOCK_INVALID', '连接器运行记录无法核对，请保留记录并检查原窗口。');
  let value;
  try {value = JSON.parse(await readFile(path, 'utf8'));} catch {throw new ConnectorError('RUNNER_LOCK_INVALID', '连接器运行记录尚未完整，请检查原窗口或稍后再试。');}
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(value.token)) throw new ConnectorError('RUNNER_LOCK_INVALID', '连接器运行记录无法核对，请保留记录并检查原窗口。');
  return value;
}
async function assertNoRecovery(directory) {
  try {await lstat(join(directory, '.runner-recovery.lock'));} catch (error) {if (error.code === 'ENOENT') return; throw error;}
  throw new ConnectorError('RUNNER_RECOVERY_IN_PROGRESS', '连接器运行记录正在清理，请等待原窗口处理完成。');
}
export async function acquireRunnerLock(stateDir, {probePid = processAlive} = {}) {
  const directory = resolve(stateDir), path = join(directory, 'runner.lock');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await assertNoRecovery(directory);
  const ownership = {pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString()};
  let file;
  try {file = await open(path, 'wx', 0o600);} catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const current = await readLock(path);
    if (probePid(current.pid)) throw new ConnectorError('RUNNER_ALREADY_RUNNING', '连接器已在运行，请回到原窗口。');
    // A stale PID is detected but never cleared automatically. An explicit local
    // recovery command is required; no process is signalled or terminated here.
    throw new ConnectorError('RUNNER_STALE_LOCK', '上次连接器未正常退出。确认旧窗口已停止后，使用 --clear-stale-lock 清理运行记录。');
  }
  try {await file.writeFile(JSON.stringify(ownership)); await file.sync();} catch (error) {await file.close(); await rm(path, {force: true}); throw error;}
  await file.close();
  const release = async () => {
    try {
      const current = await readLock(path);
      // Only the process holding this exact lock may release it.
      if (current.pid === ownership.pid && current.token === ownership.token) await rm(path);
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  };
  try {await assertNoRecovery(directory);} catch (error) {await release(); throw error;}
  return release;
}
export async function clearStaleRunnerLock(stateDir, {probePid = processAlive} = {}) {
  const directory = resolve(stateDir), path = join(directory, 'runner.lock'), recoveryPath = join(directory, '.runner-recovery.lock');
  await mkdir(directory, {recursive: true, mode: 0o700});
  const ownership = {pid: process.pid, token: randomUUID()};
  let guard;
  try {guard = await open(recoveryPath, 'wx', 0o600);} catch (error) {if (error.code === 'EEXIST') throw new ConnectorError('RUNNER_RECOVERY_IN_PROGRESS', '另一个运行记录清理操作尚未结束，请检查原窗口。'); throw error;}
  try {
    await guard.writeFile(JSON.stringify(ownership)); await guard.sync(); await guard.close(); guard = null;
    let current;
    try {current = await readLock(path);} catch (error) {if (error.code === 'ENOENT') return false; throw error;}
    if (probePid(current.pid)) throw new ConnectorError('RUNNER_ALREADY_RUNNING', '连接器已在运行，请回到原窗口。');
    // The recovery guard serializes explicit cleanup and excludes a new worker
    // from acquiring the freed path while this operation is still in progress.
    const checked = await readLock(path);
    if (checked.pid !== current.pid || checked.token !== current.token || probePid(checked.pid)) throw new ConnectorError('RUNNER_LOCK_CHANGED', '运行记录刚刚发生变化，请检查原窗口。');
    await rm(path); return true;
  } finally {
    if (guard) await guard.close().catch(() => {});
    try {const current = await readLock(recoveryPath); if (current.pid === ownership.pid && current.token === ownership.token) await rm(recoveryPath);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
}
export function createClient(server, token, {fetchImpl = fetch, timeoutMs = 15000} = {}) {
  const origin = normalizeServer(server);
  if (token !== undefined && (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token))) throw new ConnectorError('INVALID_TOKEN', '本地工作区凭据无效，请重新连接。');
  return async (path, body = {}, {signal} = {}) => {
    if (typeof path !== 'string' || !/^\/api\/(?:runner|connectors)\/[a-zA-Z0-9/-]+$/.test(path)) throw new ConnectorError('INVALID_ROUTE', '连接器请求地址不正确。');
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload) > 256 * 1024) throw new ConnectorError('REQUEST_TOO_LARGE', '生成结果过大，未发送。');
    const deadline = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(origin + path, {method: 'POST', redirect: 'manual', credentials: 'omit', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: payload, signal: signal ? AbortSignal.any([signal, deadline]) : deadline});
    } catch {
      if (signal?.aborted) throw new ConnectorError('STOPPED', '连接器已停止。');
      throw new ConnectorError('NETWORK_ERROR', '暂时无法连接工作区，结果会保留并稍后重试。');
    }
    if (response.status >= 300 && response.status < 400) {await response.body?.cancel().catch(() => {}); throw new ConnectorError('REDIRECT_BLOCKED', '工作区发生跳转，连接器已停止发送凭据。请核对原地址。', response.status);}
    let total = 0; const chunks = [];
    try {
      for await (const part of response.body || []) {
        total += part.length;
        if (total > 512 * 1024) throw new ConnectorError('RESPONSE_TOO_LARGE', '工作区返回内容过大。');
        chunks.push(part);
      }
    } catch (error) {if (error instanceof ConnectorError) throw error; throw new ConnectorError('NETWORK_ERROR', '工作区响应中断，结果会保留并稍后重试。');}
    let data;
    try {data = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {throw new ConnectorError('INVALID_RESPONSE', '工作区返回格式不正确。', response.status);}
    if (!response.ok) {
      const code = typeof data.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(data.error.code) ? data.error.code : 'REQUEST_FAILED';
      // Never print arbitrary server messages, which can contain a token or prompt.
      const message = response.status === 401 ? '连接已失效或已撤销，请重新连接。' : response.status === 403 ? '工作区尚未确认连接，或当前成员权限已变化。' : response.status === 409 || response.status === 410 ? '任务状态或方案版本已变化，本次结果未覆盖方案。' : '工作区暂时未完成请求，请稍后重试。';
      throw new ConnectorError(code, message, response.status);
    }
    return data;
  };
}
