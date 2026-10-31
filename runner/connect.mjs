// SPDX-License-Identifier: MIT
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ConnectorError, VERSION, normalizeServer, createClient, readPrivate, writePrivate, removePrivate, defaultStateDir, acquireRunnerLock, clearStaleRunnerLock} from './client.mjs';
import {detectCodex, runCodexGeneration, defaultBinary} from './codex.mjs';

const TERMINAL_HTTP = new Set([400, 401, 403, 404, 409, 410, 422]);
const safeName = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100 && !/[\u0000-\u001f]/.test(value);
const safeIdentifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const briefStatus = status => ({available: Boolean(status.available), authenticated: Boolean(status.authenticated), compatible: Boolean(status.compatible), version: status.version || ''});

export async function pairConnector({server, code, deviceName = '我的 Codex 电脑', stateDir = defaultStateDir(), clientFactory = createClient}) {
  const origin = normalizeServer(server);
  if (typeof code !== 'string' || !/^[a-zA-Z0-9_-]{6,128}$/.test(code.trim())) throw new ConnectorError('INVALID_PAIRING_CODE', '请在网页中创建连接码，并在本机终端输入。');
  if (!safeName(deviceName) || deviceName.length > 80) throw new ConnectorError('INVALID_DEVICE_NAME', '电脑名称需要 1 至 80 个字符。');
  const previous = await readPrivate(stateDir, 'connector.json');
  if (previous) throw new ConnectorError('ALREADY_PAIRED', '当前目录已有连接。请先在网页撤销旧连接，再使用 --forget 清除本机记录，或指定另一个私有目录。');
  const result = await clientFactory(origin)('/api/connectors/exchange', {code: code.trim(), deviceName: deviceName.trim()});
  if (normalizeServer(result.server) !== origin || !safeIdentifier(result.connectorId) || !safeIdentifier(result.owner?.id) || !safeIdentifier(result.team?.id) || typeof result.token !== 'string' || !/^[a-zA-Z0-9_-]{32,256}$/.test(result.token)) throw new ConnectorError('INVALID_PAIRING_RESPONSE', '工作区返回的连接身份不完整，本机未保存凭据。');
  const config = {schemaVersion: 1, server: origin, connectorId: result.connectorId, token: result.token, owner: {id: result.owner.id, name: safeName(result.owner.name) ? result.owner.name : '工作区成员'}, team: {id: result.team.id, name: safeName(result.team.name) ? result.team.name : '团队'}, deviceName: deviceName.trim(), createdAt: new Date().toISOString()};
  await writePrivate(stateDir, 'connector.json', config);
  return {connectorId: config.connectorId, server: origin, owner: config.owner, team: config.team, deviceName: config.deviceName};
}
export async function loadConnector(stateDir = defaultStateDir(), server) {
  const config = await readPrivate(stateDir, 'connector.json');
  if (!config || config.schemaVersion !== 1 || !safeIdentifier(config.connectorId) || !safeIdentifier(config.owner?.id) || !safeIdentifier(config.team?.id) || typeof config.token !== 'string') throw new ConnectorError('NOT_PAIRED', '请先使用网页连接码连接这台电脑。');
  config.server = normalizeServer(config.server);
  if (server && normalizeServer(server) !== config.server) throw new ConnectorError('SERVER_MISMATCH', '指定地址与已保存的工作区不同，已阻止发送凭据。请使用独立的私有目录。');
  return config;
}
export async function runConnector(options = {}) {
  const stateDir = options.stateDir || defaultStateDir();
  const release = await acquireRunnerLock(stateDir);
  try {return await runConnected({...options, stateDir});} finally {await release();}
}
async function runConnected({server, stateDir = defaultStateDir(), binary = defaultBinary(), once = false, pollMs = 5000, heartbeatMs = 15000, signal, onStatus = () => {}, clientFactory = createClient, detect = detectCodex, generate = runCodexGeneration, sleep = delay} = {}) {
  const emit = (status, message, detail = {}) => {try {onStatus({status, message, ...detail});} catch { /* Logging must not change task semantics. */ }};
  const config = await loadConnector(stateDir, server), client = clientFactory(config.server, config.token);
  let codex = await detect({binary}), lastProbe = Date.now(), lastError = null;
  let terminalJobs = 0;
  async function pause(ms) {try {await sleep(Math.max(100, ms), undefined, {signal});} catch {if (!signal?.aborted) throw new ConnectorError('WAIT_FAILED', '连接器等待失败。');}}
  async function acknowledge(outbox) {
    if (outbox.connectorId !== config.connectorId || outbox.server !== config.server || !safeIdentifier(outbox.jobId) || typeof outbox.leaseToken !== 'string' || !['result', 'failure'].includes(outbox.kind)) throw new ConnectorError('INVALID_OUTBOX', '本机待回填记录不属于当前连接。请保留记录并检查连接目录。');
    try {
      const response = await client(`/api/runner/jobs/${outbox.jobId}/${outbox.kind}`, {leaseToken: outbox.leaseToken, ...(outbox.kind === 'result' ? {result: outbox.result} : {code: outbox.code, message: outbox.message})}, {signal});
      const expectedStatus = outbox.kind === 'result' ? 'succeeded' : 'failed';
      if (response.status !== expectedStatus) {
        if (!['stale', 'cancelled', 'needs_attention', 'failed'].includes(response.status)) throw new ConnectorError('INVALID_RESPONSE', '任务结果尚未得到明确确认。');
        await writePrivate(stateDir, 'last-rejected.json', {...outbox, rejectedAt: new Date().toISOString(), reason: response.status});
        await removePrivate(stateDir, 'outbox.json');
        emit('not_applied', '任务或方案版本已变化；生成结果没有覆盖方案。', {jobId: outbox.jobId, outcome: response.status});
        terminalJobs++; return true;
      }
      await removePrivate(stateDir, 'outbox.json');
      emit('acknowledged', outbox.kind === 'result' ? '结果已回填工作区，等待人工审核。' : '任务失败状态已保存，请在网页查看并处理。', {jobId: outbox.jobId, outcome: response.status || 'acknowledged'});
      terminalJobs++; return true;
    } catch (error) {
      if (TERMINAL_HTTP.has(error.status)) {
        // Keep the rejected payload privately for local inspection, but never
        // resubmit it against another lease, job, account or proposal revision.
        await writePrivate(stateDir, 'last-rejected.json', {...outbox, rejectedAt: new Date().toISOString(), reason: error.code});
        await removePrivate(stateDir, 'outbox.json');
        emit('not_applied', '任务已取消、连接已撤销或版本已变化；结果未覆盖方案。', {jobId: outbox.jobId, code: error.code});
        if (error.status === 401 || error.status === 403) throw error;
        terminalJobs++; return true;
      }
      throw error;
    }
  }
  emit('starting', '连接器已启动，只处理本人提交的策略与文案任务。');
  while (!signal?.aborted) {
    try {
      const pending = await readPrivate(stateDir, 'outbox.json');
      if (pending) {
        emit('retrying_result', '发现待回填结果，先确认上次提交，不会重新生成。');
        await acknowledge(pending);
        if (once && terminalJobs) return {terminalJobs};
      }
      if (Date.now() - lastProbe >= 60000) {codex = await detect({binary}); lastProbe = Date.now();}
      const heartbeat = await client('/api/runner/heartbeat', {version: VERSION, codex: briefStatus(codex)}, {signal});
      const status = heartbeat.status || heartbeat.connector?.status;
      if (status === 'pending') {emit('pending', '请回到网页核对这台电脑，并点击确认连接。'); await pause(pollMs); continue;}
      if (status && status !== 'active') throw new ConnectorError('CONNECTOR_INACTIVE', '此连接不可用，请在网页检查。', 403);
      if (!codex.available || !codex.authenticated || !codex.compatible) {
        const code = !codex.available ? 'CODEX_NOT_FOUND' : !codex.authenticated ? 'CODEX_NOT_AUTHENTICATED' : 'CODEX_UNSUPPORTED';
        emit('needs_attention', code === 'CODEX_NOT_AUTHENTICATED' ? '请在本机登录 Codex；登录凭据不会发送给投放平台。' : '请在本机安装或更新支持受限生成的 Codex CLI。', {code});
        if (once) throw new ConnectorError(code, '本机 Codex 尚未就绪，请先完成安装或登录。');
        await pause(pollMs); continue;
      }
      if (heartbeat.ready === false) {emit('waiting', '工作区尚未允许领取任务，请检查网页中的连接状态。'); await pause(pollMs); continue;}
      const claim = await client('/api/runner/claim', {}, {signal}), job = claim.job;
      if (!job) {emit('idle', '已连接，等待本人提交的生成任务。'); await pause(pollMs); continue;}
      if (!safeIdentifier(job.id) || typeof job.leaseToken !== 'string' || job.leaseToken.length < 24 || job.leaseToken.length > 256) throw new ConnectorError('INVALID_JOB', '工作区返回的任务身份不完整。');
      emit('generating', '正在调用这台电脑上的 Codex 生成策略与文案。', {jobId: job.id});
      const active = new AbortController();
      const interrupted = () => active.abort(); signal?.addEventListener('abort', interrupted, {once: true});
      let heartbeatBusy = false, leaseLost = false;
      const renew = setInterval(async () => {
        if (heartbeatBusy || active.signal.aborted) return;
        heartbeatBusy = true;
        try {
          await client('/api/runner/heartbeat', {version: VERSION, codex: briefStatus(codex)}, {signal: active.signal});
          await client(`/api/runner/jobs/${job.id}/heartbeat`, {leaseToken: job.leaseToken}, {signal: active.signal});
        } catch (error) {
          // No confirmed renewal means the result cannot safely be submitted.
          // Stop early even for a network interruption; the server can expose a
          // controlled retry rather than let a stale generator continue working.
          leaseLost = true; active.abort(); emit('lease_lost', '任务连接中断或已取消，正在停止本机生成。', {jobId: job.id, code: error.code});
        } finally {heartbeatBusy = false;}
      }, Math.max(1000, heartbeatMs));
      let outbox;
      try {
        const result = await generate(job, {binary, capabilities: codex, signal: active.signal});
        if (active.signal.aborted || leaseLost || signal?.aborted) throw new ConnectorError('STOPPED', '生成已停止。');
        outbox = {kind: 'result', result};
      } catch (error) {
        outbox = {kind: 'failure', code: error instanceof ConnectorError ? error.code : 'CODEX_GENERATION_FAILED', message: error instanceof ConnectorError ? error.message : '本机生成未完成，请检查 Codex 状态后重试。'};
      } finally {clearInterval(renew); signal?.removeEventListener('abort', interrupted);}
      outbox = {...outbox, schemaVersion: 1, connectorId: config.connectorId, server: config.server, jobId: job.id, leaseToken: job.leaseToken, createdAt: new Date().toISOString()};
      await writePrivate(stateDir, 'outbox.json', outbox);
      if (signal?.aborted) {emit('stopped', '本机生成已停止，待确认状态保存在私有目录。'); return {terminalJobs};}
      await acknowledge(outbox);
      if (once && terminalJobs) return {terminalJobs};
      lastError = null;
    } catch (error) {
      if (signal?.aborted || error.code === 'STOPPED') break;
      if ([401, 403].includes(error.status) || ['INVALID_OUTBOX', 'INVALID_JOB', 'REDIRECT_BLOCKED', 'SERVER_MISMATCH', 'CODEX_NOT_FOUND', 'CODEX_NOT_AUTHENTICATED', 'CODEX_UNSUPPORTED'].includes(error.code)) throw error;
      if (lastError !== error.code) emit('offline', '暂时无法完成工作区请求，已保留本机待回填记录。', {code: error.code || 'REQUEST_FAILED'});
      lastError = error.code;
      await pause(Math.max(pollMs, 5000));
    }
  }
  emit('stopped', '连接器已停止。'); return {terminalJobs};
}

