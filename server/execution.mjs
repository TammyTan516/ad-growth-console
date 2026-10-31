// SPDX-License-Identifier: MIT
// Browser actions happen only in a separately authorized desktop Codex/Cua session.
// This module owns frozen instructions, leases, publication checkpoints and evidence.
import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {ensure, AppError} from './errors.mjs';
import {fields, text, revision, PLATFORMS} from './validation.mjs';
import {tokenHash} from './store.mjs';
import {validateExecutionConfiguration} from './execution-validation.mjs';

const EDIT = ['admin', 'editor'];
const HOSTS = {Google: ['ads.google.com'], Meta: ['adsmanager.facebook.com', 'business.facebook.com'], TikTok: ['ads.tiktok.com']};
const STAGES = ['preflight', 'before_publish', 'after_publish', 'before_enable', 'after_enable', 'reconcile'];
const MAX_IMAGE = 3 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function platformURL(value, platform) {
  let url; try {url = new URL(value);} catch {throw new AppError(400, 'INVALID_PLATFORM_URL', '请保存当前广告后台的完整地址。');}
  ensure(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && HOSTS[platform]?.includes(url.hostname), 400, 'INVALID_PLATFORM_URL', '截图和对象地址必须属于本次平台的广告后台。');
  ensure(![...url.searchParams.keys()].some(k => /^(?:access_token|refresh_token|token|password|session|authorization|code|api_key|secret)$/i.test(k)) && !/(?:access_token|refresh_token|password|authorization)=/i.test(url.hash), 400, 'INVALID_PLATFORM_URL', '后台地址不能包含登录密钥或临时授权码。');
  ensure(url.href.length <= 4096, 400, 'INVALID_PLATFORM_URL', '广告后台地址过长。'); return url.href;
}
function objectList(value, platform) {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 3, 400, 'INVALID_OBJECTS', '请逐层核对并回填本任务创建的对象。');
  return value.map(item => {
    fields(item, ['level', 'id', 'parentId', 'status', 'url']);
    ensure(['campaign', 'adGroup', 'ad'].includes(item.level) && ['paused', 'enabled', 'unknown'].includes(item.status), 400, 'INVALID_OBJECTS', '对象层级或开关状态不正确。');
    const id = text(item.id, '平台对象编号', 100, true), parentId = text(item.parentId || '', '父对象编号', 100);
    ensure(/^[a-zA-Z0-9_-]+$/.test(id) && (!parentId || /^[a-zA-Z0-9_-]+$/.test(parentId)), 400, 'INVALID_OBJECTS', '平台对象编号格式不正确。');
    return {level: item.level, id, parentId, status: item.status, url: platformURL(item.url, platform)};
  });
}
export function createExecution({store, planning, resources, connectors, dataDir, clock = Date.now}) {
  const db = store.db, directory = join(resolve(dataDir), 'execution-evidence');
  const stamp = () => new Date(clock()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_build (
      id TEXT PRIMARY KEY,team_id TEXT NOT NULL REFERENCES app_team(id),owner_id TEXT NOT NULL REFERENCES user(id),
      connector_id TEXT NOT NULL REFERENCES app_connector(id),proposal_id TEXT NOT NULL REFERENCES app_proposal(id),
      proposal_revision INTEGER NOT NULL,kind TEXT NOT NULL,parent_id TEXT,status TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,targets_json TEXT NOT NULL,lease_hash TEXT,lease_expires INTEGER,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_build_team ON app_build(team_id,created_at);
    CREATE TABLE IF NOT EXISTS app_build_event (
      id TEXT PRIMARY KEY,build_id TEXT NOT NULL REFERENCES app_build(id),actor_id TEXT NOT NULL REFERENCES user(id),
      action TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_build_evidence (
      id TEXT PRIMARY KEY,build_id TEXT NOT NULL REFERENCES app_build(id),team_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,platform TEXT NOT NULL,stage TEXT NOT NULL,mime TEXT NOT NULL,
      filename TEXT NOT NULL,sha256 TEXT NOT NULL,url TEXT NOT NULL,caption TEXT NOT NULL,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_build_preview (
      id TEXT PRIMARY KEY,build_id TEXT NOT NULL REFERENCES app_build(id),owner_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,expires_at INTEGER NOT NULL,consumed_at TEXT,created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_execution_object (
      build_id TEXT NOT NULL REFERENCES app_build(id),team_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL,
      level TEXT NOT NULL,object_id TEXT NOT NULL,PRIMARY KEY(team_id,platform,account_id,level,object_id)
    );
  `);
  const actor = member => store.actor(member, EDIT);
  const raw = id => {
    const row = db.prepare('SELECT * FROM app_build WHERE id=?').get(id);
    ensure(row, 404, 'BUILD_NOT_FOUND', '没有找到该搭建任务。'); return row;
  };
  const targetsOf = row => JSON.parse(row.targets_json);
  const snapshotOf = row => JSON.parse(row.snapshot_json);
  function scoped(member, id, owner = false) {
    const row = raw(id);
    ensure(row.team_id === member.team_id && (!owner || row.owner_id === member.user_id), 404, 'BUILD_NOT_FOUND', '没有找到你可以操作的搭建任务。'); return row;
  }
  function event(member, row, action, detail = {}) {
    db.prepare('INSERT INTO app_build_event VALUES(?,?,?,?,?,?)').run(randomUUID(), row.id, member.user_id, action, JSON.stringify(detail), stamp());
    store.audit(row.team_id, member.user_id, action, row.proposal_id, row.proposal_revision, {buildId: row.id, ...detail});
  }
  function aggregate(kind, targets) {
    const values = targets.map(t => t.status), done = kind === 'enable' ? 'enabled_verified' : 'paused_verified';
    if (values.every(v => v === 'enabled_verified')) return 'enabled_verified';
    if (values.every(v => v === done)) return done;
    if (values.every(v => v === 'cancelled')) return 'cancelled';
    if (kind === 'enable' && values.every(v => ['enabled_verified','failed','blocked','cancelled'].includes(v))) return 'failed';
    if (values.includes('unknown')) return 'unknown';
    if (values.includes('publishing')) return 'running';
    if (values.some(v => ['paused_verified', 'enabled_verified'].includes(v))) return 'partially_created';
    if (values.includes('needs_attention')) return 'needs_attention';
    if (values.every(v => ['blocked', 'failed', 'cancelled'].includes(v))) return values.includes('failed') ? 'failed' : 'blocked';
    return values.some(v => ['claimed', 'preflight_checked'].includes(v)) ? 'running' : 'queued';
  }
  function writeTargets(member, row, targets, action, detail = {}) {
    actor(member);
    const status = aggregate(row.kind, targets);
    db.prepare('UPDATE app_build SET targets_json=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(targets), status, stamp(), row.id);
    event(member, row, action, detail); return raw(row.id);
  }
  function publicBuild(row) {
    const owner = db.prepare('SELECT name FROM user WHERE id=?').get(row.owner_id), targets = targetsOf(row);
    return {id: row.id, proposalId: row.proposal_id, proposalTitle: snapshotOf(row).title, proposalRevision: row.proposal_revision, owner: {id: row.owner_id, name: owner?.name || '成员'}, connectorId: row.connector_id, kind: row.kind, parentBuildId: row.parent_id, status: row.status, targets: targets.map(t => ({platform: t.platform, status: t.status, reason: t.reason || '', objects: t.objects || [], lastObservedAt: t.lastObservedAt || null})), createdAt: row.created_at, updatedAt: row.updated_at};
  }
  function expire() {
    store.transaction(() => {
      for (const row of db.prepare("SELECT * FROM app_build WHERE lease_expires IS NOT NULL AND lease_expires<?").all(clock())) {
        const targets = targetsOf(row), changed = targets.some(t => ['publishing', 'claimed', 'preflight_checked'].includes(t.status));
        if (changed) {
          for (const t of targets) if (t.status === 'publishing') {t.status = 'unknown'; t.reason = '提交阶段连接中断，必须先核对平台是否已经创建或启用。';}
          else if (['claimed', 'preflight_checked'].includes(t.status)) {t.status = 'needs_attention'; t.reason = '桌面会话失去响应，请重新领取并核对。';}
          // Lease expiry is a system observation, not new spend authorization.
          db.prepare('UPDATE app_build SET targets_json=?,status=?,updated_at=? WHERE id=?').run(JSON.stringify(targets), aggregate(row.kind, targets), stamp(), row.id);
          db.prepare('INSERT INTO app_build_event VALUES(?,?,?,?,?,?)').run(randomUUID(), row.id, row.owner_id, 'build.lease_expired', JSON.stringify({automatic: true}), stamp());
        }
        db.prepare('UPDATE app_build SET lease_expires=NULL,lease_hash=NULL WHERE id=?').run(row.id);
      }
    });
  }
  function ready(member, id, expectedRevision) {
    const value = planning.read(member, id);
    ensure(value.item.revision === revision(expectedRevision), 409, 'REVISION_CONFLICT', '方案版本已变化，请核对最新版本后重新审核。', {current: {item: value.item}});
    ensure(value.item.status !== 'archived' && value.workflow.review.status === 'approved' && !value.workflow.warnings.length, 409, 'REVIEW_REQUIRED', '本次搭建或启用需要当前版本的人工审核通过。');
    resources.validateCurrent(member.team_id, value.workflow.selection);
    const configuration = validateExecutionConfiguration(value.workflow.executionConfiguration || {targets: []}, value.item.brief, value.workflow.selectionSnapshot, value.workflow.content, {complete: true});
    return {...value, configuration};
  }
  function current(member, row) { return ready(member, row.proposal_id, row.proposal_revision); }
  function target(row, platform) {
    const targets = targetsOf(row), item = targets.find(t => t.platform === platform);
    ensure(item, 400, 'INVALID_PLATFORM', '此任务不包含该平台。'); return {targets, item};
  }
  function lease(req, id, token) {
    const {connector, member} = connectors.authenticate(req), row = scoped(member, id, true);
    ensure(connector.status === 'active' && connector.id === row.connector_id, 403, 'BROWSER_CONNECTOR_FORBIDDEN', '请使用本任务发起人确认过的连接。');
    ensure(row.status !== 'cancelled', 409, 'BUILD_FINISHED', '该任务已取消，请回到工作区查看。');
    ensure(typeof token === 'string' && token.length >= 40 && token.length <= 100 && row.lease_hash === tokenHash(token) && row.lease_expires >= clock(), 409, 'BUILD_LEASE_INVALID', '桌面任务领取已失效，请重新领取并先核对平台状态。');
    return {member, connector, row};
  }
  function proof(row, platform, ids, stages, {recent = true, afterSequence = -1} = {}) {
    ensure(Array.isArray(ids) && ids.length > 0 && ids.length <= 10 && new Set(ids).size === ids.length, 400, 'EVIDENCE_REQUIRED', '请附上本次浏览器实际核对的截图。');
    const found = ids.map(id => db.prepare('SELECT *,rowid AS sequence FROM app_build_evidence WHERE id=? AND build_id=? AND platform=?').get(id, row.id, platform));
    ensure(found.every(Boolean) && (!recent || found.every(e => Date.parse(e.created_at) >= clock() - 10 * 60000)), 400, 'EVIDENCE_REQUIRED', '证据不属于本次任务、平台，或已经过期，请重新核对。');
    ensure(found.every(e => e.sequence > afterSequence), 400, 'EVIDENCE_REQUIRED', '请在本次提交之后重新截图核对结果。');
    ensure(stages.every(stage => found.some(e => e.stage === stage)), 400, 'EVIDENCE_REQUIRED', '请补充本阶段要求的浏览器截图。'); return found;
  }
  function checkObjects(row, platform, value, requiredState, {partial = false} = {}) {
    const objects = objectList(value, platform), snapshot = snapshotOf(row), by = Object.fromEntries(objects.map(o => [o.level, o]));
    ensure(new Set(objects.map(o => o.level)).size === objects.length, 400, 'OBJECT_HIERARCHY_REQUIRED', '请回填各层不同的对象编号。');
    ensure(!partial || (row.kind === 'create_paused' && platform === 'Google'), 400, 'PARTIAL_SCOPE_UNSUPPORTED', '分步核对仅适用于本任务的 Google 暂停搭建。');
    if (!partial) ensure(by.adGroup && by.ad, 400, 'OBJECT_HIERARCHY_REQUIRED', '请回填广告组和广告的不同编号。');
    const parentId = snapshot.brief.operation === 'new_group' ? snapshot.brief.parentCampaign.campaignId : by.campaign?.id;
    ensure(parentId && (!by.adGroup || by.adGroup.parentId === parentId) && (!by.ad || (by.adGroup && by.ad.parentId === by.adGroup.id)), 400, 'OBJECT_HIERARCHY_REQUIRED', '对象的父计划、广告组和广告层级不匹配。');
    ensure(snapshot.brief.operation === 'new_group' ? !by.campaign && by.adGroup && (partial || objects.length === 2) : by.campaign && !by.campaign.parentId && (partial || objects.length === 3), 400, 'OBJECT_SCOPE_MISMATCH', '新增组只能记录新组和新广告，不能接管或修改已有父计划。');
    const gate = snapshot.brief.operation === 'new_group' ? by.adGroup : by.campaign;
    ensure(gate.status === requiredState && objects.every(o => requiredState === 'enabled' ? o.status === 'enabled' : o.status !== 'unknown'), 400, 'OBJECT_STATE_UNVERIFIED', requiredState === 'paused' ? '没有核对到暂停的计划或新广告组，不能标记创建完成。' : '没有核对到全部新建对象的启用状态，不能标记启用完成。');
    const knownObjects = target(row, platform).item.objects;
    if (row.kind === 'enable' || knownObjects?.length) {
      const expected = row.kind === 'enable' ? target(raw(row.parent_id), platform).item.objects : knownObjects;
      ensure((row.kind !== 'enable' || objects.length === expected.length) && expected.every(known => objects.some(o => o.level === known.level && o.id === known.id && o.parentId === known.parentId)), 400, 'OBJECT_SCOPE_MISMATCH', '核对和启用只能记录原有编号，不能重建、替换或丢弃已确认的广告。');
    }
    return objects;
  }
  function recordObjects(row, platform, objects) {
    const accountId = snapshotOf(row).configuration.targets.find(t => t.platform === platform).accountId;
    for (const object of objects) {
      const existing = db.prepare('SELECT build_id FROM app_execution_object WHERE team_id=? AND platform=? AND account_id=? AND level=? AND object_id=?').get(row.team_id, platform, accountId, object.level, object.id);
      ensure(!existing || existing.build_id === row.id || existing.build_id === row.parent_id, 409, 'OBJECT_ALREADY_OWNED', '该平台编号已属于另一份搭建记录，请先核对，不能重复接管。');
      if (!existing) db.prepare('INSERT INTO app_execution_object VALUES(?,?,?,?,?,?)').run(row.id, row.team_id, platform, accountId, object.level, object.id);
    }
  }
  function makeSnapshot(value, buildId, teamId) {
    const {item, workflow, configuration} = value, tag = 'AGC-' + buildId.slice(0, 8), effectiveNames = {}, adSpecifications = [];
    for (const target of configuration.targets) {
      effectiveNames[target.platform] = {campaign: item.brief.operation === 'new_group' ? item.brief.parentCampaign.name : target.campaignName + ` [${tag}]`, adGroup: target.groupName + ` [${tag}]`, ad: target.groupName + ` [${tag}] Ad 01`};
      const copy = workflow.content.platforms.find(p => p.platform === target.platform), material = workflow.selectionSnapshot.materials[0], link = workflow.tracking.find(t => t.platform === target.platform && t.materialId === material.id);
      ensure(link, 400, 'TRACKING_REQUIRED', '本次素材还没有对应平台的已保存追踪链接。');
      adSpecifications.push({platform: target.platform, name: effectiveNames[target.platform].ad, headlines: target.platform === 'Google' ? copy.headlines : [copy.headlines[0]], descriptions: target.platform === 'Google' ? copy.descriptions : copy.descriptions.slice(0,1), primaryText: copy.primaryTexts[0] || '', callToAction: copy.callToAction, keywords: copy.keywords, negativeKeywords: copy.negativeKeywords, landingUrl: link.url, materialId: material.id, materialRevision: material.revision, trackingId: link.id});
    }
    const valueSnapshot = {schemaVersion: 1, teamId, proposalId: item.id, proposalRevision: item.revision, title: item.title, brief: item.brief, selection: workflow.selection, selectionSnapshot: workflow.selectionSnapshot, content: workflow.content, tracking: workflow.tracking, review: workflow.review, configuration, effectiveNames, adSpecifications, desiredState: 'paused'};
    return {...clone(valueSnapshot), fingerprint: hash(valueSnapshot)};
  }
  function handoff(row) {
    return {prompt: `请在支持浏览器的桌面 Codex 中执行广告搭建任务 ${row.id}。先读取本项目 docs/BROWSER-EXECUTION.md，再用 node runner/browser-client.mjs claim --build ${row.id} 领取冻结方案。只用当前会话 Cua 操作本人授权的广告后台。发布前核对暂停开关并取得本任务提交许可；创建后逐层回填 ID 和暂停截图。没有暂停控制就停在草稿；未知结果先核对，绝不重复创建。启用任务只能在独立人工确认后操作冻结的原有编号。`};
  }
  function detail(member, id) {
    const row = scoped(member, id), snapshot = snapshotOf(row);
    const objects = targetsOf(row).flatMap(t => (t.objects || []).map(o => ({...o, platform: t.platform, accountId: snapshot.configuration.targets.find(a=>a.platform===t.platform).accountId})));
    const events = db.prepare('SELECT e.*,u.name FROM app_build_event e JOIN user u ON u.id=e.actor_id WHERE build_id=? ORDER BY e.created_at,e.rowid').all(id).map(e => ({id:e.id, action:e.action, actor:{id:e.actor_id,name:e.name}, detail:JSON.parse(e.detail_json), createdAt:e.created_at}));
    const evidence = db.prepare('SELECT id,platform,stage,mime,url,caption,created_at AS createdAt FROM app_build_evidence WHERE build_id=? ORDER BY created_at,rowid').all(id);
    return {item: publicBuild(row), snapshot, objects, events, evidence, handoff: handoff(row)};
  }
  async function memberHandle(req, res, url, member, {body,json,requireEditor}) {
    const path = url.pathname;
    if (path === '/api/builds' && req.method === 'GET') {expire(); json(res,200,{items:db.prepare('SELECT * FROM app_build WHERE team_id=? ORDER BY created_at DESC,rowid DESC LIMIT 500').all(member.team_id).map(publicBuild)});return true;}
    const proposal = path.match(/^\/api\/proposals\/([a-zA-Z0-9-]+)\/(execution|execution\/config|builds)$/);
    if (proposal) {
      const [,id,action] = proposal, value = planning.read(member,id);
      if(action==='execution' && req.method==='GET') {expire();const builds=db.prepare('SELECT * FROM app_build WHERE team_id=? AND proposal_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(member.team_id,id).map(publicBuild);json(res,200,{...value,configuration:{targets:value.workflow.executionConfiguration?.targets || [],revision:value.item.revision},capabilities:value.item.brief.platforms.map(platform=>({platform,mode:'browser',createPaused:'unverified',reason:'需要桌面 Codex 对当前广告后台核对发布前暂停控制；CLI 不操作浏览器。'})),builds,latestBuild:builds[0]||null});return true;}
      if(action==='execution/config' && req.method==='POST') {
        requireEditor(member);const input=fields(await body(req),['expectedRevision','targets']);actor(member);
        const item=store.proposal(member.team_id,id);
        ensure(item.revision===revision(input.expectedRevision),409,'REVISION_CONFLICT','方案已更新，请核对最新内容。',{current:{item}});
        ensure(item.status!=='archived',409,'PROPOSAL_ARCHIVED','请先恢复为未归档方案。');
        const configuration=validateExecutionConfiguration({targets:input.targets},item.brief,item.workflow.selectionSnapshot,item.workflow.content);
        const workflow={...item.workflow,executionConfiguration:configuration,review:{status:'draft',note:'广告账户或搭建设置已更新，请重新核对和审核。'}};
        store.updateProposal(member,id,{expectedRevision:item.revision,workflow,auditAction:'build.configuration_updated'});
        json(res,200,{...planning.read(member,id),configuration});return true;
      }
      if(action==='builds' && req.method==='POST') {
        requireEditor(member);const input=fields(await body(req),['expectedRevision','connectorId']);actor(member);expire();
        const value=ready(member,id,input.expectedRevision), connector=db.prepare("SELECT * FROM app_connector WHERE id=? AND team_id=? AND owner_id=? AND status='active'").get(input.connectorId,member.team_id,member.user_id);
        ensure(connector,409,'DESKTOP_CONNECTION_REQUIRED','请选择本人已确认的连接；浏览器实际操作仍需桌面 Codex 领取。');
        ensure(!db.prepare("SELECT 1 FROM app_build WHERE proposal_id=? AND kind='create_paused' AND status NOT IN('failed','blocked','cancelled')").get(id),409,'BUILD_ALREADY_EXISTS','这份方案已有搭建记录，请查看原任务或核对结果，不能再次新建重复广告。');
        const buildId=randomUUID(), snapshot=makeSnapshot(value,buildId,member.team_id), targets=snapshot.configuration.targets.map(t=>({platform:t.platform,status:'queued',objects:[]}));
        store.transaction(()=>{actor(member);ready(member,id,input.expectedRevision);db.prepare('INSERT INTO app_build VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(buildId,member.team_id,member.user_id,connector.id,id,value.item.revision,'create_paused',null,'queued',JSON.stringify(snapshot),JSON.stringify(targets),null,null,stamp(),stamp());event(member,raw(buildId),'build.queued');});
        json(res,201,detail(member,buildId));return true;
      }
    }
    const route=path.match(/^\/api\/builds\/([a-zA-Z0-9-]+)(?:\/(cancel|retry|enable-preview|enable))?$/);
    if(route) {
      const [,id,action]=route;let row=scoped(member,id);
      if(!action && req.method==='GET'){expire();json(res,200,detail(member,id));return true;}
      if(action && req.method==='POST') {
        requireEditor(member);const input=await body(req);actor(member);row=scoped(member,id,true);expire();row=raw(id);
        if(action==='cancel') {fields(input,[]);const targets=targetsOf(row);ensure(!targets.some(t=>['publishing','unknown'].includes(t.status)),409,'RECONCILE_REQUIRED','提交结果未知时不能当作取消，请先回到平台核对。');store.transaction(()=>{for(const t of targets)if(!['paused_verified','enabled_verified'].includes(t.status))t.status='cancelled';db.prepare('UPDATE app_build SET lease_hash=NULL,lease_expires=NULL WHERE id=?').run(id);writeTargets(member,row,targets,'build.cancelled');});json(res,200,detail(member,id));return true;}
        if(action==='retry') {fields(input,['expectedRevision']);ensure(row.kind==='create_paused',409,'ENABLE_CONFIRMATION_REQUIRED','启用失败后需要重新预览并由本人确认，不能直接重试启用。');ready(member,row.proposal_id,input.expectedRevision);ensure(input.expectedRevision===row.proposal_revision,409,'BUILD_SNAPSHOT_CHANGED','只可重试原审核版本，请核对原任务。');const targets=targetsOf(row);ensure(!targets.some(t=>['unknown','publishing'].includes(t.status)),409,'RECONCILE_REQUIRED','请先核对未知结果，不能再次创建。');ensure(targets.some(t=>['failed','blocked','needs_attention'].includes(t.status)),409,'NO_RETRY_TARGETS','没有可以重试的平台。');store.transaction(()=>{for(const t of targets)if(['failed','blocked','needs_attention'].includes(t.status)){ensure(!t.intentHash,409,'RECONCILE_REQUIRED','该平台曾取得提交许可，必须先核对结果。');t.status='queued';t.reason='';t.preflight=null;delete t.resultHash;}db.prepare('UPDATE app_build SET lease_hash=NULL,lease_expires=NULL WHERE id=?').run(id);writeTargets(member,row,targets,'build.retry_requested');});json(res,200,detail(member,id));return true;}
        if(action==='enable-preview') {fields(input,[]);current(member,row);ensure(row.kind==='create_paused' && targetsOf(row).every(t=>['paused_verified','enabled_verified'].includes(t.status)) && targetsOf(row).some(t=>t.status==='paused_verified'),409,'PAUSED_VERIFICATION_REQUIRED','只有已核对暂停状态的完整搭建记录才能申请启用。');ensure(!db.prepare("SELECT 1 FROM app_build WHERE parent_id=? AND kind='enable' AND status NOT IN('failed','blocked','cancelled')").get(id),409,'ENABLE_ALREADY_EXISTS','此批广告已有启用任务，请查看原记录，不能重复启用。');const previewId=randomUUID(),fingerprint=hash({snapshot:row.snapshot_json,targets:row.targets_json}),expiresAt=clock()+300000;store.transaction(()=>{actor(member);db.prepare('INSERT INTO app_build_preview VALUES(?,?,?,?,?,?,?)').run(previewId,id,member.user_id,fingerprint,expiresAt,null,stamp());event(member,row,'build.enable_previewed');});const snapshot=snapshotOf(row);json(res,200,{preview:{id:previewId,buildId:id,expiresAt:new Date(expiresAt).toISOString(),objects:detail(member,id).objects.filter(o=>target(row,o.platform).item.status==='paused_verified'),budgets:snapshot.configuration.targets.filter(t=>target(row,t.platform).item.status==='paused_verified').map(t=>({platform:t.platform,dailyBudget:t.dailyBudget,currency:t.accountCurrency,budgetLevel:t.budgetLevel})),targetAccounts:snapshot.configuration.targets.filter(t=>target(row,t.platform).item.status==='paused_verified').map(t=>({platform:t.platform,accountId:t.accountId,accountName:t.accountName,currency:t.accountCurrency,timeZone:t.accountTimeZone})),changeSummary:'只启用本任务新建且已确认暂停的计划或广告组；不修改已有父计划，不重建广告。启用后可能开始按所列预算花费，仍以平台审核与投放状态为准。'}});return true;}
        if(action==='enable') {fields(input,['previewId','confirmation']);ensure(input.confirmation==='ENABLE_REVIEWED_OBJECTS',400,'ENABLE_CONFIRMATION_REQUIRED','请单独确认这批广告的编号、预算与启用范围。');const enabledId=randomUUID();store.transaction(()=>{actor(member);row=scoped(member,id,true);current(member,row);const preview=db.prepare('SELECT * FROM app_build_preview WHERE id=? AND build_id=? AND owner_id=?').get(input.previewId,id,member.user_id);ensure(preview && !preview.consumed_at && preview.expires_at>=clock() && preview.fingerprint===hash({snapshot:row.snapshot_json,targets:row.targets_json}) && targetsOf(row).every(t=>['paused_verified','enabled_verified'].includes(t.status)) && targetsOf(row).some(t=>t.status==='paused_verified'),409,'ENABLE_PREVIEW_EXPIRED','启用预览已使用、过期或对象状态已变化，请重新核对。');ensure(!db.prepare("SELECT 1 FROM app_build WHERE parent_id=? AND status NOT IN('failed','blocked','cancelled')").get(id),409,'ENABLE_ALREADY_EXISTS','此批广告已有启用任务。');const targets=targetsOf(row).filter(t=>t.status==='paused_verified').map(t=>({platform:t.platform,status:'queued',objects:clone(t.objects)}));db.prepare('INSERT INTO app_build VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(enabledId,row.team_id,row.owner_id,row.connector_id,row.proposal_id,row.proposal_revision,'enable',id,'queued',row.snapshot_json,JSON.stringify(targets),null,null,stamp(),stamp());db.prepare('UPDATE app_build_preview SET consumed_at=? WHERE id=?').run(stamp(),preview.id);event(member,raw(enabledId),'build.enable_confirmed',{sourceBuildId:id});});json(res,201,detail(member,enabledId));return true;}
      }
    }
    const evidenceRoute=path.match(/^\/api\/builds\/([a-zA-Z0-9-]+)\/evidence\/([a-zA-Z0-9-]+)$/);
    if(evidenceRoute && req.method==='GET'){const [,id,evidenceId]=evidenceRoute;scoped(member,id);const e=db.prepare('SELECT * FROM app_build_evidence WHERE id=? AND build_id=? AND team_id=?').get(evidenceId,id,member.team_id);ensure(e,404,'EVIDENCE_NOT_FOUND','没有找到该截图。');const bytes=await readFile(join(directory,e.filename));store.actor(member,['admin','editor','viewer']);res.writeHead(200,{'Content-Type':e.mime,'Content-Security-Policy':"default-src 'none'; sandbox"});res.end(bytes);return true;}
    return false;
  }
  async function publicHandle(req,res,url,{body,json}) {
    const path=url.pathname;
    if(!path.startsWith('/api/runner/browser/'))return false;
    ensure(req.method==='POST',405,'METHOD_NOT_ALLOWED','桌面任务请使用指定的提交方式。');
    connectors.authenticate(req);
    const input=await body(req,path.endsWith('/evidence')?5*1024*1024:128*1024);
    const {member,connector}=connectors.authenticate(req);actor(member);
    ensure(connector.status==='active',403,'CONNECTOR_PENDING','请先由本人确认连接。');
    store.consumeLimit('browser:'+connector.id,180,60000);
    if(path==='/api/runner/browser/claim') {
      fields(input,['buildId']);expire();
      const result=store.transaction(()=>{
        actor(member);const row=scoped(member,input.buildId,true);
        ensure(row.connector_id===connector.id,404,'BUILD_NOT_FOUND','此任务不属于本连接。');
        ensure(!row.lease_hash || row.lease_expires<clock(),409,'BUILD_ALREADY_CLAIMED','这份任务已由一个桌面会话领取，请回到原会话。');
        ensure(!['cancelled','enabled_verified'].includes(row.status),409,'BUILD_FINISHED','该任务已结束。');
        ensure(!db.prepare("SELECT 1 FROM app_build WHERE connector_id=? AND id<>? AND lease_expires>=? AND status IN('queued','running','unknown','needs_attention','partially_created')").get(connector.id,row.id,clock()),409,'BROWSER_BUSY','此连接有另一份桌面搭建任务尚未完成，请先处理原任务。');
        const leaseToken=randomBytes(32).toString('base64url'),expiresAt=clock()+300000,targets=targetsOf(row);
        for(const t of targets)if(['queued','needs_attention'].includes(t.status))t.status='claimed';
        db.prepare('UPDATE app_build SET lease_hash=?,lease_expires=?,targets_json=?,status=?,updated_at=? WHERE id=?').run(tokenHash(leaseToken),expiresAt,JSON.stringify(targets),aggregate(row.kind,targets),stamp(),row.id);
        event(member,row,'build.claimed',{connectorId:connector.id});
        return {id:row.id,kind:row.kind,parentBuildId:row.parent_id,leaseToken,expiresAt:new Date(expiresAt).toISOString(),snapshot:snapshotOf(row),targets:publicBuild(raw(row.id)).targets,objects:detail(member,row.id).objects};
      });json(res,200,{job:result});return true;
    }
    const route=path.match(/^\/api\/runner\/browser\/jobs\/([a-zA-Z0-9-]+)\/(heartbeat|evidence|material|preflight|intent|checkpoint|result|reconcile)$/);
    ensure(route,404,'NOT_FOUND','没有找到该桌面任务操作。');
    const [,id,action]=route;let state=lease(req,id,input.leaseToken),row=state.row;
    if(action==='heartbeat'){fields(input,['leaseToken']);store.transaction(()=>{actor(member);row=lease(req,id,input.leaseToken).row;db.prepare('UPDATE app_build SET lease_expires=?,updated_at=? WHERE id=?').run(clock()+300000,stamp(),id);});json(res,200,{status:row.status,expiresAt:new Date(clock()+300000).toISOString()});return true;}
    if(action==='material'){
      fields(input,['leaseToken','materialId','materialRevision']);const snapshot=snapshotOf(row),ref=snapshot.selection.materials.find(r=>r.id===input.materialId&&r.revision===input.materialRevision);
      ensure(ref && row.kind==='create_paused',403,'MATERIAL_SCOPE_MISMATCH','只能下载本任务冻结的素材版本。');
      const opened=await resources.openMaterial(member,ref);
      try{state=lease(req,id,input.leaseToken);actor(state.member);}catch(error){opened.stream.destroy();throw error;}
      res.writeHead(200,{'Content-Type':opened.file.mime,'Content-Length':opened.contentLength,'Content-Disposition':`attachment; filename="asset"; filename*=UTF-8''${encodeURIComponent(opened.file.name)}`});
      opened.stream.on('error',()=>res.destroy());res.once('close',()=>opened.stream.destroy());opened.stream.pipe(res);return true;
    }
    if(action==='evidence') {
      fields(input,['leaseToken','platform','stage','mime','base64','url','caption']);const evidenceTarget=target(row,input.platform).item;
      if(['after_publish','after_enable'].includes(input.stage)) ensure(input.stage===(row.kind==='enable'?'after_enable':'after_publish') && evidenceTarget.status==='publishing',409,'SUBMISSION_REQUIRED','请在本次实际提交后保存结果截图。');
      ensure(STAGES.includes(input.stage)&&['image/png','image/jpeg'].includes(input.mime)&&typeof input.base64==='string'&&input.base64.length<=4*1024*1024&&/^[a-zA-Z0-9+/]*={0,2}$/.test(input.base64),400,'INVALID_EVIDENCE','请保存本次实际浏览器截图。');
      const bytes=Buffer.from(input.base64,'base64');ensure(bytes.length>8&&bytes.length<=MAX_IMAGE&&(input.mime==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255),400,'INVALID_EVIDENCE','截图文件格式或大小不正确。');
      const link=platformURL(input.url,input.platform),caption=text(input.caption||'','截图说明',1000),evidenceId=randomUUID(),filename=evidenceId+(input.mime==='image/png'?'.png':'.jpg');
      await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,filename),bytes,{mode:0o600,flag:'wx'});
      try {store.transaction(()=>{const check=lease(req,id,input.leaseToken);actor(check.member);db.prepare('INSERT INTO app_build_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(evidenceId,id,row.team_id,row.owner_id,input.platform,input.stage,input.mime,filename,createHash('sha256').update(bytes).digest('hex'),link,caption,stamp());event(member,row,'build.evidence_saved',{evidenceId,platform:input.platform,stage:input.stage});});}
      catch(error){await rm(join(directory,filename),{force:true});throw error;}
      json(res,201,{evidence:{id:evidenceId,platform:input.platform,stage:input.stage,url:link,caption,createdAt:stamp()}});return true;
    }
    if(action==='preflight') {
      fields(input,['leaseToken','platform','observation','evidenceIds']);fields(input.observation,['accountId','currency','timeZone','campaignType','parentCampaignId','canPublishPaused','pausedScopes','url','objects']);
      const snapshot=snapshotOf(row),configured=snapshot.configuration.targets.find(t=>t.platform===input.platform),observation=input.observation;target(row,input.platform);current(member,row);
      ensure(observation.accountId===configured.accountId&&observation.currency===configured.accountCurrency&&observation.timeZone===configured.accountTimeZone&&observation.campaignType===configured.campaignType,409,'ACCOUNT_PREFLIGHT_MISMATCH','当前浏览器账户、币种、时区或广告类型与审核方案不一致。');
      platformURL(observation.url,input.platform);
      if(snapshot.brief.operation==='new_group')ensure(observation.parentCampaignId===snapshot.brief.parentCampaign.campaignId,409,'PARENT_CAMPAIGN_MISMATCH','浏览器父计划与本次冻结范围不一致，不能更改已有计划。');
      const gate=snapshot.brief.operation==='new_group'?'adGroup':'campaign';
      ensure(typeof observation.canPublishPaused==='boolean'&&Array.isArray(observation.pausedScopes)&&observation.pausedScopes.every(v=>['campaign','adGroup','ad'].includes(v)),400,'INVALID_PREFLIGHT','请核对实际可见的暂停控制。');
      const known=target(row,input.platform).item;
      proof(row,input.platform,input.evidenceIds,row.kind==='enable'?['before_enable']:['preflight'],{afterSequence:known.checkpointEvidenceSequence??-1});
      if(row.kind==='enable')checkObjects(row,input.platform,observation.objects,'paused');
      else if(known.objects?.length)checkObjects(row,input.platform,observation.objects,'paused',{partial:true});
      const blocked=!observation.canPublishPaused||!observation.pausedScopes.includes(gate);
      store.transaction(()=>{row=lease(req,id,input.leaseToken).row;const {targets,item}=target(row,input.platform);ensure(['claimed','preflight_checked'].includes(item.status),409,'RECONCILE_REQUIRED','该平台已停止或已有提交结果，请先回到工作区核对并主动重试。');item.status=blocked?'blocked':'preflight_checked';item.reason=blocked?'没有核对到发布前暂停控制，停在草稿，不发布。':'';item.preflight={...clone(observation),checkedAt:stamp(),evidenceIds:input.evidenceIds};writeTargets(member,row,targets,'build.preflight_saved',{platform:input.platform,blocked});});
      json(res,200,{status:blocked?'blocked':'preflight_checked',...detail(member,id)});return true;
    }
    if(action==='intent') {
      fields(input,['leaseToken','platform','action']);current(member,row);const {item}=target(row,input.platform),expected=row.kind==='enable'?'enable':'publish_paused';
      ensure(input.action===expected&&item.status==='preflight_checked'&&item.preflight&&Date.parse(item.preflight.checkedAt)>=clock()-600000,409,'PREFLIGHT_REQUIRED','请先在当前浏览器核对账户、范围与暂停状态。');
      ensure(!item.intentHash,409,'RECONCILE_REQUIRED','本平台已取得一次提交许可；请先回查实际结果，不能再次提交。');
      const stage=row.kind==='enable'?'before_enable':'before_publish';
      const latest=db.prepare('SELECT id FROM app_build_evidence WHERE build_id=? AND platform=? AND stage=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id,input.platform,stage);
      proof(row,input.platform,latest?[latest.id]:[],[stage],{afterSequence:item.checkpointEvidenceSequence??-1});
      const intentToken=randomBytes(32).toString('base64url'),expiresAt=clock()+120000;
      store.transaction(()=>{row=lease(req,id,input.leaseToken).row;current(member,row);const {targets,item}=target(row,input.platform);ensure(item.status==='preflight_checked'&&!item.intentHash,409,'RECONCILE_REQUIRED','提交许可已变化。');item.intentHash=tokenHash(intentToken);item.intentExpires=expiresAt;item.intentEvidenceSequence=db.prepare('SELECT coalesce(max(rowid),0) AS sequence FROM app_build_evidence WHERE build_id=? AND platform=?').get(id,input.platform).sequence;item.intentAction=expected;item.status='publishing';writeTargets(member,row,targets,'build.submit_authorized',{platform:input.platform,action:expected});});
      json(res,200,{intentToken,expiresAt:new Date(expiresAt).toISOString(),action:expected,platform:input.platform,instructions:row.kind==='enable'?'只启用预览中的原有对象编号；不得新建、改预算或修改已有父计划。':'只在已确认暂停开关仍关闭时发布；若界面变化立即停止并核对。'});return true;
    }
    if(action==='checkpoint') {
      fields(input,['leaseToken','platform','intentToken','objects','evidenceIds']);
      ensure(row.kind==='create_paused' && input.platform==='Google',400,'PARTIAL_SCOPE_UNSUPPORTED','分步核对仅适用于 Google 暂停搭建，不能用于启用任务。');
      ensure(typeof input.intentToken==='string' && input.intentToken.length>=40 && input.intentToken.length<=100,403,'SUBMIT_INTENT_REQUIRED','请使用本步骤已取得的提交许可。');
      const existing=target(row,input.platform).item,intentHash=tokenHash(input.intentToken),payloadHash=hash({platform:input.platform,intentToken:input.intentToken,objects:input.objects,evidenceIds:input.evidenceIds});
      const previous=(existing.checkpointReceipts||[]).find(receipt=>receipt.intentHash===intentHash);
      if(previous){ensure(previous.payloadHash===payloadHash,409,'CHECKPOINT_MISMATCH','本次提交已保存过不同的核对结果，不能覆盖。');json(res,200,{status:row.status,checkpoint:{platform:input.platform,status:'paused_partial',objects:previous.objects,completed:false},...detail(member,id)});return true;}
      ensure(existing.status==='publishing' && existing.intentHash===intentHash,403,'SUBMIT_INTENT_REQUIRED','没有本步骤的提交许可，或结果已经未知，请先核对平台。');
      proof(row,input.platform,input.evidenceIds,['after_publish'],{afterSequence:existing.intentEvidenceSequence??-1});
      const objects=checkObjects(row,input.platform,input.objects,'paused',{partial:true});
      store.transaction(()=>{row=lease(req,id,input.leaseToken).row;const {targets,item}=target(row,input.platform);ensure(item.status==='publishing'&&item.intentHash===intentHash,409,'RECONCILE_REQUIRED','提交状态已变化，请先核对。');recordObjects(row,input.platform,objects);item.objects=objects;item.lastObservedAt=stamp();item.status='claimed';item.reason='已核对并保留暂停对象，后续步骤仍需重新核对；整份搭建尚未完成。';item.checkpointReceipts=[...(item.checkpointReceipts||[]),{intentHash,payloadHash,objects:clone(objects)}];item.checkpointEvidenceSequence=db.prepare('SELECT coalesce(max(rowid),0) AS sequence FROM app_build_evidence WHERE build_id=? AND platform=?').get(id,input.platform).sequence;item.preflight=null;for(const key of ['intentHash','intentExpires','intentAction','intentEvidenceSequence','resultHash'])delete item[key];writeTargets(member,row,targets,'build.paused_checkpoint_saved',{platform:input.platform,objectCount:objects.length});});
      json(res,200,{status:raw(id).status,checkpoint:{platform:input.platform,status:'paused_partial',objects,completed:false},...detail(member,id)});return true;
    }
    if(action==='result') {
      fields(input,['leaseToken','platform','intentToken','outcome','objects','evidenceIds','message']);
      ensure(['paused_verified','enabled_verified','unknown','failed_before_publish','blocked'].includes(input.outcome),400,'INVALID_RESULT','搭建结果类型不正确。');
      const payloadHash=hash(input),existing=target(row,input.platform).item;
      if(existing.resultHash){ensure(existing.resultHash===payloadHash,409,'RESULT_MISMATCH','此平台已经保存过不同的结果，请通过核对流程处理。');json(res,200,{status:row.status,...detail(member,id)});return true;}
      const successful=['paused_verified','enabled_verified'].includes(input.outcome);let objects=[];
      if(successful){ensure(input.outcome===(row.kind==='enable'?'enabled_verified':'paused_verified'),400,'INVALID_RESULT','搭建和启用必须分别回填。');ensure(existing.status==='publishing'&&typeof input.intentToken==='string'&&existing.intentHash===tokenHash(input.intentToken),403,'SUBMIT_INTENT_REQUIRED','没有取得本任务的对应提交许可，不能标记成功。');proof(row,input.platform,input.evidenceIds,[row.kind==='enable'?'after_enable':'after_publish'],{afterSequence:existing.intentEvidenceSequence??-1});objects=checkObjects(row,input.platform,input.objects,row.kind==='enable'?'enabled':'paused');}
      else if(['failed_before_publish','blocked'].includes(input.outcome))ensure(!existing.intentHash,409,'RECONCILE_REQUIRED','已取得提交许可，结果必须先记为未知并回查，不能直接重试。');
      else ensure(existing.intentHash,409,'NO_PENDING_SUBMISSION','尚无提交许可，不应标记提交结果未知。');
      const message=text(input.message||'','结果说明',2000);
      store.transaction(()=>{row=lease(req,id,input.leaseToken).row;const {targets,item}=target(row,input.platform);if(successful)recordObjects(row,input.platform,objects);item.status=input.outcome==='failed_before_publish'?'failed':input.outcome;item.reason=message;item.resultHash=payloadHash;if(successful){item.objects=objects;item.lastObservedAt=stamp();item.resultEvidenceIds=input.evidenceIds;}writeTargets(member,row,targets,'build.result_saved',{platform:input.platform,outcome:input.outcome});
        if(row.kind==='enable'&&successful){const source=raw(row.parent_id),parentTargets=targetsOf(source),original=parentTargets.find(t=>t.platform===input.platform);original.objects=objects;original.status='enabled_verified';original.lastObservedAt=stamp();writeTargets(member,source,parentTargets,'build.objects_enabled',{enableBuildId:row.id,platform:input.platform});}
      });json(res,200,{status:raw(id).status,...detail(member,id)});return true;
    }
    if(action==='reconcile') {
      fields(input,['leaseToken','platform','resolution','objects','evidenceIds']);const existing=target(row,input.platform).item;
      ensure(existing.status==='unknown'||['paused_verified','enabled_verified'].includes(existing.status),409,'RECONCILE_NOT_REQUIRED','请先核对任务当前状态。');
      ensure(['found_paused','found_enabled','not_found','still_unknown'].includes(input.resolution),400,'INVALID_RECONCILIATION','请选择平台实际核对结果。');proof(row,input.platform,input.evidenceIds,['reconcile'],{afterSequence:existing.intentEvidenceSequence??-1});
      let objects=[];if(input.resolution==='found_paused')objects=checkObjects(row,input.platform,input.objects,'paused',{partial:row.kind==='create_paused'&&input.platform==='Google'});if(input.resolution==='found_enabled')objects=checkObjects(row,input.platform,input.objects,'enabled');
      if(row.kind==='create_paused'&&input.resolution==='found_enabled') {
        store.transaction(()=>{row=lease(req,id,input.leaseToken).row;const {targets,item}=target(row,input.platform);recordObjects(row,input.platform,objects);item.objects=objects;item.status='unknown';item.reason='发现对象已启用，与暂停创建要求不符，请本人立即检查平台；本任务不会继续启用或重复创建。';writeTargets(member,row,targets,'build.unexpected_enabled',{platform:input.platform});});json(res,200,{status:'unknown',...detail(member,id)});return true;
      }
      store.transaction(()=>{row=lease(req,id,input.leaseToken).row;const {targets,item}=target(row,input.platform);if(objects.length){recordObjects(row,input.platform,objects);item.objects=objects;const partial=input.resolution==='found_paused'&&row.kind==='create_paused'&&objects.length<(snapshotOf(row).brief.operation==='new_group'?2:3);item.status=input.resolution==='found_paused'?(row.kind==='enable'?'failed':partial?'claimed':'paused_verified'):'enabled_verified';item.reason=row.kind==='enable'&&input.resolution==='found_paused'?'已核对原有对象仍暂停，未完成启用。需要本人重新预览和确认启用。':partial?'已找到并保留部分暂停对象；后续步骤需重新核对，不能重复创建已有对象。':'';item.lastObservedAt=stamp();if(partial){item.preflight=null;item.checkpointEvidenceSequence=db.prepare('SELECT coalesce(max(rowid),0) AS sequence FROM app_build_evidence WHERE build_id=? AND platform=?').get(id,input.platform).sequence;for(const key of ['intentHash','intentExpires','intentAction','intentEvidenceSequence','resultHash'])delete item[key];}}else if(input.resolution==='not_found'){ensure(existing.status==='unknown'&&row.kind==='create_paused'&&!existing.objects?.length,409,'CANNOT_DISCARD_VERIFIED_OBJECTS','已确认的对象不能改成未创建，请继续核对原有编号。');item.status='failed';item.objects=[];delete item.intentHash;delete item.intentExpires;delete item.resultHash;item.preflight=null;item.reason='已按任务名称、账户和范围核对未找到对象，可以由本人主动重试。';}else{item.status='unknown';item.reason='平台结果仍不明确，不能重新创建。';}writeTargets(member,row,targets,'build.reconciled',{platform:input.platform,resolution:input.resolution});if(row.kind==='enable'&&objects.length){const source=raw(row.parent_id),sourceTargets=targetsOf(source),original=sourceTargets.find(t=>t.platform===input.platform);original.objects=objects;original.status=input.resolution==='found_paused'?'paused_verified':'enabled_verified';original.lastObservedAt=stamp();writeTargets(member,source,sourceTargets,'build.enable_reconciled',{enableBuildId:row.id,platform:input.platform,resolution:input.resolution});}});json(res,200,{status:raw(id).status,...detail(member,id)});return true;
    }
    throw new AppError(404,'NOT_FOUND','没有找到该桌面任务操作。');
  }
  return {memberHandle,publicHandle};
}
