import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createApplication } from '../server/app.mjs';

// These tests use a real HTTP server, BetterAuth sessions and an isolated SQLite
// file. Only synthetic example.com identities are created. No permission result,
// session or application route is mocked.
const PASSWORD = 'Synthetic integration passphrase 2026!';
const BRIEF = {
  operation: 'new_campaign',
  platforms: ['Google'],
  objective: 'registration',
  country: 'US',
  language: 'English',
  audienceDirection: 'Synthetic audience',
  groupName: 'Test group',
  budgets: { Google: 60 },
  startAt: '',
  timeZone: 'Asia/Shanghai',
  parentCampaign: null,
};
const freshBrief = (changes = {}) => structuredClone({ ...BRIEF, ...changes });

function expectStatus(result, allowed, label) {
  const statuses = Array.isArray(allowed) ? allowed : [allowed];
  assert.ok(statuses.includes(result.status), `${label}: HTTP ${result.status}`);
}

function expectError(result, allowed, label) {
  expectStatus(result, allowed, label);
  assert.equal(typeof result.data?.error?.code, 'string', `${label}: structured error code`);
  assert.equal(typeof result.data?.error?.message, 'string', `${label}: structured error message`);
}

function receiveCookies(headers, session) {
  if (!session) return;
  for (const cookie of headers.getSetCookie()) {
    const pair = cookie.split(';', 1)[0];
    const equals = pair.indexOf('=');
    if (equals > 0) session.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t, { rateLimitMax = 1000 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ad-console-team-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  const port = await availablePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const authSecret = randomBytes(32).toString('hex');
  const bootstrapToken = randomBytes(32).toString('hex');
  let application;

  async function start() {
    application = await createApplication({
      dbPath, baseURL, authSecret, bootstrapToken,
      mode: 'development', rateLimitMax,
    });
    await new Promise((resolve, reject) => {
      application.server.once('error', reject);
      application.server.listen(port, '127.0.0.1', resolve);
    });
  }

  async function request(route, options = {}) {
    const {
      method = 'GET', body, rawBody, session, origin = baseURL,
      contentType = 'application/json', headers: extraHeaders = {},
    } = options;
    const headers = new Headers({
      Origin: origin,
      'Content-Type': contentType,
      Connection: 'close',
    });
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
    if (session?.cookies.size) {
      headers.set('Cookie', [...session.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    }
    const response = await fetch(new URL(route, baseURL), {
      method, headers, redirect: 'manual', signal: AbortSignal.timeout(15000),
      ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    receiveCookies(response.headers, session);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { /* Static responses need not be JSON. */ }
    return { status: response.status, headers: response.headers, data, text };
  }

  async function signIn(email, { member = true } = {}) {
    const session = { cookies: new Map() };
    const response = await request('/api/auth/sign-in/email', {
      method: 'POST', body: { email, password: PASSWORD }, session,
    });
    expectStatus(response, 200, 'real email sign-in');
    assert.ok(session.cookies.size > 0, 'sign-in returns an actual session cookie');
    const actor = { email, session };
    if (member) {
      const me = await request('/api/me', { session });
      expectStatus(me, 200, 'member identity');
      assert.equal(me.data.user.email, email);
      assert.ok(me.data.team.id);
      assert.ok(me.data.permissions);
      actor.me = me.data;
    }
    return actor;
  }

  async function invitation(admin, email, role = 'editor') {
    const response = await request('/api/invitations', {
      method: 'POST', session: admin.session, body: { email, role },
    });
    expectStatus(response, 201, 'create invitation');
    assert.ok(response.data.item.id);
    const url = new URL(response.data.inviteUrl);
    assert.equal(url.origin, baseURL);
    const token = new URLSearchParams(url.hash.slice(1)).get('invite');
    assert.ok(token, 'invitation URL contains an opaque token');
    return { token, item: response.data.item };
  }

  async function invitedMember(admin, email, role = 'editor') {
    const invite = await invitation(admin, email, role);
    const inspection = await request('/api/invitations/inspect', {
      method: 'POST', body: { token: invite.token },
    });
    expectStatus(inspection, 200, 'inspect invitation');
    assert.equal(inspection.data.email, email);
    assert.equal(inspection.data.role, role);
    assert.ok(Number.isFinite(Date.parse(inspection.data.expiresAt)));
    const registration = await request('/api/invitations/register', {
      method: 'POST', body: { token: invite.token, name: 'Synthetic member', password: PASSWORD },
    });
    expectStatus(registration, [200, 201], 'register invited member');
    assert.equal(registration.data.ok, true);
    return { ...(await signIn(email)), invite };
  }

  async function authIdentity(email) {
    // Create a real auth identity without an application membership. This is
    // solely fixture seeding for existing-user acceptance and tenant isolation.
    const response = await application.auth.api.signUpEmail({
      body: { email, password: PASSWORD, name: 'Synthetic external member' },
      asResponse: true,
    });
    expectStatus({ status: response.status }, [200, 201], 'seed real authentication identity');
    const data = await response.json();
    assert.ok(data.user.id);
    return data.user;
  }

  t.after(async () => {
    if (application) await application.close();
    await rm(directory, { recursive: true, force: true });
  });
  await start();
  const bootstrap = await request('/api/bootstrap', {
    method: 'POST',
    body: {
      token: bootstrapToken,
      teamName: 'Synthetic team',
      name: 'Synthetic administrator',
      email: 'admin@example.com',
      password: PASSWORD,
    },
  });
  expectStatus(bootstrap, [200, 201], 'initial administrator bootstrap');
  assert.equal(bootstrap.data.ok, true);
  const admin = await signIn('admin@example.com');
  assert.equal(admin.me.role, 'admin');

  return {
    get app() { return application; },
    baseURL, bootstrapToken, admin, request, signIn, invitation, invitedMember, authIdentity,
    async restart() {
      const previous = application;
      application = undefined;
      await previous.close();
      await start();
    },
  };
}

async function createProposal(f, actor, title = 'Synthetic proposal', brief = freshBrief()) {
  const response = await f.request('/api/proposals', {
    method: 'POST', session: actor.session, body: { title, brief },
  });
  expectStatus(response, 201, 'create shared proposal');
  assert.equal(response.data.item.title, title);
  assert.equal(response.data.item.status, 'draft');
  assert.ok(Number.isInteger(response.data.item.revision) && response.data.item.revision >= 1);
  assert.deepEqual(response.data.item.brief, brief);
  return response.data.item;
}

async function proposalHistory(f, actor, id) {
  const versions = await f.request(`/api/proposals/${id}/versions`, { session: actor.session });
  const audit = await f.request(`/api/audit?proposalId=${encodeURIComponent(id)}`, { session: actor.session });
  expectStatus(versions, 200, 'proposal versions');
  expectStatus(audit, 200, 'proposal audit');
  assert.ok(Array.isArray(versions.data.items));
  assert.ok(Array.isArray(audit.data.items));
  return { versions: versions.data.items, audit: audit.data.items };
}

async function pausedJsonRequest(f, route, actor, body) {
  const marker = randomUUID();
  const payload = Buffer.from(JSON.stringify(body));
  const split = Math.max(1, Math.floor(payload.length / 2));
  let incoming;
  const seen = new Promise(resolve => {
    function observe(req) {
      if (req.headers['x-integration-slow-request'] !== marker) return;
      incoming = req;
      f.app.server.off('request', observe);
      resolve();
    }
    f.app.server.on('request', observe);
  });
  let client;
  const response = new Promise((resolve, reject) => {
    client = httpRequest(new URL(route, f.baseURL), {
      method: 'POST',
      headers: {
        Origin: f.baseURL,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Connection: 'close',
        Cookie: [...actor.session.cookies].map(([key, value]) => `${key}=${value}`).join('; '),
        'X-Integration-Slow-Request': marker,
      },
    }, result => {
      const chunks = [];
      result.on('data', chunk => chunks.push(chunk));
      result.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* Assert structured failure below. */ }
        resolve({ status: result.statusCode, data });
      });
      result.on('error', reject);
    });
    client.on('error', reject);
  });
  // The rejection is still checked by finish(); avoid an unhandled rejection if
  // setup itself fails and the unfinished native request has to be destroyed.
  response.catch(() => {});
  client.flushHeaders();
  client.write(payload.subarray(0, split));
  try {
    await Promise.race([seen, delay(3000).then(() => { throw Error('slow request did not reach the real server'); })]);
    // Do not consume or mock the IncomingMessage. Wait until the application
    // subscribes to its incomplete body, which occurs after the initial actor
    // check for proposal/invitation writes. Then change the actual membership.
    const deadline = Date.now() + 3000;
    while (incoming.listenerCount('readable') === 0 && incoming.readableFlowing !== true) {
      assert.ok(Date.now() < deadline, 'server has begun awaiting the incomplete request body');
      await delay(5);
    }
    return {
      async finish() { client.end(payload.subarray(split)); return response; },
      abort() { client.destroy(); },
    };
  } catch (error) {
    client.destroy();
    throw error;
  }
}

test('bootstrap is one-time; unauthenticated, cross-origin and public signup requests are rejected', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const again = await f.request('/api/bootstrap', {
    method: 'POST', body: {
      token: f.bootstrapToken, teamName: 'Another team', name: 'Another admin',
      email: 'another-admin@example.com', password: PASSWORD,
    },
  });
  expectError(again, [403, 409], 'bootstrap cannot be repeated');
  for (const route of ['/api/me', '/api/proposals', '/api/team', '/api/audit']) {
    expectError(await f.request(route), 401, 'unauthenticated API access');
  }
  const crossOrigin = await f.request('/api/proposals', {
    method: 'POST', session: f.admin.session, origin: 'https://example.com',
    body: { title: 'Rejected cross-origin proposal', brief: freshBrief() },
  });
  expectError(crossOrigin, 403, 'cross-origin mutation');
  const publicSignup = await f.request('/api/auth/sign-up/email', {
    method: 'POST', body: { email: 'uninvited@example.com', name: 'Uninvited user', password: PASSWORD },
  });
  expectError(publicSignup, [403, 404], 'public signup is disabled');
  const proposals = await f.request('/api/proposals', { session: f.admin.session });
  assert.equal(proposals.data.items.length, 0, 'rejected writes created no proposals');
});

test('two members share proposals; revision conflicts do not overwrite; viewers cannot mutate', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const editor = await f.invitedMember(f.admin, 'editor@example.com', 'editor');
  const viewer = await f.invitedMember(f.admin, 'viewer@example.com', 'viewer');
  assert.equal(editor.me.team.id, f.admin.me.team.id);
  assert.equal(viewer.me.role, 'viewer');
  const original = await createProposal(f, f.admin);
  assert.equal(original.createdBy.id, f.admin.me.user.id);
  const shared = await f.request('/api/proposals', { session: editor.session });
  assert.ok(shared.data.items.some(item => item.id === original.id));
  const before = await proposalHistory(f, f.admin, original.id);
  assert.ok(before.versions.length >= 1 && before.audit.length >= 1);

  const editedBrief = freshBrief({ audienceDirection: 'Changed by a second real member' });
  const update = await f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: editor.session,
    body: { expectedRevision: original.revision, title: 'Updated by editor', brief: editedBrief },
  });
  expectStatus(update, 200, 'editor update');
  const committed = update.data.item;
  assert.equal(committed.revision, original.revision + 1);
  assert.equal(committed.createdBy.id, f.admin.me.user.id);
  assert.equal(committed.updatedBy.id, editor.me.user.id);
  assert.deepEqual(committed.brief, editedBrief);
  const after = await proposalHistory(f, f.admin, original.id);
  assert.equal(after.versions.length, before.versions.length + 1);
  assert.equal(after.audit.length, before.audit.length + 1);

  const stale = await f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: f.admin.session,
    body: { expectedRevision: original.revision, title: 'Must not overwrite', brief: freshBrief() },
  });
  expectError(stale, 409, 'stale revision');
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(stale.data.current.item, committed);
  const afterConflict = await proposalHistory(f, f.admin, original.id);
  assert.deepEqual(afterConflict, after, 'conflict must not append a version or commit audit');
  const current = await f.request('/api/proposals', { session: f.admin.session });
  assert.deepEqual(current.data.items.find(item => item.id === original.id), committed);

  const race = await Promise.all([f.admin, editor].map((actor, index) => f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: actor.session,
    body: { expectedRevision: committed.revision, title: `Concurrent edit ${index}`, brief: freshBrief() },
  })));
  const winning = race.filter(response => response.status === 200);
  const rejected = race.filter(response => response.status === 409);
  assert.equal(winning.length, 1, 'only one simultaneous edit may commit');
  assert.equal(rejected.length, 1, 'the simultaneous stale edit receives a conflict');
  assert.equal(rejected[0].data.error.code, 'REVISION_CONFLICT');
  assert.deepEqual(rejected[0].data.current.item, winning[0].data.item);
  const afterRace = await proposalHistory(f, f.admin, original.id);
  assert.equal(afterRace.versions.length, after.versions.length + 1);
  assert.equal(afterRace.audit.length, after.audit.length + 1);

  expectStatus(await f.request('/api/proposals', { session: viewer.session }), 200, 'viewer reads shared proposals');
  const viewerMe = await f.request('/api/me', { session: viewer.session });
  assert.equal(viewerMe.data.permissions.canEdit, false);
  assert.equal(viewerMe.data.permissions.canManage, false);
  expectStatus(await f.request(`/api/proposals/${original.id}`, { session: viewer.session }), 200, 'viewer reads a proposal');
  const viewerHistory = await proposalHistory(f, viewer, original.id);
  assert.deepEqual(viewerHistory, afterRace, 'viewer reads the same immutable history');
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: viewer.session, body: { title: 'Viewer write', brief: freshBrief() },
  }), 403, 'viewer create');
  expectError(await f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: viewer.session,
    body: { expectedRevision: committed.revision, title: 'Viewer overwrite', brief: freshBrief(), status: 'archived' },
  }), 403, 'viewer update/archive');
  expectError(await f.request('/api/invitations', {
    method: 'POST', session: editor.session, body: { email: 'not-authorized@example.com', role: 'admin' },
  }), 403, 'editor cannot invite an administrator');
  const pending = await f.invitation(f.admin, 'pending-for-readonly-test@example.com', 'viewer');
  expectError(await f.request(`/api/invitations/${pending.item.id}`, {
    method: 'DELETE', session: viewer.session,
  }), 403, 'viewer cannot revoke invitations');
  expectError(await f.request(`/api/members/${f.admin.me.user.id}`, {
    method: 'PATCH', session: viewer.session, body: { status: 'disabled' },
  }), 403, 'viewer cannot disable an administrator');
  expectError(await f.request('/api/invitations', {
    method: 'POST', session: viewer.session, body: { email: 'viewer-invite@example.com', role: 'viewer' },
  }), 403, 'viewer cannot invite other viewers');
  const readonlyTeam = await f.request('/api/team', { session: viewer.session });
  expectStatus(readonlyTeam, 200, 'viewer sees its team directory');
  assert.deepEqual(readonlyTeam.data.invitations, [], 'pending invitations are admin-only');
  expectError(await f.request(`/api/members/${editor.me.user.id}`, {
    method: 'PATCH', session: editor.session, body: { role: 'admin' },
  }), 403, 'editor cannot promote self');
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: editor.session,
    body: { title: 'Forged execution fields', brief: { ...freshBrief(), executor: 'forged', reviewer: 'forged' } },
  }), 400, 'brief rejects client-owned execution fields');
  const archived = await f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: editor.session,
    body: {
      expectedRevision: winning[0].data.item.revision,
      title: 'Archived by editor', brief: freshBrief(), status: 'archived',
    },
  });
  expectStatus(archived, 200, 'editor archives the proposal');
  assert.equal(archived.data.item.status, 'archived');
  const afterArchive = await proposalHistory(f, f.admin, original.id);
  assert.equal(afterArchive.versions.length, afterRace.versions.length + 1);
  assert.equal(afterArchive.audit.length, afterRace.audit.length + 1);
});