const HELP = `广告工作区 Codex 连接器\n\n首次连接：node runner/connect.mjs --server https://your-workspace.example\n本机检查：node runner/connect.mjs --check\n运行一次任务：node runner/connect.mjs --once\n\n可选：--state-dir 私有目录、--codex 本机可执行文件、--device-name 电脑名称\n--forget 只清除本机连接记录，请先在网页撤销旧连接。\n--clear-stale-lock 仅在旧进程已退出后，明确清理残留运行记录。\n配对码在终端提示后输入，不放入命令参数。Ctrl+C 停止。\n`;
export async function main(args = process.argv.slice(2)) {
  const options = {}, switches = new Set(['--once', '--check', '--forget', '--clear-stale-lock', '--help', '-h']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (switches.has(flag)) {options[flag] = true; continue;}
    if (!['--server', '--state-dir', '--codex', '--device-name'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new ConnectorError('INVALID_ARGUMENT', '命令参数不正确，请使用 --help 查看说明。');
    options[flag] = args[++i];
  }
  if (options['--help'] || options['-h']) {process.stdout.write(HELP); return;}
  const stateDir = resolve(options['--state-dir'] || defaultStateDir()), binary = options['--codex'] || defaultBinary();
  if (options['--clear-stale-lock']) {
    const removed = await clearStaleRunnerLock(stateDir);
    process.stdout.write(removed ? '已清理退出进程留下的运行记录。请重新启动连接器。\n' : '当前没有残留运行记录。\n'); return;
  }
  if (options['--check']) {
    const status = await detectCodex({binary});
    process.stdout.write(!status.available ? '未找到 Codex CLI。\n' : !status.authenticated ? '已找到 Codex CLI，请先在本机登录。\n' : !status.compatible ? 'Codex 已登录，但需要更新以支持受限生成。\n' : `Codex ${status.version} 已登录，可用于受限生成。\n`); return;
  }
  if (options['--forget']) {
    const release = await acquireRunnerLock(stateDir);
    try {for (const name of ['connector.json', 'outbox.json', 'last-rejected.json']) await removePrivate(stateDir, name);} finally {await release();}
    process.stdout.write('本机连接记录已清除。工作区中的连接需另行撤销。\n'); return;
  }
  let config = await readPrivate(stateDir, 'connector.json');
  if (!config) {
    if (!options['--server']) throw new ConnectorError('SERVER_REQUIRED', '首次连接需要 --server 工作区地址。');
    const input = createInterface({input: process.stdin, output: process.stdout});
    let code;
    try {code = await input.question('请粘贴网页显示的一次性连接码：');} finally {input.close();}
    const paired = await pairConnector({server: options['--server'], code, deviceName: options['--device-name'] || '我的 Codex 电脑', stateDir});
    process.stdout.write(`连接已登记：${paired.team.name} / ${paired.owner.name}。请回到网页核对并确认连接。\n`);
  }
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let lastMessage = '';
  try {
    return await runConnector({server: options['--server'], stateDir, binary, once: Boolean(options['--once']), signal: controller.signal, onStatus: event => {if (event.message !== lastMessage) {lastMessage = event.message; process.stdout.write(event.message + '\n');}}});
  } finally {process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {process.stderr.write((error instanceof ConnectorError ? error.message : '连接器未完成操作，请检查本机状态。') + '\n'); process.exitCode = 1;});
}
