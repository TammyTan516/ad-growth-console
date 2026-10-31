// SPDX-License-Identifier: MIT
import {DatabaseSync} from 'node:sqlite';
import {randomUUID, createHash} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {ensure} from './errors.mjs';

export const now = () => new Date().toISOString();
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export function openStore(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_migration (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_team (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS app_member (
      user_id TEXT PRIMARY KEY REFERENCES user(id), team_id TEXT NOT NULL REFERENCES app_team(id),
      role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_invitation (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked')),
      created_by TEXT NOT NULL REFERENCES user(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      accepted_by TEXT REFERENCES user(id), accepted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS app_invite_pending ON app_invitation(team_id,email) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS app_proposal (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), title TEXT NOT NULL,
      brief_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','archived')),
      revision INTEGER NOT NULL CHECK(revision>0), created_by TEXT NOT NULL REFERENCES user(id),
      updated_by TEXT NOT NULL REFERENCES user(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_proposal_team ON app_proposal(team_id,updated_at);
    CREATE TABLE IF NOT EXISTS app_proposal_version (
      proposal_id TEXT NOT NULL REFERENCES app_proposal(id), revision INTEGER NOT NULL,
      team_id TEXT NOT NULL REFERENCES app_team(id), title TEXT NOT NULL, brief_json TEXT NOT NULL,
      status TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES user(id), created_at TEXT NOT NULL,
      PRIMARY KEY(proposal_id,revision)
    );
    CREATE TABLE IF NOT EXISTS app_audit (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES app_team(id), actor_id TEXT NOT NULL REFERENCES user(id),
      action TEXT NOT NULL, proposal_id TEXT, revision INTEGER, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_audit_team ON app_audit(team_id,created_at);
    CREATE TABLE IF NOT EXISTS app_rate_limit (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    INSERT OR IGNORE INTO app_migration VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `);
  // Additive migration keeps existing teams, sessions and proposal history intact.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['app_proposal', 'app_proposal_version']) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'workflow_json')) db.exec(`ALTER TABLE ${table} ADD COLUMN workflow_json TEXT NOT NULL DEFAULT '{}'`);
    }
    db.prepare('INSERT OR IGNORE INTO app_migration VALUES(2,?)').run(now());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  return new Store(db);
}

class Store {
  constructor(db) { this.db = db; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(teamId, actorId, action, proposalId = null, revision = null, detail = {}) {
    this.db.prepare('INSERT INTO app_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), teamId, actorId, action, proposalId, revision, JSON.stringify(detail), now());
  }
  hasTeam() { return Boolean(this.db.prepare('SELECT 1 FROM app_team LIMIT 1').get()); }
  membership(userId) {
    return this.db.prepare('SELECT m.*,t.name AS team_name FROM app_member m JOIN app_team t ON t.id=m.team_id WHERE m.user_id=?').get(userId);
  }
  actor(member, roles) {
    const current = this.membership(member.user_id);
    ensure(current && current.team_id === member.team_id && current.status === 'active', 403, 'MEMBER_DISABLED', '团队访问权限已发生变化，请重新登录。');
    ensure(roles.includes(current.role), 403, 'FORBIDDEN', '当前角色没有执行此操作的权限。');
    return current;
  }
  bootstrap(userId, teamName) {
    return this.transaction(() => {
      ensure(!this.hasTeam(), 409, 'ALREADY_INITIALIZED', '工作区已初始化，请直接登录。');
      const teamId = randomUUID();
      this.db.prepare('INSERT INTO app_team VALUES(?,?,?)').run(teamId, teamName, now());
      this.db.prepare('INSERT INTO app_member VALUES(?,?,?,?,?)').run(userId, teamId, 'admin', 'active', now());
      this.audit(teamId, userId, 'team.created');
      return teamId;
    });
  }
  proposals(teamId) {
    return this.db.prepare('SELECT id FROM app_proposal WHERE team_id=? ORDER BY updated_at DESC,id DESC LIMIT 500').all(teamId).map(r => this.proposal(teamId, r.id));
  }
  proposalCounts(teamId) {
    return this.db.prepare("SELECT count(*) AS total,COALESCE(sum(status='draft'),0) AS draft,COALESCE(sum(status='archived'),0) AS archived FROM app_proposal WHERE team_id=?").get(teamId);
  }
  proposal(teamId, id) {
    const row = this.db.prepare(`SELECT p.*,c.name AS creator_name,u.name AS updater_name FROM app_proposal p JOIN user c ON c.id=p.created_by JOIN user u ON u.id=p.updated_by WHERE p.team_id=? AND p.id=?`).get(teamId, id);
    ensure(row, 404, 'NOT_FOUND', '没有找到该方案，或你无权查看。');
    return {id: row.id, title: row.title, brief: JSON.parse(row.brief_json), workflow: JSON.parse(row.workflow_json), status: row.status, revision: row.revision, createdBy: {id: row.created_by, name: row.creator_name}, updatedBy: {id: row.updated_by, name: row.updater_name}, createdAt: row.created_at, updatedAt: row.updated_at};
  }
  snapshot(teamId, userId, item) {
    this.db.prepare('INSERT INTO app_proposal_version(proposal_id,revision,team_id,title,brief_json,status,actor_id,created_at,workflow_json) VALUES(?,?,?,?,?,?,?,?,?)').run(item.id, item.revision, teamId, item.title, JSON.stringify(item.brief), item.status, userId, item.updatedAt, JSON.stringify(item.workflow || {}));
  }
  createProposal(member, title, brief) {
    return this.transaction(() => {
      this.actor(member, ['admin', 'editor']);
      const id = randomUUID(), date = now();
      this.db.prepare('INSERT INTO app_proposal(id,team_id,title,brief_json,status,revision,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, member.team_id, title, JSON.stringify(brief), 'draft', 1, member.user_id, member.user_id, date, date);
      const item = this.proposal(member.team_id, id);
      this.snapshot(member.team_id, member.user_id, item);
      this.audit(member.team_id, member.user_id, 'proposal.created', id, 1);
      return item;
    });
  }
  updateProposal(member, id, change) {
    return this.transaction(() => {
      this.actor(member, ['admin', 'editor']);
      const before = this.proposal(member.team_id, id);
      ensure(before.revision === change.expectedRevision, 409, 'REVISION_CONFLICT', '同事已保存了更新版本。你的输入仍保留，请先查看最新版本。', {current: {item: before}});
      if (change.beforeSave) change.beforeSave(before);
      const date = now();
      const workflow = change.workflow ?? {...before.workflow, generation: null, tracking: [], review: {status: 'draft', note: '方案内容已更新，请重新核对。'}};
      const result = this.db.prepare('UPDATE app_proposal SET title=?,brief_json=?,status=?,workflow_json=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=? AND team_id=? AND revision=?').run(change.title ?? before.title, JSON.stringify(change.brief ?? before.brief), change.status ?? before.status, JSON.stringify(workflow), member.user_id, date, id, member.team_id, change.expectedRevision);
      ensure(Number(result.changes) === 1, 409, 'REVISION_CONFLICT', '方案版本发生变化，请重新读取。');
      const item = this.proposal(member.team_id, id);
      this.snapshot(member.team_id, member.user_id, item);
      this.audit(member.team_id, member.user_id, change.auditAction || (item.status !== before.status ? 'proposal.status_changed' : 'proposal.updated'), id, item.revision, {changedFields: ['title', 'brief', 'status', 'workflow'].filter(k => JSON.stringify(before[k]) !== JSON.stringify(item[k]))});
      return item;
    });
  }
  versions(teamId, id) {
    this.proposal(teamId, id);
    return this.db.prepare('SELECT v.*,u.name FROM app_proposal_version v JOIN user u ON u.id=v.actor_id WHERE v.team_id=? AND v.proposal_id=? ORDER BY v.revision DESC').all(teamId, id).map(row => ({revision: row.revision, title: row.title, status: row.status, brief: JSON.parse(row.brief_json), workflow: JSON.parse(row.workflow_json), actor: {id: row.actor_id, name: row.name}, createdAt: row.created_at}));
  }
  auditList(teamId, proposalId) {
    if (proposalId) this.proposal(teamId, proposalId);
    return this.db.prepare(`SELECT a.*,u.name FROM app_audit a JOIN user u ON u.id=a.actor_id WHERE a.team_id=? ${proposalId ? 'AND a.proposal_id=?' : ''} ORDER BY a.created_at DESC,a.rowid DESC LIMIT 500`).all(...[teamId, ...(proposalId ? [proposalId] : [])]).map(row => ({id: row.id, action: row.action, actor: {id: row.actor_id, name: row.name}, proposalId: row.proposal_id, revision: row.revision, detail: JSON.parse(row.detail_json), createdAt: row.created_at}));
  }
  team(member) {
    const members = this.db.prepare('SELECT m.user_id AS id,u.name,u.email,m.role,m.status FROM app_member m JOIN user u ON u.id=m.user_id WHERE m.team_id=? ORDER BY m.created_at').all(member.team_id);
    const invitations = member.role === 'admin' ? this.db.prepare('SELECT id,email,role,status,expires_at AS expiresAt FROM app_invitation WHERE team_id=? ORDER BY created_at DESC LIMIT 100').all(member.team_id).map(i => ({...i, status: i.status === 'pending' && i.expiresAt <= now() ? 'expired' : i.status})) : [];
    return {team: {id: member.team_id, name: member.team_name}, members, invitations};
  }
  createInvitation(member, email, role, token) {
    return this.transaction(() => {
      this.actor(member, ['admin']);
      ensure(!this.db.prepare('SELECT 1 FROM app_member m JOIN user u ON u.id=m.user_id WHERE m.team_id=? AND lower(u.email)=?').get(member.team_id, email), 409, 'ALREADY_MEMBER', '该邮箱已是团队成员，请在成员列表管理。');
      const id = randomUUID(), date = now(), expiresAt = new Date(Date.now() + 86400000).toISOString();
      this.db.prepare("UPDATE app_invitation SET status='revoked' WHERE team_id=? AND email=? AND status='pending'").run(member.team_id, email);
      this.db.prepare('INSERT INTO app_invitation(id,team_id,email,role,token_hash,status,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, member.team_id, email, role, tokenHash(token), 'pending', member.user_id, date, expiresAt);
      this.audit(member.team_id, member.user_id, 'invitation.created', null, null, {invitationId: id, role});
      return {id, email, role, status: 'pending', expiresAt};
    });
  }
  invitation(token) {
    ensure(typeof token === 'string' && /^[A-Za-z0-9_-]{40,100}$/.test(token), 400, 'INVALID_INVITATION', '邀请链接无效、已使用或已过期。');
    const row = this.db.prepare('SELECT i.*,t.name AS team_name FROM app_invitation i JOIN app_team t ON t.id=i.team_id WHERE i.token_hash=?').get(tokenHash(token));
    ensure(row && row.status === 'pending' && row.expires_at > now(), 410, 'INVALID_INVITATION', '邀请链接无效、已使用或已过期。');
    return row;
  }
  acceptInvitation(token, user) {
    return this.transaction(() => {
      const invite = this.invitation(token);
      ensure(user.email.toLowerCase() === invite.email, 403, 'INVITATION_EMAIL_MISMATCH', '请使用被邀请的邮箱登录后接受。');
      ensure(!this.membership(user.id), 409, 'ALREADY_MEMBER', '此账号已加入工作区。');
      this.db.prepare('INSERT INTO app_member VALUES(?,?,?,?,?)').run(user.id, invite.team_id, invite.role, 'active', now());
      this.db.prepare("UPDATE app_invitation SET status='accepted',accepted_by=?,accepted_at=? WHERE id=? AND status='pending'").run(user.id, now(), invite.id);
      this.audit(invite.team_id, user.id, 'invitation.accepted', null, null, {invitationId: invite.id, role: invite.role});
    });
  }
  revokeInvitation(member, id) {
    return this.transaction(() => {
      this.actor(member, ['admin']);
      const result = this.db.prepare("UPDATE app_invitation SET status='revoked' WHERE id=? AND team_id=? AND status='pending'").run(id, member.team_id);
      ensure(Number(result.changes) === 1, 404, 'NOT_FOUND', '没有找到可撤销的邀请。');
      this.audit(member.team_id, member.user_id, 'invitation.revoked', null, null, {invitationId: id});
    });
  }
  updateMember(member, id, change) {
    return this.transaction(() => {
      this.actor(member, ['admin']);
      const target = this.db.prepare('SELECT * FROM app_member WHERE user_id=? AND team_id=?').get(id, member.team_id);
      ensure(target, 404, 'NOT_FOUND', '没有找到该成员。');
      const next = {...target, ...change};
      if (target.role === 'admin' && target.status === 'active' && (next.role !== 'admin' || next.status !== 'active')) {
        const {count} = this.db.prepare("SELECT count(*) AS count FROM app_member WHERE team_id=? AND role='admin' AND status='active'").get(member.team_id);
        ensure(count > 1, 409, 'LAST_ADMIN', '请至少保留一位可用的管理员。');
      }
      this.db.prepare('UPDATE app_member SET role=?,status=? WHERE user_id=? AND team_id=?').run(next.role, next.status, id, member.team_id);
      this.audit(member.team_id, member.user_id, 'member.updated', null, null, {memberId: id, before: {role: target.role, status: target.status}, after: {role: next.role, status: next.status}});
    });
  }
  consumeLimit(key, max, windowMs) {
    return this.transaction(() => {
      const time = Date.now();
      this.db.prepare('DELETE FROM app_rate_limit WHERE expires<?').run(time);
      const row = this.db.prepare('SELECT * FROM app_rate_limit WHERE key=?').get(key);
      ensure(!row || row.count < max, 429, 'RATE_LIMITED', '操作过于频繁，请稍后再试。');
      this.db.prepare('INSERT INTO app_rate_limit VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, 1, time + windowMs);
    });
  }
}