test('proposal, immutable version and audit commit atomically when audit insertion fails', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const original = await createProposal(f, f.admin, 'Atomic transaction');
  const before = await proposalHistory(f, f.admin, original.id);
  f.app.db.exec(`CREATE TRIGGER integration_abort_audit BEFORE INSERT ON app_audit
    BEGIN SELECT RAISE(ABORT, 'integration audit failure'); END;`);
  let failed;
  try {
    failed = await f.request(`/api/proposals/${original.id}`, {
      method: 'PATCH', session: f.admin.session,
      body: { expectedRevision: original.revision, title: 'Must roll back', brief: freshBrief({ country: 'CA' }) },
    });
  } finally {
    f.app.db.exec('DROP TRIGGER integration_abort_audit');
  }
  expectError(failed, [500, 503], 'actual SQLite audit failure');
  const list = await f.request('/api/proposals', { session: f.admin.session });
  assert.deepEqual(list.data.items.find(item => item.id === original.id), original);
  assert.deepEqual(await proposalHistory(f, f.admin, original.id), before, 'no partial version or audit survived');
});

test('invitation revocation and consumption are enforced; existing identity must accept as itself', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const revoked = await f.invitation(f.admin, 'revoked@example.com');
  expectStatus(await f.request(`/api/invitations/${revoked.item.id}`, {
    method: 'DELETE', session: f.admin.session,
  }), [200, 204], 'revoke pending invitation');
  expectError(await f.request('/api/invitations/inspect', {
    method: 'POST', body: { token: revoked.token },
  }), [400, 403, 404, 410], 'revoked invitation inspection');
  expectError(await f.request('/api/invitations/register', {
    method: 'POST', body: { token: revoked.token, name: 'Revoked member', password: PASSWORD },
  }), [400, 403, 404, 409, 410], 'revoked invitation registration');

  const joined = await f.invitedMember(f.admin, 'joined@example.com');
  expectError(await f.request('/api/invitations/register', {
    method: 'POST', body: { token: joined.invite.token, name: 'Repeated member', password: PASSWORD },
  }), [400, 403, 404, 409, 410], 'consumed invitation cannot register again');
  expectError(await f.request('/api/invitations/accept', {
    method: 'POST', session: joined.session, body: { token: joined.invite.token },
  }), [400, 403, 404, 409, 410], 'consumed invitation cannot be accepted again');

  const existingUser = await f.authIdentity('existing@example.com');
  const existing = await f.signIn('existing@example.com', { member: false });
  expectError(await f.request('/api/me', { session: existing.session }), 403, 'unjoined real identity has no team access');
  const invite = await f.invitation(f.admin, 'existing@example.com', 'viewer');
  expectError(await f.request('/api/invitations/accept', {
    method: 'POST', body: { token: invite.token },
  }), 401, 'existing identity acceptance requires login');
  expectError(await f.request('/api/invitations/accept', {
    method: 'POST', session: f.admin.session, body: { token: invite.token },
  }), 403, 'a different logged-in user cannot accept');
  const accepted = await f.request('/api/invitations/accept', {
    method: 'POST', session: existing.session, body: { token: invite.token },
  });
  expectStatus(accepted, [200, 201], 'existing identity joins with its own session');
  const me = await f.request('/api/me', { session: existing.session });
  expectStatus(me, 200, 'accepted existing member');
  assert.equal(me.data.user.id, existingUser.id);
  assert.equal(me.data.team.id, f.admin.me.team.id);
  assert.equal(me.data.role, 'viewer');
});

