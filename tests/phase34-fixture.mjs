// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:net';
import {createApplication} from '../server/app.mjs';

// Real HTTP, authentication cookies and private temporary SQLite/files. Synthetic
// example.com accounts only; never use the developer workspace's .local directory.
export const PASSWORD = 'Synthetic phase 3 and 4 passphrase!';
export const BRIEF = {
  operation: 'new_campaign', platforms: ['Google'], objective: 'registration',
  country: 'US', language: 'English', audienceDirection: 'Synthetic video creators',
  groupName: 'Synthetic group', budgets: {Google: 60},
  startAt: '2026-11-02T09:00', timeZone: 'Asia/Shanghai', parentCampaign: null,
};
export const freshBrief = (change = {}) => structuredClone({...BRIEF, ...change});
export function ok(response, status = 200, label = 'request') {
  assert.equal(response.status, status, `${label}: HTTP ${response.status}: ${response.data?.error?.message || ''}`);
  return response.data;
}
export function error(response, statuses, label = 'rejected request') {
  assert.ok((Array.isArray(statuses) ? statuses : [statuses]).includes(response.status), `${label}: HTTP ${response.status}`);
  assert.equal(typeof response.data?.error?.code, 'string', `${label}: error code`);
  return response.data;
}
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve);});
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(e => e ? reject(e) : resolve()));
  return port;
}
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ad-console-planning-test-'));
  const dbPath = join(directory, 'test.sqlite'), dataDir = join(directory, 'private');
  const baseURL = `http://127.0.0.1:${await freePort()}`;
  const secrets = {authSecret: randomBytes(32).toString('hex'), bootstrapToken: randomBytes(32).toString('hex')};
  let app;
  async function start() {
    app = await createApplication({dbPath, dataDir, baseURL, ...secrets, mode: 'development', rateLimitMax: 1000, ...options});
    await new Promise((resolve, reject) => {app.server.once('error', reject); app.server.listen(Number(new URL(baseURL).port), '127.0.0.1', resolve);});
  }
  async function request(route, {method = 'GET', body, rawBody, actor, session = actor?.session, headers: extra = {}, origin = baseURL} = {}) {
    const headers = new Headers({'Content-Type': 'application/json', Origin: origin, Connection: 'close', ...extra});
    if (session?.cookies.size) headers.set('Cookie', [...session.cookies].map(([k,v]) => `${k}=${v}`).join('; '));
    const result = await fetch(new URL(route, baseURL), {method, headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...(rawBody !== undefined ? {body: rawBody} : body !== undefined ? {body: JSON.stringify(body)} : {})});
    if (session) for (const value of result.headers.getSetCookie()) {
      const pair = value.split(';', 1)[0], at = pair.indexOf('=');
      if (at > 0) session.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const bytes = Buffer.from(await result.arrayBuffer());
    const text = bytes.toString('utf8');
    let data;
    try {data = JSON.parse(text);} catch { /* Authenticated binary responses stay bytes. */ }
    return {status: result.status, data, bytes, text, headers: result.headers};
  }
  async function signIn(email, member = true) {
    const session = {cookies: new Map()};
    ok(await request('/api/auth/sign-in/email', {method: 'POST', session, body: {email, password: PASSWORD}}));
    assert.ok(session.cookies.size);
    const actor = {session, email};
    if (member) actor.me = ok(await request('/api/me', {actor}));
    return actor;
  }
  async function invitedMember(admin, email, role = 'editor') {
    const invitation = ok(await request('/api/invitations', {method: 'POST', actor: admin, body: {email, role}}), 201);
    const token = new URLSearchParams(new URL(invitation.inviteUrl).hash.slice(1)).get('invite');
    ok(await request('/api/invitations/register', {method: 'POST', body: {token, name: `Synthetic ${role}`, password: PASSWORD}}), 201);
    return signIn(email);
  }
  async function outsider(email = 'outside@example.com') {
    const response = await app.auth.api.signUpEmail({body: {email, name: 'Synthetic other team', password: PASSWORD}, asResponse: true});
    assert.ok(response.ok);
    const {user} = await response.json(), date = new Date().toISOString(), teamId = randomBytes(16).toString('hex');
    app.db.prepare('INSERT INTO app_team VALUES(?,?,?)').run(teamId, 'Synthetic outside team', date);
    app.db.prepare('INSERT INTO app_member VALUES(?,?,?,?,?)').run(user.id, teamId, 'admin', 'active', date);
    return signIn(email);
  }
  t.after(async () => {if (app) await app.close(); await rm(directory, {recursive: true, force: true});});
  await start();
  ok(await request('/api/bootstrap', {method: 'POST', body: {token: secrets.bootstrapToken, teamName: 'Synthetic planning team', name: 'Synthetic administrator', email: 'admin@example.com', password: PASSWORD}}), 201);
  const admin = await signIn('admin@example.com');
  return {directory, dataDir, dbPath, baseURL, admin, request, signIn, invitedMember, outsider,
    get app() {return app;},
    async restart() {const old = app; app = undefined; await old.close(); await start();},
  };
}
export async function proposal(f, actor = f.admin, change = {}) {
  return ok(await f.request('/api/proposals', {method: 'POST', actor, body: {title: 'Synthetic ad plan', brief: freshBrief(change)}}), 201).item;
}
export const MATERIAL = {name: 'Synthetic creator video', source: 'creator', sourceUrl: 'https://example.com/source', mediaType: 'video', notes: 'Synthetic creator permission', adCode: 'SYNTHETIC-CREATOR-CODE'};
export const LANDING = {name: 'Synthetic creation tool', url: 'https://example.com/create?keep=value#start', description: 'Make synthetic videos', tags: ['video', 'creator'], language: 'English', objective: 'registration'};
export const CONTENT = {strategy: 'Reach video creators with a clear tool demonstration and a website registration goal.', platforms: [{platform: 'Google', headlines: ['Create Video Ideas', 'Try the Creative Tool', 'Start Creating Today'], descriptions: ['Explore a simple creative workflow. Register to start your first project.', 'Bring your ideas into a new project with a focused creative tool.'], primaryTexts: [], keywords: ['video creation tool', 'creative video ideas'], negativeKeywords: ['jobs', 'free download'], callToAction: 'Sign up'}]};
export const CONFIG = {expectedRevision: 0, name: 'Synthetic tracking rule', sourceMap: {Google: 'google', Meta: 'meta', TikTok: 'tiktok'}, mediumMap: {Google: 'cpc', Meta: 'paid_social', TikTok: 'paid_social'}, campaignTemplate: '{proposalId}', contentTemplate: '{materialId}', termTemplate: ''};
export async function setupResources(f, actor = f.admin) {
  const material = ok(await f.request('/api/materials', {method: 'POST', actor, body: MATERIAL}), 201).item;
  const landing = ok(await f.request('/api/landings', {method: 'POST', actor, body: LANDING}), 201).item;
  return {material, landing, selection: {materials: [{id: material.id, revision: material.revision}], audiences: [], landing: {id: landing.id, revision: landing.revision}}};
}
