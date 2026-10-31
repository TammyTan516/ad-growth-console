// SPDX-License-Identifier: MIT
import http from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, sep, extname, dirname} from 'node:path';
import {createAuth} from './auth.mjs';
import {openStore, tokenHash} from './store.mjs';
import {AppError, ensure} from './errors.mjs';
import * as validate from './validation.mjs';
import {createResources} from './resources.mjs';
import {createPlanning} from './planning.mjs';
import {createConnectors} from './connectors.mjs';
import {createMediaStorage} from './media-storage.mjs';
import {createExecution} from './execution.mjs';
import {createGoogleAdsReader} from './google-ads-reader.mjs';
import {createReporting} from './reporting.mjs';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const canEdit = member => ['admin', 'editor'].includes(member.role);
const requestHeaders = req => new Headers(Object.entries(req.headers).filter(([, v]) => v !== undefined).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v]));
const safeEqual = (a, b) => timingSafeEqual(Buffer.from(tokenHash(a)), Buffer.from(tokenHash(b)));
const MIME = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.md': 'text/plain; charset=utf-8'};

export async function createApplication({dbPath = ':memory:', dataDir = dbPath === ':memory:' ? resolve('.local') : dirname(dbPath), baseURL = 'http://127.0.0.1:3000', authSecret, bootstrapToken, mode = 'development', rateLimitMax = 15, sitemapReader, connectorClock, executionClock, storageEnv = {}, ossClient, reportingReader, reportingClock, reportingScheduler = true} = {}) {
  const origin = new URL(baseURL);
  ensure(origin.origin === baseURL && !origin.username && !origin.password, 500, 'INVALID_CONFIG', 'APP_URL 必须是应用的完整访问来源，不带路径。');
  ensure(typeof authSecret === 'string' && authSecret.length >= 32, 500, 'INVALID_CONFIG', '请配置至少 32 位的登录密钥。');
  ensure(typeof bootstrapToken === 'string' && bootstrapToken.length >= 32, 500, 'INVALID_CONFIG', '请配置至少 32 位的初始化密钥。');
  ensure(mode !== 'production' || origin.protocol === 'https:', 500, 'INVALID_CONFIG', '正式部署需要 HTTPS 的 APP_URL。');
  const store = openStore(dbPath);
  let auth;
  try { auth = await createAuth({db: store.db, baseURL, secret: authSecret, rateLimitMax}); } catch (error) { store.db.close(); throw error; }
  const mediaStorage = createMediaStorage({dataDir, env: storageEnv, ossClient});
  const resources = createResources({store, dataDir, sitemapReader, mediaStorage});
  const planning = createPlanning({store, resources});
  const connectors = createConnectors({store, planning, baseURL, clock: connectorClock});
  const execution = createExecution({store, planning, resources, connectors, dataDir, clock: executionClock});
  const reporting = createReporting({store, reader: reportingReader || createGoogleAdsReader({env: storageEnv}), clock: reportingClock, sourceTeamId: storageEnv.GOOGLE_ADS_TEAM_ID});
  // Onboarding is serialized because one invitation must never register two users.
  // Database updates themselves remain short synchronous transactions.
  let onboarding = Promise.resolve();
  function exclusive(fn) {
    const operation = onboarding.then(fn);
    onboarding = operation.catch(() => {});
    return operation;
  }
  function json(res, status, value) {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));
  }
  async function body(req, maxBytes = 64 * 1024) {
    ensure(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''), 415, 'JSON_REQUIRED', '请使用 JSON 格式提交。');
    let total = 0;
    const chunks = [];
    for await (const chunk of req) {
      total += chunk.length;
      ensure(total <= maxBytes, 413, 'BODY_TOO_LARGE', '本次内容过大，请减少后再保存。');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new AppError(400, 'INVALID_JSON', '提交内容不是有效的 JSON。'); }
  }
  async function identity(req, membershipRequired = true) {
    const session = await auth.api.getSession({headers: requestHeaders(req)});
    ensure(session?.user, 401, 'UNAUTHENTICATED', '请先登录。');
    const member = store.membership(session.user.id);
    if (membershipRequired) {
      ensure(member, 403, 'NO_MEMBERSHIP', '此账号尚未加入工作区，请接受管理员邀请。');
      ensure(member.status === 'active', 403, 'MEMBER_DISABLED', '你的团队访问权限已停用，请联系管理员。');
    }
    return {user: session.user, member};
  }
  function requireAdmin(member) { ensure(member.role === 'admin', 403, 'FORBIDDEN', '此操作需要管理员权限。'); }
  function requireEditor(member) { ensure(canEdit(member), 403, 'FORBIDDEN', '你当前只有查看权限。'); }
  async function register(email, name, password) {
    ensure(!store.db.prepare('SELECT 1 FROM user WHERE lower(email)=?').get(email), 409, 'ACCOUNT_EXISTS', '该邮箱已有账号，请登录后接受邀请。');
    const response = await auth.api.signUpEmail({body: {email, name, password}, asResponse: true});
    const result = await response.json();
    ensure(response.ok && result?.user?.id, 400, 'REGISTRATION_FAILED', '无法创建账号，请检查邮箱与密码后重试。');
    return result.user;
  }
  // A failed membership transaction must not strand a new account outside its invitation.
  function discardUnjoinedUser(userId) {
    if (store.membership(userId)) return;
    store.transaction(() => {
      store.db.prepare('DELETE FROM session WHERE userId=?').run(userId);
      store.db.prepare('DELETE FROM account WHERE userId=?').run(userId);
      store.db.prepare('DELETE FROM user WHERE id=?').run(userId);
    });
  }
  async function authRoute(req, res, pathname) {
    const allowed = {'/api/auth/sign-in/email': 'POST', '/api/auth/sign-out': 'POST', '/api/auth/get-session': 'GET', '/api/auth/ok': 'GET'};
    ensure(allowed[pathname] === req.method, 403, 'AUTH_ROUTE_DISABLED', '此登录入口未开放，请使用邀请链接加入团队。');
    if (pathname === '/api/auth/sign-in/email') store.consumeLimit('signin:' + req.socket.remoteAddress, rateLimitMax, 60000);
    const content = req.method === 'POST' ? await body(req) : undefined;
    const headers = requestHeaders(req);
    // Do not trust caller-supplied reverse-proxy headers. APP_URL is the authority.
    for (const key of ['host', 'content-length', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded']) headers.delete(key);
    headers.set('x-console-client-ip', req.socket.remoteAddress || '127.0.0.1');
    const response = await auth.handler(new Request(baseURL + pathname, {method: req.method, headers, ...(content ? {body: JSON.stringify(content)} : {})}));
    for (const [key, value] of response.headers) if (!['set-cookie', 'content-length', 'transfer-encoding'].includes(key)) res.setHeader(key, value);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    if (!response.ok) {
      let failure = {};
      try { failure = await response.json(); } catch { /* Never include raw auth responses. */ }
      return json(res, response.status, {error: {code: failure.code || 'AUTH_FAILED', message: response.status === 401 ? '邮箱或密码不正确，请重新填写。' : response.status === 429 ? '登录尝试过于频繁，请稍后再试。' : '登录操作未完成，请检查输入后重试。'}});
    }
    res.statusCode = response.status;
    res.end(Buffer.from(await response.arrayBuffer()));
  }
  async function api(req, res, url) {
    const path = url.pathname;
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, {status: 'ok', phase: 'reporting', version: '0.7.0'});
    if (await execution.publicHandle(req, res, url, {body, json})) return;
    if (await connectors.publicHandle(req, res, url, {body, json})) return;
    if (path === '/api/bootstrap/status' && req.method === 'GET') return json(res, 200, {needsSetup: !store.hasTeam()});
    if (path.startsWith('/api/auth/')) return authRoute(req, res, path);
    if (path === '/api/bootstrap' && req.method === 'POST') {
      store.consumeLimit('bootstrap:' + req.socket.remoteAddress, 10, 60000);
      const input = validate.fields(await body(req), ['token', 'teamName', 'name', 'email', 'password']);
      ensure(typeof input.token === 'string' && input.token.length <= 256 && safeEqual(input.token, bootstrapToken), 403, 'INVALID_BOOTSTRAP_TOKEN', '初始化密钥不正确。');
      const email = validate.email(input.email), name = validate.text(input.name, '姓名', 80, true), password = validate.password(input.password), teamName = validate.text(input.teamName, '工作区名称', 100, true);
      return exclusive(async () => {
        ensure(!store.hasTeam(), 409, 'ALREADY_INITIALIZED', '工作区已初始化，请直接登录。');
        const user = await register(email, name, password);
        try { store.bootstrap(user.id, teamName); } catch (error) { discardUnjoinedUser(user.id); throw error; }
        return json(res, 201, {ok: true});
      });
    }
    if (path === '/api/invitations/inspect' && req.method === 'POST') {
      store.consumeLimit('inspect:' + req.socket.remoteAddress, 30, 60000);
      const input = validate.fields(await body(req), ['token']), invite = store.invitation(input.token);
      return json(res, 200, {email: invite.email, teamName: invite.team_name, role: invite.role, expiresAt: invite.expires_at});
    }
    if (path === '/api/invitations/register' && req.method === 'POST') {
      store.consumeLimit('register:' + req.socket.remoteAddress, 10, 60000);
      const input = validate.fields(await body(req), ['token', 'name', 'password']);
      const name = validate.text(input.name, '姓名', 80, true), password = validate.password(input.password);
      return exclusive(async () => {
        const invite = store.invitation(input.token);
        const user = await register(invite.email, name, password);
        try { store.acceptInvitation(input.token, user); } catch (error) { discardUnjoinedUser(user.id); throw error; }
        return json(res, 201, {ok: true});
      });
    }
    if (path === '/api/invitations/accept' && req.method === 'POST') {
      const input = validate.fields(await body(req), ['token']), {user} = await identity(req, false);
      store.acceptInvitation(input.token, user);
      return json(res, 200, {ok: true});
    }
    const {user, member} = await identity(req);
    if (path === '/api/me' && req.method === 'GET') return json(res, 200, {user: {id: user.id, name: user.name, email: user.email}, team: {id: member.team_id, name: member.team_name}, role: member.role, permissions: {canEdit: canEdit(member), canManage: member.role === 'admin'}});
    if (path === '/api/storage' && req.method === 'GET') return json(res, 200, mediaStorage.status());
    const helpers = {body, json, identity, requireEditor, requireAdmin};
    if (await reporting.handle(req, res, url, member, helpers)) return;
    if (await execution.memberHandle(req, res, url, member, helpers)) return;
    if (await connectors.memberHandle(req, res, url, member, helpers)) return;
    if (await resources.handle(req, res, url, member, helpers)) return;
    if (await planning.handle(req, res, url, member, helpers)) return;
    if (path === '/api/proposals' && req.method === 'GET') return json(res, 200, {items: store.proposals(member.team_id).map(item => planning.read(member, item.id).item), counts: store.proposalCounts(member.team_id), limit: 500});
    if (path === '/api/proposals' && req.method === 'POST') {
      requireEditor(member);
      const input = validate.fields(await body(req), ['title', 'brief']);
      return json(res, 201, {item: store.createProposal(member, validate.text(input.title, '方案名称', 120, true), validate.proposalBrief(input.brief))});
    }
    const proposal = path.match(/^\/api\/proposals\/([a-zA-Z0-9-]+)(\/versions)?$/);
    if (proposal) {
      const [, id, versions] = proposal;
      if (req.method === 'GET') return json(res, 200, versions ? {items: store.versions(member.team_id, id)} : {item: planning.read(member, id).item});
      if (req.method === 'PATCH' && !versions) {
        requireEditor(member);
        const input = validate.fields(await body(req), ['expectedRevision', 'title', 'brief', 'status']);
        const change = {expectedRevision: validate.revision(input.expectedRevision)};
        if (input.title !== undefined) change.title = validate.text(input.title, '方案名称', 120, true);
        if (input.brief !== undefined) change.brief = validate.proposalBrief(input.brief);
        if (input.status !== undefined) {
          ensure(['draft', 'archived'].includes(input.status), 400, 'INVALID_STATUS', '当前只支持草稿和已归档状态。');
          change.status = input.status;
        }
        ensure(Object.keys(change).length > 1, 400, 'NO_CHANGES', '没有需要保存的修改。');
        return json(res, 200, {item: store.updateProposal(member, id, change)});
      }
    }
    if (path === '/api/audit' && req.method === 'GET') return json(res, 200, {items: store.auditList(member.team_id, url.searchParams.get('proposalId'))});
    if (path === '/api/team' && req.method === 'GET') return json(res, 200, store.team(member));
    if (path === '/api/invitations' && req.method === 'POST') {
      requireAdmin(member);
      const input = validate.fields(await body(req), ['email', 'role']), token = randomBytes(32).toString('base64url');
      const item = store.createInvitation(member, validate.email(input.email), validate.role(input.role), token);
      return json(res, 201, {item, inviteUrl: baseURL + '/#invite=' + token});
    }
    const invitation = path.match(/^\/api\/invitations\/([a-zA-Z0-9-]+)$/);
    if (invitation && req.method === 'DELETE') {
      requireAdmin(member);
      store.revokeInvitation(member, invitation[1]);
      return json(res, 200, {ok: true});
    }
    const target = path.match(/^\/api\/members\/([a-zA-Z0-9-]+)$/);
    if (target && req.method === 'PATCH') {
      requireAdmin(member);
      const input = validate.fields(await body(req), ['role', 'status']);
      ensure(Object.keys(input).length, 400, 'NO_CHANGES', '没有需要保存的修改。');
      const change = {};
      if (input.role !== undefined) change.role = validate.role(input.role);
      if (input.status !== undefined) {
        ensure(['active', 'disabled'].includes(input.status), 400, 'INVALID_STATUS', '成员状态不正确。');
        change.status = input.status;
      }
      store.updateMember(member, target[1], change);
      return json(res, 200, {ok: true});
    }
    throw new AppError(404, 'NOT_FOUND', '没有找到此功能。');
  }
  async function staticFile(req, res, pathname) {
    ensure(['GET', 'HEAD'].includes(req.method), 405, 'METHOD_NOT_ALLOWED', '不支持此请求。');
    let relative;
    if (pathname === '/') relative = 'workspace/index.html';
    else if (pathname === '/demo') relative = 'index.html';
    else if (['/README.md', '/README.zh-CN.md', '/docs/TRACKING.md'].includes(pathname)) relative = pathname.slice(1);
    else if (/^\/(workspace|src)\/[a-zA-Z0-9._/-]+\.(js|css)$/.test(pathname)) relative = pathname.slice(1);
    ensure(relative && !relative.split('/').includes('..'), 404, 'NOT_FOUND', '没有找到此页面。');
    const absolute = resolve(ROOT, relative);
    ensure(absolute.startsWith(ROOT + sep) && MIME[extname(absolute)], 404, 'NOT_FOUND', '没有找到此页面。');
    let bytes;
    try { bytes = await readFile(absolute); } catch { throw new AppError(404, 'NOT_FOUND', '没有找到此页面。'); }
    res.writeHead(200, {'Content-Type': MIME[extname(absolute)]});
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; connect-src 'self'");
    try {
      ensure(req.headers.host === origin.host, 403, 'INVALID_HOST', '请使用配置的工作区地址访问。');
      const url = new URL(req.url, baseURL);
      ensure(url.origin === baseURL, 403, 'INVALID_ORIGIN', '请求来源不正确。');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) ensure(req.headers.origin === baseURL || (connectors.isRunnerPath(url.pathname) && !req.headers.origin), 403, 'INVALID_ORIGIN', '请从当前工作区页面提交操作。');
      if (url.pathname.startsWith('/api/')) {
        ensure(!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']), 403, 'INVALID_ORIGIN', '请从当前工作区页面访问。');
        await api(req, res, url);
      }
      else await staticFile(req, res, url.pathname);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof AppError) json(res, error.status, {error: {code: error.code, message: error.message}, ...error.extra});
      else json(res, 500, {error: {code: 'INTERNAL_ERROR', message: '本次操作未完成，请稍后重试。你的未保存输入仍保留。'}});
    }
  });
  server.requestTimeout = 120000;
  server.headersTimeout = 10000;
  // The local process can refresh read-only reports while it is running. This
  // does not create an unattended browser or an advertising execution task.
  let reportTick = null;
  function tickReports() {
    if (!reportTick) reportTick = Promise.resolve().then(() => reporting.tick()).catch(() => {console.warn('Daily reporting encountered an internal error; check reporting status.');}).finally(() => {reportTick = null;});
  }
  const reportingTimer = reportingScheduler ? setInterval(tickReports, 60_000) : null;
  reportingTimer?.unref();
  if (reportingScheduler) server.once('listening', tickReports);
  return {server, db: store.db, auth, async close() {
    if (reportingTimer) clearInterval(reportingTimer);
    if (server.listening) {
      await new Promise((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeIdleConnections(); });
    }
    await onboarding;
    if (reportTick) await reportTick;
    await reporting.close?.();
    store.db.close();
  }};
}