test('member disablement and role changes apply to existing cookies; final administrator is protected', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const editor = await f.invitedMember(f.admin, 'disabled-editor@example.com');
  const disabled = await f.request(`/api/members/${editor.me.user.id}`, {
    method: 'PATCH', session: f.admin.session, body: { status: 'disabled' },
  });
  expectStatus(disabled, 200, 'disable editor');
  expectError(await f.request('/api/me', { session: editor.session }), 403, 'disabled cookie identity');
  expectError(await f.request('/api/proposals', { session: editor.session }), 403, 'disabled cookie read');
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: editor.session, body: { title: 'Disabled write', brief: freshBrief() },
  }), 403, 'disabled cookie write');

  for (const body of [{ role: 'editor' }, { status: 'disabled' }]) {
    expectError(await f.request(`/api/members/${f.admin.me.user.id}`, {
      method: 'PATCH', session: f.admin.session, body,
    }), [400, 403, 409], 'last active administrator cannot be removed');
  }
  const stillAdmin = await f.request('/api/me', { session: f.admin.session });
  assert.equal(stillAdmin.data.role, 'admin');
  const adminCount = f.app.db.prepare("SELECT COUNT(*) AS count FROM app_member WHERE team_id = ? AND role = 'admin' AND status = 'active'").get(f.admin.me.team.id);
  assert.equal(Number(adminCount.count), 1);

  const secondAdmin = await f.invitedMember(f.admin, 'second-admin@example.com', 'admin');
  expectStatus(await f.request(`/api/members/${f.admin.me.user.id}`, {
    method: 'PATCH', session: secondAdmin.session, body: { role: 'viewer' },
  }), 200, 'demote a non-final administrator');
  const changed = await f.request('/api/me', { session: f.admin.session });
  assert.equal(changed.data.role, 'viewer', 'existing session reads current database role');
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: f.admin.session, body: { title: 'Stale admin claim', brief: freshBrief() },
  }), 403, 'old admin cookie cannot retain write permission');
});

