// SPDX-License-Identifier: MIT
// The server stores only hashes of application-scoped device/lease tokens.
// Personal Codex authentication never leaves the connector computer.
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {ensure, AppError} from './errors.mjs';
import {fields, text, revision} from './validation.mjs';
import {tokenHash} from './store.mjs';

const EDIT = ['admin', 'editor'];
const PAIR_MS = 5 * 60000, ONLINE_MS = 45000, LEASE_MS = 60000;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ERROR_MESSAGES = {
  CODEX_NOT_FOUND: '这台电脑尚未找到 Codex，请先安装或指定 Codex 程序。',
  CODEX_NOT_AUTHENTICATED: '这台电脑的 Codex 尚未登录，请本人完成登录。',
  CODEX_FAILED: 'Codex 未完成本次生成，请在连接器电脑检查后重试。',
  CODEX_GENERATION_FAILED: 'Codex 未完成本次生成，请在连接器电脑检查后重试。',
  CODEX_UNSUPPORTED: '请更新这台电脑上的 Codex 后重新连接。',
  UNEXPECTED_TOOL_ACTIVITY: 'Codex 请求了文案生成以外的工具，连接器已停止本次任务。',
  STOPPED: '本机生成已停止，原文案保留。',
  INVALID_GENERATION_RESULT: 'Codex 返回内容未通过格式检查，请重新生成或使用手动交接。',
  CODEX_TIMEOUT: '本次生成超时，原文案保留，请检查后再试。',
  INVALID_OUTPUT: 'Codex 返回内容未通过格式检查，请重新生成或使用手动交接。',
  TOOL_USE_BLOCKED: '生成过程请求了此任务不允许的工具，已停止本次生成。',
  INTERRUPTED: '本次生成已中断，原文案保留。',
  RESULT_DELIVERY_FAILED: '生成结果尚未确认保存，请在连接器电脑核对。',
};
export function createConnectors({store, planning, baseURL, clock = Date.now}) {
  const db = store.db;
  const stamp = () => new Date(clock()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_connector_pairing (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), owner_id TEXT NOT NULL REFERENCES user(id),
      code_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_connector (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), owner_id TEXT NOT NULL REFERENCES user(id),
      name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN('pending','active','revoked')),
      last_seen INTEGER, diagnostic_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, confirmed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS app_connector_owner ON app_connector(team_id,owner_id,status);
    CREATE TABLE IF NOT EXISTS app_generation_job (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), owner_id TEXT NOT NULL REFERENCES user(id),
      connector_id TEXT NOT NULL REFERENCES app_connector(id), proposal_id TEXT NOT NULL REFERENCES app_proposal(id),
      proposal_revision INTEGER NOT NULL, generation_id TEXT NOT NULL, prompt TEXT NOT NULL, schema_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('queued','running','succeeded','failed','cancelled','stale','needs_attention')),
      lease_hash TEXT, lease_expires INTEGER, attempt INTEGER NOT NULL DEFAULT 0, result_hash TEXT, result_revision INTEGER,
      error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_generation_active ON app_generation_job(proposal_id) WHERE status IN('queued','running');
  `);
  function actor(member) { ensure(member?.user_id, 403, 'RUNNER_FORBIDDEN', '此账号已失去团队访问权限。'); return store.actor(member, EDIT); }
  function rawConnector(id) { return db.prepare('SELECT * FROM app_connector WHERE id=?').get(id); }
  function publicConnector(row) {
    const diagnostic = JSON.parse(row.diagnostic_json);
    const online = row.last_seen !== null && row.last_seen >= clock() - ONLINE_MS;
    return {id: row.id, name: row.name, status: row.status, online, ready: row.status === 'active' && online && diagnostic.codex?.available === true && diagnostic.codex?.authenticated === true && diagnostic.codex?.compatible !== false, lastSeenAt: row.last_seen ? new Date(row.last_seen).toISOString() : null, codex: diagnostic.codex || {available: false, authenticated: false, version: ''}, version: diagnostic.version || '', createdAt: row.created_at, confirmedAt: row.confirmed_at};
  }
  function ownedConnector(member, id) {
    const row = rawConnector(id);
    ensure(row && row.team_id === member.team_id && row.owner_id === member.user_id, 404, 'CONNECTOR_NOT_FOUND', '没有找到属于你的 Codex 连接。');
    return row;
  }
  function rawJob(id) {
    const row = db.prepare('SELECT * FROM app_generation_job WHERE id=?').get(id);
    ensure(row, 404, 'JOB_NOT_FOUND', '没有找到该生成任务。');
    return row;
  }
  function publicJob(row) {
    const owner = db.prepare('SELECT name FROM user WHERE id=?').get(row.owner_id);
    const connector = rawConnector(row.connector_id);
    return {id: row.id, proposalId: row.proposal_id, proposalRevision: row.proposal_revision, generationId: row.generation_id, connectorId: row.connector_id, deviceName: connector?.name || '连接器', owner: {id: row.owner_id, name: owner?.name || '成员'}, status: row.status, attempt: row.attempt, error: row.error_code ? {code: row.error_code, message: ERROR_MESSAGES[row.error_code] || ({LEASE_EXPIRED: '连接器失去响应，请核对后主动重新生成。', PROPOSAL_CHANGED: '方案或所选资源已变化，结果没有覆盖新内容。', CONNECTOR_REVOKED: '该 Codex 连接已断开。'})[row.error_code] || '生成任务未完成，请核对后再试。'} : null, resultRevision: row.result_revision, createdAt: row.created_at, updatedAt: row.updated_at};
  }
  function expire(inTransaction = false) {
    const work = () => {
      for (const row of db.prepare("SELECT * FROM app_generation_job WHERE status='running' AND lease_expires<?").all(clock())) changeJob(row, 'needs_attention', 'LEASE_EXPIRED', true);
      db.prepare('DELETE FROM app_connector_pairing WHERE expires_at<?').run(clock() - 86400000);
    };
    if (inTransaction) work(); else store.transaction(work);
  }
  function staleReason(row) {
    const item = store.proposal(row.team_id, row.proposal_id);
    if (item.status === 'archived' || item.revision !== row.proposal_revision || item.workflow?.generation?.id !== row.generation_id) return true;
    return !planning.isGenerationCurrent(store.membership(row.owner_id), row.proposal_id, row.generation_id);
  }
  function changeJob(row, status, errorCode = null, automatic = false) {
    db.prepare('UPDATE app_generation_job SET status=?,error_code=?,updated_at=? WHERE id=?').run(status, errorCode, stamp(), row.id);
    store.audit(row.team_id, row.owner_id, 'generation.' + status, row.proposal_id, null, {jobId: row.id, connectorId: row.connector_id, ...(automatic ? {automatic: true, reason: 'lease_expired'} : {})});
  }
  function bearer(req) {
    ensure(!req.headers.cookie, 403, 'RUNNER_COOKIE_FORBIDDEN', '连接器接口不接受浏览器登录信息。');
    const match = /^Bearer ([a-zA-Z0-9_-]{40,100})$/.exec(req.headers.authorization || '');
    ensure(match, 401, 'RUNNER_UNAUTHENTICATED', '请重新连接你的 Codex。');
    const row = db.prepare('SELECT * FROM app_connector WHERE token_hash=?').get(tokenHash(match[1]));
    ensure(row && row.status !== 'revoked', 401, 'CONNECTOR_REVOKED', '此 Codex 连接已断开，请重新连接。');
    const member = store.membership(row.owner_id);
    ensure(member && member.team_id === row.team_id, 403, 'RUNNER_FORBIDDEN', '此连接不再属于可访问的团队。');
    actor(member);
    return {connector: row, member};
  }
  function checkLease(row, connector, token, terminalAllowed = false) {
    ensure(row.connector_id === connector.id && row.owner_id === connector.owner_id && row.team_id === connector.team_id, 404, 'JOB_NOT_FOUND', '没有找到属于此连接器的生成任务。');
    ensure(typeof token === 'string' && token.length >= 40 && token.length <= 100 && row.lease_hash === tokenHash(token), 403, 'INVALID_LEASE', '本次任务领取凭证无效。');
    if (terminalAllowed && row.status === 'succeeded') return;
    ensure(row.status === 'running' && row.lease_expires >= clock(), 409, 'JOB_NOT_RUNNING', '本次任务已结束、过期或取消，请核对平台状态。');
  }
  // Only these paths allow application-scoped bearer authentication. It cannot
  // be substituted for a member cookie on the normal team/resource APIs.
  function isRunnerPath(path) { return path === '/api/connectors/exchange' || path.startsWith('/api/runner/'); }
  async function publicHandle(req, res, url, {body, json}) {
    const path = url.pathname;
    if (!isRunnerPath(path)) return false;
    ensure(req.method === 'POST', 405, 'METHOD_NOT_ALLOWED', '连接器请使用指定的提交方式。');
    if (path === '/api/connectors/exchange') {
      ensure(!req.headers.cookie && !req.headers.authorization, 403, 'PAIRING_AUTH_INVALID', '连接时请勿附带其他登录信息。');
      store.consumeLimit('pair-exchange:' + req.socket.remoteAddress, 15, 60000);
      const input = fields(await body(req), ['code', 'deviceName']);
      const code = text(input.code, '连接码', 64, true).replace(/-/g, '').toUpperCase();
      ensure(/^[A-Z0-9]{24}$/.test(code), 400, 'INVALID_PAIRING', '连接码无效或已过期，请在网页重新生成。');
      const name = text(input.deviceName, '电脑名称', 80, true), token = randomBytes(32).toString('base64url');
      const result = store.transaction(() => {
        const pair = db.prepare('SELECT * FROM app_connector_pairing WHERE code_hash=?').get(tokenHash(code));
        ensure(pair && !pair.consumed_at && pair.expires_at >= clock(), 410, 'INVALID_PAIRING', '连接码无效、已使用或已过期。');
        const member = store.membership(pair.owner_id); actor(member || {});
        ensure(member.team_id === pair.team_id, 403, 'PAIRING_FORBIDDEN', '团队关系已变化，请重新连接。');
        ensure(db.prepare("SELECT count(*) AS n FROM app_connector WHERE owner_id=? AND status!='revoked'").get(pair.owner_id).n < 5, 409, 'CONNECTOR_LIMIT', '每位成员最多保留 5 个连接，请先断开不再使用的电脑。');
        const id = randomUUID();
        db.prepare('INSERT INTO app_connector(id,team_id,owner_id,name,token_hash,status,created_at) VALUES(?,?,?,?,?,?,?)').run(id, pair.team_id, pair.owner_id, name, tokenHash(token), 'pending', stamp());
        db.prepare('UPDATE app_connector_pairing SET consumed_at=? WHERE id=?').run(stamp(), pair.id);
        store.audit(pair.team_id, pair.owner_id, 'connector.paired', null, null, {connectorId: id});
        const user = db.prepare('SELECT name FROM user WHERE id=?').get(pair.owner_id);
        return {connectorId: id, token, server: baseURL, owner: {id: pair.owner_id, name: user.name}, team: {id: pair.team_id, name: member.team_name}};
      });
      json(res, 201, result); return true;
    }
    let auth = bearer(req);
    store.consumeLimit('runner:' + auth.connector.id, 180, 60000);
    const input = await body(req, path.endsWith('/result') ? 256 * 1024 : 64 * 1024);
    auth = bearer(req); // Revalidate after slow requests / disablement.
    const {connector, member} = auth;
    if (path === '/api/runner/heartbeat') {
      fields(input, ['version', 'codex']); fields(input.codex, ['available', 'authenticated', 'compatible', 'version']);
      ensure(typeof input.codex.available === 'boolean' && typeof input.codex.authenticated === 'boolean', 400, 'INVALID_DIAGNOSTIC', '连接状态格式不正确。');
      ensure(input.codex.compatible === undefined || typeof input.codex.compatible === 'boolean', 400, 'INVALID_DIAGNOSTIC', '连接兼容性格式不正确。');
      const diagnostic = {version: text(input.version || '', '连接器版本', 40), codex: {available: input.codex.available, authenticated: input.codex.authenticated, compatible: input.codex.compatible !== false, version: text(input.codex.version || '', 'Codex 版本', 80)}};
      const item = store.transaction(() => {
        actor(member);
        db.prepare('UPDATE app_connector SET last_seen=?,diagnostic_json=? WHERE id=?').run(clock(), JSON.stringify(diagnostic), connector.id);
        return publicConnector(rawConnector(connector.id));
      });
      json(res, 200, {status: item.status, online: item.online, ready: item.ready}); return true;
    }
    ensure(connector.status === 'active', 403, 'CONNECTOR_PENDING', '请先回到网页确认连接这台电脑。');
    if (path === '/api/runner/claim') {
      fields(input, []);
      const job = store.transaction(() => {
        actor(member); expire(true);
        ensure(publicConnector(rawConnector(connector.id)).ready, 409, 'CONNECTOR_NOT_READY', '请先检查 Codex 登录状态并保持连接器在线。');
        ensure(!db.prepare("SELECT 1 FROM app_generation_job WHERE connector_id=? AND status='running'").get(connector.id), 409, 'CONNECTOR_BUSY', '这台电脑已有一个生成任务正在处理。');
        let row;
        while ((row = db.prepare("SELECT * FROM app_generation_job WHERE connector_id=? AND owner_id=? AND status='queued' ORDER BY created_at,rowid LIMIT 1").get(connector.id, member.user_id))) {
          if (staleReason(row)) {changeJob(row, 'stale', 'PROPOSAL_CHANGED'); continue;}
          const leaseToken = randomBytes(32).toString('base64url'), expiresAt = clock() + LEASE_MS;
          db.prepare("UPDATE app_generation_job SET status='running',lease_hash=?,lease_expires=?,attempt=attempt+1,updated_at=? WHERE id=? AND status='queued'").run(tokenHash(leaseToken), expiresAt, stamp(), row.id);
          store.audit(member.team_id, member.user_id, 'generation.claimed', row.proposal_id, row.proposal_revision, {jobId: row.id, connectorId: connector.id});
          return {id: row.id, leaseToken, prompt: row.prompt, schema: JSON.parse(row.schema_json), generationId: row.generation_id, proposalId: row.proposal_id, expiresAt: new Date(expiresAt).toISOString(), attempt: row.attempt + 1};
        }
        return null;
      });
      json(res, 200, {job}); return true;
    }
    const match = path.match(/^\/api\/runner\/jobs\/([a-zA-Z0-9-]+)\/(heartbeat|result|failure)$/);
    ensure(match, 404, 'NOT_FOUND', '没有找到此连接器功能。');
    const [, id, action] = match;
    const row = rawJob(id);
    if (action === 'result') {
      fields(input, ['leaseToken', 'result']); checkLease(row, connector, input.leaseToken, true);
      const resultHash = digest(input.result);
      if (row.status === 'succeeded') {
        ensure(row.result_hash === resultHash, 409, 'RESULT_MISMATCH', '此任务已经保存过不同的结果，请核对原记录。');
        json(res, 200, {status: 'succeeded', job: publicJob(row)}); return true;
      }
      if (staleReason(row)) {
        store.transaction(() => {actor(member); changeJob(row, 'stale', 'PROPOSAL_CHANGED');});
        json(res, 200, {status: 'stale', job: publicJob(rawJob(id))}); return true;
      }
      try {
        planning.importGeneration(member, row.proposal_id, {expectedRevision: row.proposal_revision, generationId: row.generation_id, result: input.result, origin: 'codex_connector'}, () => {
          actor(member); checkLease(rawJob(id), rawConnector(connector.id), input.leaseToken);
          db.prepare("UPDATE app_generation_job SET status='succeeded',result_hash=?,result_revision=?,updated_at=? WHERE id=?").run(resultHash, row.proposal_revision + 1, stamp(), id);
          store.audit(member.team_id, member.user_id, 'generation.succeeded', row.proposal_id, row.proposal_revision + 1, {jobId: id, connectorId: connector.id});
        });
      } catch (error) {
        if (error instanceof AppError && ['GENERATION_STALE', 'RESOURCE_CHANGED', 'REVISION_CONFLICT', 'PROPOSAL_ARCHIVED', 'RESULT_ALREADY_IMPORTED'].includes(error.code)) {
          store.transaction(() => {actor(member); changeJob(row, 'stale', 'PROPOSAL_CHANGED');});
          json(res, 200, {status: 'stale', job: publicJob(rawJob(id))}); return true;
        }
        throw error;
      }
      json(res, 200, {status: 'succeeded', job: publicJob(rawJob(id))}); return true;
    }
    fields(input, action === 'heartbeat' ? ['leaseToken'] : ['leaseToken', 'code', 'message']);
    checkLease(row, connector, input.leaseToken);
    if (action === 'heartbeat') {
      if (staleReason(row)) {
        store.transaction(() => {actor(member); changeJob(row, 'stale', 'PROPOSAL_CHANGED');});
        throw new AppError(409, 'JOB_STALE', '方案已变化，请停止当前生成，等待重新提交。');
      }
      store.transaction(() => {actor(member); db.prepare('UPDATE app_generation_job SET lease_expires=?,updated_at=? WHERE id=?').run(clock() + LEASE_MS, stamp(), id);});
      json(res, 200, {status: 'running', expiresAt: new Date(clock() + LEASE_MS).toISOString()}); return true;
    }
    // Only fixed codes are saved. Raw local errors can contain file paths,
    // authentication material or prompt text and are never persisted.
    const code = Object.hasOwn(ERROR_MESSAGES, input.code) ? input.code : 'CODEX_FAILED';
    store.transaction(() => {actor(member); changeJob(row, 'failed', code);});
    json(res, 200, {status: 'failed', job: publicJob(rawJob(id))}); return true;
  }
  async function memberHandle(req, res, url, member, {body, json, requireEditor}) {
    const path = url.pathname;
    if (path === '/api/connectors' && req.method === 'GET') {
      expire();
      const items = db.prepare('SELECT * FROM app_connector WHERE team_id=? AND owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 30').all(member.team_id, member.user_id).map(publicConnector);
      json(res, 200, {items, ready: items.some(i => i.ready)}); return true;
    }
    if (path === '/api/connectors/pairing' && req.method === 'POST') {
      requireEditor(member); fields(await body(req), []);
      store.consumeLimit('pair-create:' + member.user_id, 10, 60000);
      const code = randomBytes(12).toString('hex').toUpperCase(), expiresAt = clock() + PAIR_MS;
      store.transaction(() => {
        actor(member);
        db.prepare('DELETE FROM app_connector_pairing WHERE owner_id=? AND consumed_at IS NULL').run(member.user_id);
        db.prepare('INSERT INTO app_connector_pairing VALUES(?,?,?,?,?,?,?)').run(randomUUID(), member.team_id, member.user_id, tokenHash(code), expiresAt, null, stamp());
        store.audit(member.team_id, member.user_id, 'connector.pairing_created');
      });
      json(res, 201, {pairing: {code: code.match(/.{1,6}/g).join('-'), expiresAt: new Date(expiresAt).toISOString()}}); return true;
    }
    const device = path.match(/^\/api\/connectors\/([a-zA-Z0-9-]+)\/(confirm|revoke)$/);
    if (device && req.method === 'POST') {
      requireEditor(member); fields(await body(req), []);
      const [, id, action] = device;
      const item = store.transaction(() => {
        actor(member); const connector = ownedConnector(member, id);
        if (action === 'confirm') {
          ensure(connector.status === 'pending', 409, 'CONNECTOR_NOT_PENDING', '此连接已确认或已断开。');
          ensure(connector.last_seen !== null && connector.last_seen >= clock() - ONLINE_MS, 409, 'CONNECTOR_OFFLINE', '请先启动这台电脑的连接器，再确认连接。');
          db.prepare("UPDATE app_connector SET status='active',confirmed_at=? WHERE id=?").run(stamp(), id);
        } else {
          db.prepare("UPDATE app_connector SET status='revoked' WHERE id=?").run(id);
          for (const row of db.prepare("SELECT * FROM app_generation_job WHERE connector_id=? AND status IN('queued','running')").all(id)) changeJob(row, 'cancelled', 'CONNECTOR_REVOKED');
        }
        store.audit(member.team_id, member.user_id, 'connector.' + (action === 'confirm' ? 'confirmed' : 'revoked'), null, null, {connectorId: id});
        return publicConnector(rawConnector(id));
      });
      json(res, 200, {item}); return true;
    }
    const proposal = path.match(/^\/api\/proposals\/([a-zA-Z0-9-]+)\/generation\/jobs$/);
    if (proposal) {
      const id = proposal[1]; store.proposal(member.team_id, id);
      if (req.method === 'GET') {
        expire();
        const items = db.prepare('SELECT * FROM app_generation_job WHERE team_id=? AND proposal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(member.team_id, id).map(publicJob);
        json(res, 200, {items}); return true;
      }
      if (req.method === 'POST') {
        requireEditor(member);
        const input = fields(await body(req), ['expectedRevision', 'connectorId']); revision(input.expectedRevision);
        store.consumeLimit('generation-create:' + member.user_id, 12, 60000);
        actor(member); expire();
        const connector = ownedConnector(member, text(input.connectorId, 'Codex 连接', 80, true));
        ensure(publicConnector(connector).ready, 409, 'CONNECTOR_NOT_READY', '请选择属于你且在线、已登录的 Codex。');
        ensure(!db.prepare("SELECT 1 FROM app_generation_job WHERE proposal_id=? AND status IN('queued','running')").get(id), 409, 'JOB_ALREADY_ACTIVE', '这份方案已有生成任务，请等待完成或由任务发起人取消。');
        const jobId = randomUUID();
        const result = planning.prepareGeneration(member, id, input.expectedRevision, (_item, workflow) => {
          actor(member);
          const g = workflow.generation;
          db.prepare('INSERT INTO app_generation_job(id,team_id,owner_id,connector_id,proposal_id,proposal_revision,generation_id,prompt,schema_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, member.team_id, member.user_id, connector.id, id, g.proposalRevision, g.id, g.prompt, JSON.stringify(g.schema), 'queued', stamp(), stamp());
          store.audit(member.team_id, member.user_id, 'generation.queued', id, g.proposalRevision, {jobId, connectorId: connector.id});
        });
        json(res, 201, {...result, job: publicJob(rawJob(jobId))}); return true;
      }
    }
    const cancel = path.match(/^\/api\/generation-jobs\/([a-zA-Z0-9-]+)\/cancel$/);
    if (cancel && req.method === 'POST') {
      requireEditor(member); fields(await body(req), []);
      const item = store.transaction(() => {
        actor(member); const row = rawJob(cancel[1]);
        ensure(row.team_id === member.team_id && row.owner_id === member.user_id, 404, 'JOB_NOT_FOUND', '只能取消自己发起的生成任务。');
        ensure(['queued', 'running'].includes(row.status), 409, 'JOB_NOT_ACTIVE', '此任务已经结束。');
        changeJob(row, 'cancelled'); return publicJob(rawJob(row.id));
      });
      json(res, 200, {job: item}); return true;
    }
    return false;
  }
  return {publicHandle, memberHandle, isRunnerPath, authenticate: bearer};
}