test('separate teams in one real database cannot read, edit or inspect each other proposals', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const original = await createProposal(f, f.admin, 'First team private draft');
  const user = await f.authIdentity('other-team@example.com');
  const teamId = randomUUID();
  const now = new Date().toISOString();
  f.app.db.prepare('INSERT INTO app_team (id, name, created_at) VALUES (?, ?, ?)').run(teamId, 'Second synthetic team', now);
  f.app.db.prepare('INSERT INTO app_member (user_id, team_id, role, status, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, teamId, 'admin', 'active', now);
  const other = await f.signIn('other-team@example.com');
  assert.equal(other.me.team.id, teamId);
  const foreign = await createProposal(f, other, 'Second team private draft');
  const firstList = await f.request('/api/proposals', { session: f.admin.session });
  const secondList = await f.request('/api/proposals', { session: other.session });
  assert.ok(!firstList.data.items.some(item => item.id === foreign.id));
  assert.ok(!secondList.data.items.some(item => item.id === original.id));
  expectError(await f.request(`/api/proposals/${original.id}`, {
    method: 'PATCH', session: other.session,
    body: { expectedRevision: 9999, title: 'Cross-team overwrite', brief: freshBrief() },
  }), [403, 404], 'tenant check precedes revision conflict disclosure');
  expectError(await f.request(`/api/proposals/${original.id}/versions`, {
    session: other.session,
  }), [403, 404], 'cross-team version history');
  const foreignAudit = await f.request(`/api/audit?proposalId=${original.id}`, { session: other.session });
  if (foreignAudit.status === 200) assert.deepEqual(foreignAudit.data.items, []);
  else expectError(foreignAudit, [403, 404], 'cross-team audit');
  const team = await f.request('/api/team', { session: other.session });
  expectStatus(team, 200, 'second team directory');
  assert.equal(team.data.team.id, teamId);
  assert.ok(!JSON.stringify(team.data).includes('admin@example.com'), 'team directory must not expose another team');
});

test('strict proposal schema rejects invalid data and client-owned execution fields without committing', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const original = await createProposal(f, f.admin, 'Schema baseline');
  const before = await proposalHistory(f, f.admin, original.id);
  const invalidCreates = [
    ['empty title', { title: '', brief: freshBrief() }],
    ['title length', { title: 'x'.repeat(121), brief: freshBrief() }],
    ['title control character', { title: 'invalid\u0000title', brief: freshBrief() }],
    ['non-object brief', { title: 'Invalid input', brief: [] }],
    ['null brief', { title: 'Invalid input', brief: null }],
    ['unknown platform', { title: 'Invalid input', brief: freshBrief({ platforms: ['Unknown'] }) }],
    ['duplicate platforms', { title: 'Invalid input', brief: freshBrief({ platforms: ['Google', 'Google'] }) }],
    ['non-array platforms', { title: 'Invalid input', brief: freshBrief({ platforms: 'Google' }) }],
    ['negative budget', { title: 'Invalid input', brief: freshBrief({ budgets: { Google: -0.01 } }) }],
    ['budget upper bound', { title: 'Invalid input', brief: freshBrief({ budgets: { Google: 100000.01 } }) }],
    ['budget precision', { title: 'Invalid input', brief: freshBrief({ budgets: { Google: 0.001 } }) }],
    ['string budget', { title: 'Invalid input', brief: freshBrief({ budgets: { Google: '60' } }) }],
    ['unknown budget platform', { title: 'Invalid input', brief: freshBrief({ budgets: { Unknown: 60 } }) }],
    ['unknown operation', { title: 'Invalid input', brief: freshBrief({ operation: 'execute' }) }],
    ['unknown objective', { title: 'Invalid input', brief: freshBrief({ objective: 'purchase-anything' }) }],
    ['group targets several platforms', { title: 'Invalid input', brief: freshBrief({ operation: 'new_group', platforms: ['Google', 'Meta'] }) }],
    ['mismatched parent', { title: 'Invalid input', brief: freshBrief({ operation: 'new_group', parentCampaign: { platform: 'Meta', accountId: 'SYNTHETIC-ACCOUNT', campaignId: 'SYNTHETIC-CAMPAIGN', name: 'Synthetic parent' } }) }],
    ['parent has client-owned status', { title: 'Invalid input', brief: freshBrief({ operation: 'new_group', parentCampaign: { platform: 'Google', accountId: 'SYNTHETIC-ACCOUNT', campaignId: 'SYNTHETIC-CAMPAIGN', name: 'Synthetic parent', status: 'running' } }) }],
    ['invalid time format', { title: 'Invalid input', brief: freshBrief({ startAt: 'not a date' }) }],
    ['impossible calendar date', { title: 'Invalid input', brief: freshBrief({ startAt: '2026-02-30T09:00' }) }],
    ['non-leap February', { title: 'Invalid input', brief: freshBrief({ startAt: '2026-02-29T09:00' }) }],
    ['April has no day 31', { title: 'Invalid input', brief: freshBrief({ startAt: '2026-04-31T09:00' }) }],
    ['hour 24 is not an input hour', { title: 'Invalid input', brief: freshBrief({ startAt: '2026-01-01T24:00' }) }],
    ['invalid time zone', { title: 'Invalid input', brief: freshBrief({ timeZone: 'Invalid/Zone' }) }],
    ['audience length', { title: 'Invalid input', brief: freshBrief({ audienceDirection: 'x'.repeat(2001) }) }],
    ['forged brief approval', { title: 'Invalid input', brief: { ...freshBrief(), reviewer: 'forged', status: 'approved', version: 99 } }],
    ['forged proposal actor', { title: 'Invalid input', brief: freshBrief(), createdBy: 'forged' }],
  ];
  for (const [label, body] of invalidCreates) {
    expectError(await f.request('/api/proposals', {
      method: 'POST', session: f.admin.session, body,
    }), 400, label);
  }
  for (const expectedRevision of [0, -1, 1.5, '1', null]) {
    expectError(await f.request(`/api/proposals/${original.id}`, {
      method: 'PATCH', session: f.admin.session,
      body: { expectedRevision, title: 'Invalid revision' },
    }), 400, 'invalid revision value');
  }
  for (const change of [{}, { status: 'approved' }, { status: 'running' }, { reviewer: 'forged' }, { title: ' ' }]) {
    expectError(await f.request(`/api/proposals/${original.id}`, {
      method: 'PATCH', session: f.admin.session, body: { expectedRevision: original.revision, ...change },
    }), 400, 'invalid or empty proposal update');
  }
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: f.admin.session, contentType: 'text/plain', rawBody: '{}',
  }), 415, 'JSON content type is required');
  expectError(await f.request('/api/proposals', {
    method: 'POST', session: f.admin.session, rawBody: '{',
  }), 400, 'malformed JSON');
  const list = await f.request('/api/proposals', { session: f.admin.session });
  assert.equal(list.data.items.length, 1, 'invalid creates did not persist any record');
  assert.deepEqual(list.data.items[0], original);
  assert.deepEqual(await proposalHistory(f, f.admin, original.id), before);
  const defaults = await f.request('/api/proposals', {
    method: 'POST', session: f.admin.session, body: { title: 'Draft with defaults', brief: {} },
  });
  expectStatus(defaults, 201, 'an incomplete draft may use explicit server defaults');
  assert.deepEqual(defaults.data.item.brief.platforms, []);
  assert.equal(defaults.data.item.status, 'draft');
  const leapBrief = freshBrief({ startAt: '2028-02-29T09:00:30', budgets: { Google: 60.25 } });
  const validLeapDay = await createProposal(f, f.admin, 'Valid leap day and decimal amount', leapBrief);
  assert.deepEqual(validLeapDay.brief, leapBrief);
});

test('slow HTTP bodies cannot retain permissions or a session revoked while the request is in flight', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const editor = await f.invitedMember(f.admin, 'slow-editor@example.com');
  const slowProposal = await pausedJsonRequest(f, '/api/proposals', editor, {
    title: 'Must not persist after disablement', brief: freshBrief(),
  });
  try {
    expectStatus(await f.request(`/api/members/${editor.me.user.id}`, {
      method: 'PATCH', session: f.admin.session, body: { status: 'disabled' },
    }), 200, 'another administrator disables the slow request actor');
    expectError(await slowProposal.finish(), 403, 'disabled actor cannot finish a previously authorized request');
  } finally { slowProposal.abort(); }
  const proposals = await f.request('/api/proposals', { session: f.admin.session });
  assert.deepEqual(proposals.data.items, [], 'disabled slow request did not commit a proposal');

  expectStatus(await f.request(`/api/members/${editor.me.user.id}`, {
    method: 'PATCH', session: f.admin.session, body: { role: 'admin', status: 'active' },
  }), 200, 'grant real administrator role for the next race');
  const slowInvitation = await pausedJsonRequest(f, '/api/invitations', editor, {
    email: 'must-not-be-invited@example.com', role: 'editor',
  });
  try {
    expectStatus(await f.request(`/api/members/${editor.me.user.id}`, {
      method: 'PATCH', session: f.admin.session, body: { role: 'viewer' },
    }), 200, 'administrator is downgraded during its incomplete invite request');
    expectError(await slowInvitation.finish(), 403, 'downgraded actor cannot finish an administrator write');
  } finally { slowInvitation.abort(); }
  const invitationCount = f.app.db.prepare('SELECT COUNT(*) AS count FROM app_invitation WHERE email = ?').get('must-not-be-invited@example.com');
  assert.equal(Number(invitationCount.count), 0, 'no invitation was stored after privilege revocation');

  await f.authIdentity('slow-existing@example.com');
  const existing = await f.signIn('slow-existing@example.com', { member: false });
  const invite = await f.invitation(f.admin, 'slow-existing@example.com', 'viewer');
  const slowAcceptance = await pausedJsonRequest(f, '/api/invitations/accept', existing, { token: invite.token });
  try {
    expectStatus(await f.request('/api/auth/sign-out', {
      method: 'POST', session: existing.session, body: {},
    }), 200, 'revoke the exact real session while acceptance body is incomplete');
    expectError(await slowAcceptance.finish(), 401, 'invitation acceptance checks the post-body session');
  } finally { slowAcceptance.abort(); }
  const inspection = await f.request('/api/invitations/inspect', {
    method: 'POST', body: { token: invite.token },
  });
  expectStatus(inspection, 200, 'failed slow acceptance did not consume the invitation');
  const membershipCount = f.app.db.prepare('SELECT COUNT(*) AS count FROM app_member m JOIN user u ON u.id = m.user_id WHERE u.email = ?').get('slow-existing@example.com');
  assert.equal(Number(membershipCount.count), 0, 'signed-out request did not create membership');
});

test('real sign-in rate limits cannot be bypassed with spoofed proxy or internal IP headers', { timeout: 60000 }, async t => {
  const f = await fixture(t, { rateLimitMax: 3 });
  // Bootstrap's actual successful sign-in has already consumed one request.
  for (let i = 0; i < 2; i++) {
    const response = await f.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'x-forwarded-for': `192.0.2.${i + 1}`, 'x-console-client-ip': `198.51.100.${i + 1}` },
      body: { email: 'admin@example.com', password: 'Incorrect synthetic password!' },
    });
    expectStatus(response, [400, 401], 'incorrect credentials before rate threshold');
  }
  const limited = await f.request('/api/auth/sign-in/email', {
    method: 'POST', headers: { 'x-forwarded-for': '192.0.2.250', 'x-console-client-ip': '198.51.100.250' },
    body: { email: 'admin@example.com', password: PASSWORD },
  });
  expectError(limited, 429, 'spoofed headers cannot reset the real request limit');
  const stillAuthenticated = await f.request('/api/me', { session: f.admin.session });
  expectStatus(stillAuthenticated, 200, 'a sign-in limit does not revoke an existing real session');
});

test('restart restores durable sessions, proposals, versions and audit; private server files are not served', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const original = await createProposal(f, f.admin, 'Survives restart');
  const history = await proposalHistory(f, f.admin, original.id);
  await f.restart();
  const me = await f.request('/api/me', { session: f.admin.session });
  expectStatus(me, 200, 'database-backed cookie survives restart');
  const list = await f.request('/api/proposals', { session: f.admin.session });
  assert.deepEqual(list.data.items.find(item => item.id === original.id), original);
  assert.deepEqual(await proposalHistory(f, f.admin, original.id), history);
  for (const route of [
    '/.local/test.sqlite', '/.local/', '/.git/config', '/.env', '/package.json', '/server/app.mjs',
    '/tests/team.test.mjs', '/scripts/build.py', '/node_modules/better-auth/package.json',
    '/%2e%2e%2fpackage.json', '/%2e%2e%2fserver%2fapp.mjs',
    '/%252e%252e%252fpackage.json', '/..%2fpackage.json',
  ]) {
    const response = await f.request(route, { session: f.admin.session });
    expectStatus(response, [400, 403, 404], 'private static path or encoded traversal is denied');
    assert.ok(!response.text.includes('Synthetic integration passphrase'), 'private source contents were returned');
  }
  for (const route of ['/api/ads/execute', '/api/campaigns/execute', `/api/proposals/${original.id}/execute`]) {
    expectError(await f.request(route, {
      method: 'POST', session: f.admin.session, body: {},
    }), [404, 405], 'no real or simulated advertisement execution API');
  }
});
