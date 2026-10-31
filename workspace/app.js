const root = document.getElementById('workspace-app');
const roles = { admin: '管理员', editor: '编辑成员', viewer: '只读成员' };
const platforms = ['Google', 'Meta', 'TikTok'];
const state = {
  loading: true, dataContext: null, needsSetup: false, account: null, me: null, noMembership: false,
  view: 'overview', items: [], counts: null, audits: [], teamData: null, editor: null,
  busy: false, message: '', messageTone: 'info', authMode: 'login', authEmail: '',
  inviteToken: new URLSearchParams(location.hash.slice(1)).get('invite') || '',
  invitation: null, inviteError: '', inviteLink: '', inviteEmail: '', inviteRole: 'editor',
  auditProposalId: '', editorTab: 'edit', registering: false,
  resources: {materials: [], audiences: [], landings: [], sitemap: {}}, resourceTab: 'materials',
  libraryDrafts: {}, resourceFiles: {}, libraryEdits: {}, resourceDirty: false,
  trackingConfig: null, trackingDraft: null, trackingDirty: false, trackingConflict: null, trackingItems: [], sitemapInput: '', sitemapDiscovery: null, sitemapSelection: [], sitemapSelectionDirty: false, landingSearch: '', landingLanguage: '', landingLimit: 60,
  connectors: [], connectorsLoaded: false, connectorError: '', pairing: null, codexConfirmation: null, codexPollBusy: false, codexPollAt: 0,
  builds: [], buildsLoaded: false, buildDetail: null, buildPreview: null, buildConfirmation: null, executionPollBusy: false, executionPollAt: 0,
  reporting: {data: null, accountId: '', reportDate: '', campaignId: '', detail: null, detailKey: '', error: '', accountInput: '', scheduleDrafts: {}}
};

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const clone = value => JSON.parse(JSON.stringify(value));
const date = value => {
  if (!value) return '尚无记录';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '时间待核对' : new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(parsed);
};
const person = value => value?.name || '成员信息待获取';
const button = (label, action, options = '') => `<button type="button" class="btn ${options.includes('primary') ? 'btn-primary' : ''}" data-action="${action}" ${state.busy ? 'disabled' : ''}>${label}</button>`;
const badge = (label, tone = '') => `<span class="badge ${tone ? 'badge-' + tone : ''}">${escape(label)}</span>`;
const canEdit = () => Boolean(state.me?.permissions?.canEdit);
const canManage = () => Boolean(state.me?.permissions?.canManage);
const draftBrief = () => ({ operation: 'new_campaign', platforms: [], objective: 'registration', country: '', language: '', audienceDirection: '', groupName: '', budgets: {}, startAt: '', timeZone: 'Asia/Shanghai', parentCampaign: null });
function normalizedBrief(brief) {
  const value = brief && typeof brief === 'object' ? brief : {};
  return { ...draftBrief(), ...clone(value), platforms: Array.isArray(value.platforms) ? value.platforms.filter(p => platforms.includes(p)) : [], budgets: { ...(value.budgets || {}) }, parentCampaign: value.parentCampaign ? { ...value.parentCampaign } : null };
}

class RequestError extends Error {
  constructor(message, status, code, payload) { super(message); this.status = status; this.code = code; this.payload = payload; }
}
async function api(path, { method = 'GET', body, sessionCheck = false } = {}) {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new RequestError('暂时无法连接服务器。未保存的输入仍保留在当前页面；若刚才提交过保存，请先核对服务器记录再重试。', 0, 'NETWORK_ERROR');
  }
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok) {
    const error = new RequestError(payload.error?.message || payload.message || '这次操作没有完成，请稍后重试。', response.status, payload.error?.code || payload.code || 'REQUEST_FAILED', payload);
    error.sessionCheck = sessionCheck;
    if (response.status === 401 && !sessionCheck) {
      state.me = null; state.account = null; state.noMembership = false; state.authMode = 'login'; state.pairing = null;
      state.message = '登录已失效，请重新登录。未保存的方案输入仍保留在当前页面。'; state.messageTone = 'warn';
    }
    throw error;
  }
  return payload;
}
function notify(message, tone = 'info') { state.message = message; state.messageTone = tone; }
function fail(error) {
  if (error.status === 401 && error.sessionCheck) {
    notify(error.message || '登录信息未通过校验，请重新填写。', 'error');
  } else if (error.status === 401 && !state.me && !state.account) {
    if (!state.message) notify('请先登录，再继续操作。', 'warn');
  } else if (error.status === 403) notify(error.message || '当前账号没有此操作权限，输入已保留。', 'error');
  else notify(error.message || '操作未完成，输入已保留。', 'error');
}
async function perform(fn) {
  if (state.busy) return;
  state.busy = true; render();
  try { await fn(); } catch (error) { fail(error); }
  finally { state.busy = false; render(); }
}
function banner() {
  const message = state.message ? `<div class="banner banner-${state.messageTone}" role="${state.messageTone === 'error' ? 'alert' : 'status'}">${escape(state.message)}</div>` : '';
  const pending = state.codexConfirmation;
  return message + (pending?.type === 'cancel' && state.me ? codexConfirmationView(pending) : '');
}
function title(label, description, action = '') { return `<div class="page-head"><div><h1>${escape(label)}</h1><p>${escape(description)}</p></div>${action}</div>`; }
function header() {
  const user = state.me?.user || state.account;
  return `<header class="app-header"><a class="brand" href="/"><span class="brand-mark" aria-hidden="true">AG</span><span>广告增长工作区<small>${escape(state.me?.team?.name || '团队协作与投放方案')}</small></span></a><div class="account"><a class="btn btn-small btn-quiet" href="/demo" target="_blank" rel="noopener">查看流程演示 ↗</a>${user ? `<span class="account-name">${escape(user.name || user.email || '已登录账号')} ${state.me ? badge(roles[state.me.role]) : ''}</span>${button('退出登录', 'logout')}` : ''}</div></header><div class="boundary">团队开发版 · 先创建暂停广告 · 启用需要另行确认</div>`;
}
function invitationCard() {
  if (!state.inviteToken) return '';
  if (state.inviteError) return `<section class="card"><h2>邀请暂不可用</h2><p class="small">${escape(state.inviteError)}</p><p class="auth-note">请向团队管理员索取有效邀请链接。</p></section>`;
  if (!state.invitation) return `<section class="card"><p class="muted">正在检查邀请…</p></section>`;
  const invite = state.invitation;
  return `<section class="card"><h2>加入 ${escape(invite.teamName)}</h2><p class="small">邀请邮箱：<strong>${escape(invite.email)}</strong></p><p class="small">成员角色：${escape(roles[invite.role] || invite.role)}<br>有效期至：${date(invite.expiresAt)}（北京时间）</p>${state.account || state.me ? `<div class="notice">请确认当前登录账号与邀请邮箱一致。接受后，方案访问范围以服务器确认的团队权限为准。</div>${button('接受邀请并进入团队', 'accept-invitation', 'primary')}` : '<div class="auth-note">已有账号请先登录；首次加入可以使用下方“注册并接受邀请”。</div>'}</section>`;
}
function authView() {
  const invitationValid = Boolean(state.invitation && !state.inviteError);
  const setup = state.needsSetup && state.authMode === 'setup';
  const register = invitationValid && state.authMode === 'register';
  return `<main class="auth-main" id="main-content">${banner()}<div class="eyebrow">团队工作区</div><h1>${setup ? '创建第一个团队' : register ? '注册并接受邀请' : '登录团队工作区'}</h1><p class="muted small">使用自己的账号登录。方案与执行记录由团队共享；广告搭建由本人桌面 Codex 领取，启用需要单独确认。</p>${invitationCard()}<div class="tabs auth-tabs" role="tablist" aria-label="登录方式"><button class="tab" type="button" data-auth-mode="login" aria-selected="${!setup && !register}">登录</button>${state.needsSetup ? `<button class="tab" type="button" data-auth-mode="setup" aria-selected="${setup}">首次管理员初始化</button>` : ''}${invitationValid ? `<button class="tab" type="button" data-auth-mode="register" aria-selected="${register}">注册并接受邀请</button>` : ''}</div><section class="card auth-card"><form id="${setup ? 'setup-form' : register ? 'register-form' : 'login-form'}"><fieldset ${state.busy ? 'disabled' : ''}><div class="form-grid">${setup ? '<label class="field"><span>初始化口令</span><input name="token" type="password" autocomplete="off" required><small>由部署者提供，或从本地 .local/bootstrap-token 文件取得。网页不会自动读取。</small></label><label class="field"><span>团队名称</span><input name="teamName" autocomplete="organization" maxlength="100" required></label>' : ''}${setup || register ? '<label class="field"><span>你的名字</span><input name="name" autocomplete="name" maxlength="80" required></label>' : ''}<label class="field"><span>邮箱</span><input name="email" type="email" autocomplete="username" value="${escape(register ? state.invitation.email : state.authEmail || state.invitation?.email || '')}" ${register ? 'readonly' : ''} required></label><label class="field"><span>密码${setup || register ? '（至少 12 位）' : ''}</span><input name="password" type="password" autocomplete="${setup || register ? 'new-password' : 'current-password'}" minlength="12" required><small>密码只用于本次请求，不保存到浏览器存储。</small></label></div><div class="form-footer"><button class="btn btn-primary" type="submit">${state.busy ? '正在处理…' : setup ? '创建团队与管理员' : register ? '注册并加入团队' : '登录'}</button></div></fieldset></form></section><p class="auth-note">${state.needsSetup ? '首次使用需要部署者提供初始化口令。' : '新成员通过管理员生成的邀请链接加入；当前不会自动发送邀请邮件。'}</p></main>`;
}
function noMembershipView() {
  return `<main class="auth-main" id="main-content">${banner()}<h1>账号已登录，尚未加入团队</h1><p class="auth-note">请打开团队管理员提供的邀请链接，接受邀请后进入工作区。</p>${invitationCard()}${!state.inviteToken ? '<section class="card"><p class="muted small">如果你刚收到邀请，请在这个浏览器中打开完整邀请链接。</p></section>' : ''}</main>`;
}
function nav() {
  return `<nav class="sidebar" aria-label="工作区导航">${[['overview', '工作概览'], ['proposals', '投放方案'], ['resources', '素材与人群'], ['landings', '落地页'], ['tracking', 'UTM设置'], ['codex', '我的 Codex'], ['builds', '广告搭建'], ['reporting', '投放日报'], ['audit', '操作记录'], ['team', '团队设置']].map(([key, label]) => `<button class="nav-button" type="button" data-nav="${key}" ${state.view === key ? 'aria-current="page"' : ''}>${label}</button>`).join('')}<div class="sidebar-note">资源 → 方案 → 审核 → 暂停搭建<br>日报读取数据，建议需人工确认<br>启用需要另行确认</div></nav>`;
}
function invitationForMember() { return state.inviteToken ? invitationCard() : ''; }
function proposalTable(items = state.items) {
  if (!items.length) return `<div class="empty">${canEdit() ? '还没有方案，点击“新建方案”开始。' : '团队还没有方案，请等待编辑成员创建。'}</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>方案</th><th>版本 / 状态</th><th>最近修改</th><th>修改人</th></tr></thead><tbody>${items.map(item => `<tr><td><button class="table-link" type="button" data-open-proposal="${escape(item.id)}">${escape(item.title)}</button><span class="cell-note">${escape((item.brief?.platforms || []).join(' / ') || '投放平台待填写')}</span></td><td>V${escape(item.revision)}<br>${badge(item.status === 'archived' ? '已归档' : reviewNames[item.workflow?.review?.status] || '草稿', item.status === 'archived' ? '' : item.workflow?.review?.status === 'approved' ? 'green' : 'warn')}</td><td>${date(item.updatedAt)}</td><td>${escape(person(item.updatedBy || item.createdBy))}</td></tr>`).join('')}</tbody></table></div>`;
}
function overviewView() {
  const counts = state.counts || {total: state.items.length, draft: state.items.filter(item => item.status === 'draft').length};
  const drafts = counts.draft;
  return title('工作概览', '查看团队方案和最近操作；账户投放数据请查看“投放日报”。', `<div class="row">${canEdit() ? button('新建方案', 'new-proposal', 'primary') : ''}<button type="button" class="btn" data-reporting-action="open" ${state.busy ? 'disabled' : ''}>查看投放日报</button></div>`) + invitationForMember() + `${state.editor?.dirty ? `<div class="banner banner-warn"><div class="spread"><span>你在当前页面还有未保存的方案输入。</span>${button('继续编辑', 'resume-editor')}</div></div>` : ''}<div class="metrics"><section class="card"><div class="metric-label">团队方案</div><div class="metric-value">${counts.total}</div></section><section class="card"><div class="metric-label">未归档方案</div><div class="metric-value">${drafts}</div></section><section class="card"><div class="metric-label">已归档</div><div class="metric-value">${counts.total - drafts}</div></section></div><section class="card"><div class="spread"><h2>最近更新的方案</h2>${button('查看全部', 'all-proposals')}</div>${proposalTable(state.items.slice(0, 5))}</section><section class="card"><h2>当前可以完成什么</h2><p class="small">团队成员登录后可以按权限查看、创建和编辑方案；每次保存都记录版本与操作人。多人同时修改时，系统会要求核对最新版本。</p><div class="notice">先整理资源、生成文案并确认账户设置。审核通过后可交给本人 Codex 创建暂停广告，启用需要单独确认。“投放日报”可读取已接入的 Google Ads 账户，汇总数据并提供待人工核对的建议。</div></section>`;
}
function proposalsView() {
  return title('投放方案', '方案由团队共享保存；列表展示最近 500 份，概览统计全部方案。保存草稿不会创建或启用广告。', canEdit() ? button('新建方案', 'new-proposal', 'primary') : '') + (state.editor ? `<div class="row" style="margin-bottom:16px">${button(state.editor.dirty ? '继续未保存的编辑' : '返回当前方案', 'resume-editor')}</div>` : '') + `<section class="card">${proposalTable()}</section>`;
}
const textField = (label, name, value, options = '') => `<label class="field"><span>${label}</span><input data-edit-field="${name}" value="${escape(value)}" ${options}></label>`;
function briefSummary(brief) {
  const b = normalizedBrief(brief);
  const entries = [['搭建方式', b.operation === 'new_group' ? '在已有计划下新增广告组' : '新建广告计划'], ['平台', b.platforms.join(' / ') || '待填写'], ['目标', b.objective === 'first_subscription' ? '首次订阅' : '网站注册'], ['地区 / 语言', [b.country, b.language].filter(Boolean).join(' / ') || '待填写'], ['人群方向', b.audienceDirection || '待填写'], ['日预算', b.platforms.map(p => `${p}：${b.budgets[p] ?? '待填写'}`).join('；') || '待填写'], ['开始时间', b.startAt ? b.startAt + ' / ' + b.timeZone : '待填写'], ['父计划', b.parentCampaign ? `${b.parentCampaign.platform || ''} / ${b.parentCampaign.accountId || '账户待填写'} / ${b.parentCampaign.campaignId || '计划编号待填写'} / ${b.parentCampaign.name || ''}（手动登记，未核对）` : '不适用']];
  return `<dl class="definition-grid">${entries.map(([key, value]) => `<dt>${key}</dt><dd>${escape(value)}</dd>`).join('')}</dl>`;
}
function conflictView(editor) {
  if (!editor.conflict) return '';
  const latest = editor.conflict.latest;
  return `<section class="banner banner-warn" role="alert"><h2>有人先保存了这个方案</h2><p class="small">你的输入仍保留在下方。请先查看服务器最新版本，再明确选择怎样继续；系统不会自动覆盖任何一方。</p><div class="row" style="margin-top:12px">${button('查看服务器最新版本', 'load-latest', 'primary')}</div>${latest && editor.conflict.reviewed ? `<div class="comparison"><h3>服务器最新内容 · V${escape(latest.revision)}</h3><p class="small">${escape(latest.title)} · ${latest.status === 'archived' ? '已归档' : '未归档'} · ${date(latest.updatedAt)}</p>${briefSummary(latest.brief)}<div class="row" style="margin-top:16px">${button('载入最新内容重新编辑', 'adopt-latest')}${latest.status === 'draft' ? button('保留我的输入，基于最新版本继续', 'rebase-local') : ''}</div><p class="small" style="margin-top:10px">选择继续后仍需主动保存。最新版本已归档时，需要先恢复为草稿。</p></div>` : ''}</section>`;
}
function editorView() {
  const e = state.editor;
  if (!e) return proposalsView();
  const editable = canEdit() && e.status !== 'archived';
  const b = e.brief;
  const disabled = editable && !state.busy ? '' : 'disabled';
  const readonly = editable && !state.busy ? '' : 'readonly';
  return title(e.id ? e.title || '投放方案' : '新建投放方案', '先完善资源、文案和账户设置，审核后创建暂停广告；启用需要单独确认。', button('返回方案列表', 'all-proposals')) + `<div class="editor-meta"><span>${e.id ? '当前版本 V' + escape(e.revision) : '尚未保存'}</span><span data-editor-save-state aria-live="polite">${e.status === 'archived' ? '已归档' : (e.dirty || e.workflowDirty || e.executionDirty) ? '有未保存的修改' : '内容已保存'}</span>${e.updatedAt ? '<span>最近保存：' + date(e.updatedAt) + '</span>' : ''}</div>${conflictView(e)}${e.executionDirty ? '<div class="banner banner-warn">账户和搭建设置有未保存的修改。请先到“广告搭建”保存，再生成、审核或提交任务。</div>' : ''}<div class="tabs" role="tablist" aria-label="方案内容"><button class="tab" type="button" data-editor-tab="edit" aria-selected="${state.editorTab === 'edit'}">1. 投放需求</button>${['resources', 'content', 'review'].map((tab, i) => `<button class="tab" type="button" data-editor-tab="${tab}" aria-selected="${state.editorTab === tab}" ${e.id ? '' : 'disabled'}>${['2. 素材与落地页', '3. 策略与文案', '4. 人工审核'][i]}</button>`).join('')}<button class="tab" type="button" data-editor-tab="execution" aria-selected="${state.editorTab === 'execution'}" ${e.id ? '' : 'disabled'}>5. 广告搭建</button><button class="tab" type="button" data-editor-tab="versions" aria-selected="${state.editorTab === 'versions'}" ${e.id ? '' : 'disabled'}>历史版本</button><button class="tab" type="button" data-editor-tab="audit" aria-selected="${state.editorTab === 'audit'}" ${e.id ? '' : 'disabled'}>本方案操作记录</button></div>${state.editorTab === 'execution' ? executionView(e) : ['resources', 'content', 'review'].includes(state.editorTab) ? workflowView(e, state.editorTab) : state.editorTab === 'versions' ? versionsView(e) : state.editorTab === 'audit' ? auditTable(e.audit || []) : `<form id="proposal-form"><section class="card"><h2>基本信息</h2><div class="form-grid">${textField('方案名称', 'title', e.title, `${readonly} maxlength="120" required`)}<label class="field"><span>搭建方式</span><select data-brief-field="operation" ${disabled}><option value="new_campaign" ${b.operation === 'new_campaign' ? 'selected' : ''}>新建广告计划</option><option value="new_group" ${b.operation === 'new_group' ? 'selected' : ''}>在已有计划下新增广告组</option></select></label><label class="field"><span>投放目标</span><select data-brief-field="objective" ${disabled}><option value="registration" ${b.objective === 'registration' ? 'selected' : ''}>网站注册</option><option value="first_subscription" ${b.objective === 'first_subscription' ? 'selected' : ''}>首次订阅</option></select></label>${textField('投放地区', 'country', b.country, `${readonly} placeholder="例如 US、UK 或尚待确认"`)}${textField('广告语言', 'language', b.language, `${readonly} placeholder="例如 English"`)}<label class="field full"><span>想触达的人群与需求</span><textarea data-brief-field="audienceDirection" ${readonly}>${escape(b.audienceDirection)}</textarea><small>填写业务方向即可，请勿在这里粘贴邮箱名单或个人资料。</small></label></div></section><section class="card"><h2>${b.operation === 'new_group' ? '已有计划与新广告组' : '平台与预算'}</h2>${b.operation === 'new_group' ? `<div class="banner banner-warn">父计划信息由你手动登记。搭建时将先核对账户与父计划；只创建新的暂停广告组，不改动父计划的预算和启用状态。</div><div class="form-grid"><label class="field"><span>平台（新增组仅支持一个）</span><select data-group-platform ${disabled}>${platforms.map(p => `<option ${b.platforms[0] === p ? 'selected' : ''}>${p}</option>`).join('')}</select></label>${textField('新广告组名称', 'groupName', b.groupName, readonly)}${textField('父计划所在账户编号', 'parent.accountId', b.parentCampaign?.accountId || '', readonly)}${textField('父计划编号', 'parent.campaignId', b.parentCampaign?.campaignId || '', readonly)}${textField('父计划名称', 'parent.name', b.parentCampaign?.name || '', readonly)}</div>` : `<fieldset ${disabled}><legend>计划投放的平台</legend><div class="checks">${platforms.map(p => `<label class="check"><input type="checkbox" data-platform="${p}" ${b.platforms.includes(p) ? 'checked' : ''}>${p}</label>`).join('')}</div></fieldset>`}<div class="section-divider"></div><div class="form-grid">${b.platforms.map(p => `<label class="field"><span>${p} · 日预算（账户币种待核对）</span><input type="number" min="0" step="0.01" data-budget="${p}" value="${escape(b.budgets[p] ?? '')}" ${readonly}><small>${b.operation === 'new_group' ? '仅记录预算意向；父计划与广告组预算层级需接入后核对。' : '仅保存方案数字，不向广告账户设置预算。'}</small></label>`).join('') || '<p class="muted small">选择平台后填写预算；也可以先保存未完成的草稿。</p>'}</div></section><section class="card"><h2>时间安排</h2><div class="form-grid"><label class="field"><span>计划开始时间</span><input type="datetime-local" data-brief-field="startAt" value="${escape(b.startAt)}" ${readonly}></label>${textField('时区', 'timeZone', b.timeZone, `${readonly} placeholder="Asia/Shanghai"`)}</div><div class="notice">先保存投放需求，再继续选择素材和落地页。修改需求后，已通过的审核需要重新确认。</div></section>${e.recovery ? `<details class="card"><summary>查看刚才保留的本地输入</summary><div class="notice">${escape(e.recovery.title)}</div>${briefSummary(e.recovery.brief)}${e.recovery.workflow ? workflowRecoveryView(e.recovery.workflow) : ''}${e.recovery.executionDraft?.length ? `<h3>尚未保存的账户与搭建设置</h3>${executionTargetSummary(e.recovery.executionDraft)}` : ''}${e.recovery.importText ? `<h3>尚未导入的生成结果</h3><pre class="workflow-snapshot">${escape(e.recovery.importText)}</pre>` : ''}${e.recovery.reviewNote ? `<p class="small">尚未提交的意见：${escape(e.recovery.reviewNote)}</p>` : ''}</details>` : ''}<div class="form-footer"><span class="muted small">${canEdit() ? '只有点击保存后，本次修改才会写入团队工作区。' : '当前角色只能查看，无法修改方案。'}</span><div class="row">${canEdit() && e.id ? `<button type="button" class="btn ${e.status === 'archived' ? '' : 'btn-quiet'}" data-action="${e.status === 'archived' ? 'restore-proposal' : 'archive-proposal'}" ${state.busy || e.dirty || e.workflowDirty || e.conflict ? 'disabled' : ''}>${e.status === 'archived' ? '恢复为草稿' : '归档方案'}</button>` : ''}${editable ? `<button type="submit" class="btn btn-primary" ${state.busy || e.conflict || e.saveUncertain ? 'disabled' : ''}>${state.busy ? '正在保存…' : e.saveUncertain ? '保存结果待核对' : '保存草稿'}</button>` : ''}</div></div></form>`}${e.saveUncertain ? `<section class="banner banner-warn"><p>刚才的保存结果无法确认。输入已保留，请先检查服务器记录。</p><div class="row" style="margin-top:10px">${button(e.id ? '查看服务器最新版本' : '查看服务器方案列表', e.id ? 'load-latest' : 'verify-new-save')}${button('我已核对，允许再次保存', 'ack-save-uncertain')}</div></section>` : ''}`;
}
function versionsView(editor) {
  return `<section class="card"><h2>历史版本</h2><p class="card-description">只读查看每次保存时的内容，不会自动替换当前编辑。</p>${(editor.versions || []).map(v => `<details class="history-item"><summary>V${escape(v.revision)} · ${escape(v.title)} · ${date(v.createdAt)} · ${escape(person(v.actor))}</summary><div class="notice">记录状态：${v.status === 'archived' ? '已归档' : '未归档'}</div>${briefSummary(v.brief)}${v.workflow ? `<h3>本版本资源与文案</h3>${workflowSnapshotSummary(v.workflow)}` : ''}</details>`).join('') || '<div class="empty">尚无可显示的历史版本。</div>'}</section>`;
}
const actionNames = { 'proposal.status_changed': '归档或恢复方案', 'invitation.revoked': '取消邀请', 'material.created': '添加素材', 'material.updated': '更新素材', 'audience.created': '导入人群包', 'audience.updated': '更新人群包资料', 'landing.created': '添加落地页', 'landing.updated': '更新落地页资料', 'landing.sitemap_synced': '更新官网落地页', 'planning.updated': '保存资源或文案', 'planning.generation_prepared': '准备 Codex 生成要求', 'planning.generation_imported': '导入 Codex 文案', 'tracking.config_updated': '更新 UTM 规则', 'tracking.generated': '生成追踪链接', 'review.submit': '提交人工审核', 'review.approve': '审核通过', 'review.request_changes': '退回修改', 'review.reopen': '重新编辑方案', 'proposal.created': '创建方案', 'proposal.updated': '修改方案', 'proposal.archived': '归档方案', 'proposal.restored': '恢复方案', 'invitation.created': '生成邀请', 'invitation.cancelled': '取消邀请', 'invitation.accepted': '接受邀请', 'member.updated': '修改成员设置', 'member.disabled': '停用成员', 'member.role_changed': '修改成员角色', 'team.created': '创建团队', 'connector.pairing_created': '准备连接个人 Codex', 'connector.paired': '电脑提交连接请求', 'connector.confirmed': '确认连接个人 Codex', 'connector.revoked': '断开个人 Codex', 'generation.queued': '交给个人 Codex 生成', 'generation.claimed': 'Codex 开始生成', 'generation.succeeded': 'Codex 文案自动回填', 'generation.failed': 'Codex 生成未完成', 'generation.cancelled': '取消 Codex 生成', 'generation.stale': '生成结果与当前方案不一致', 'generation.needs_attention': 'Codex 任务需要处理' };
function auditTable(items) {
  return `<section class="card"><div class="table-wrap"><table><thead><tr><th>时间（北京时间）</th><th>操作</th><th>操作人</th><th>关联方案 / 版本</th></tr></thead><tbody>${items.map(item => `<tr><td>${date(item.createdAt)}</td><td>${escape(actionNames[item.action] || item.action)}</td><td>${escape(person(item.actor))}</td><td>${item.proposalId ? `<button class="table-link" type="button" data-open-proposal="${escape(item.proposalId)}">查看方案${item.revision ? ' · V' + escape(item.revision) : ''}</button>` : '团队操作'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">当前范围没有操作记录。</td></tr>'}</tbody></table></div></section>`;
}
function auditView() {
  return title('操作记录', '查看最近 500 条服务器操作记录，包括操作人、方案和版本。') + `<section class="card"><label class="field"><span>查看范围</span><select data-audit-filter><option value="">全部团队操作</option>${state.items.map(item => `<option value="${escape(item.id)}" ${state.auditProposalId === item.id ? 'selected' : ''}>${escape(item.title)}</option>`).join('')}</select></label></section>` + auditTable(state.audits);
}
function teamView() {
  const data = state.teamData;
  const basic = title('团队设置', '管理成员访问权限；浏览器搭建和启用任务也会检查本人权限。') + `<section class="card"><h2>${escape(state.me.team.name)}</h2><p class="small">你的角色：${escape(roles[state.me.role])}</p><div class="notice">管理员可管理成员和邀请；编辑成员可创建、修改方案；只读成员可查看方案及历史。</div></section>`;
  if (!canManage()) return basic + '<section class="card"><p class="muted small">成员邀请、停用和角色修改由团队管理员处理。</p></section>';
  if (!data) return basic + '<section class="card"><p class="muted">团队成员尚未加载，请刷新数据。</p></section>';
  return basic + `<section class="card"><h2>邀请成员</h2><p class="card-description">生成邀请链接后，由你自行发送。系统当前不会自动发送邮件。</p><form id="invite-form"><fieldset ${state.busy ? 'disabled' : ''}><div class="form-grid"><label class="field"><span>受邀邮箱</span><input name="email" type="email" required value="${escape(state.inviteEmail)}" data-invite-email autocomplete="off"></label><label class="field"><span>加入后的角色</span><select name="role" data-invite-role>${Object.entries(roles).map(([key, label]) => `<option value="${key}" ${state.inviteRole === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div><div class="form-footer"><button class="btn btn-primary" type="submit">生成邀请链接</button></div></fieldset></form>${state.inviteLink ? `<div class="banner banner-info" style="margin-top:18px"><h3>邀请链接已生成</h3><p class="small">链接只在这次生成后显示，请复制给受邀成员。离开本页后不会再次显示。</p><label class="field" style="margin-top:10px"><span>邀请链接</span><textarea class="invite-link" id="new-invite-link" readonly>${escape(state.inviteLink)}</textarea></label><div class="row" style="margin-top:10px">${button('复制邀请链接', 'copy-invite')}${button('我已保存，关闭显示', 'dismiss-invite')}</div></div>` : ''}</section><section class="card"><h2>团队成员</h2><div class="table-wrap"><table><thead><tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>${data.members.map(member => `<tr><td>${escape(member.name)}<span class="cell-note">${escape(member.email)}</span>${member.id === state.me.user.id ? '<span class="cell-note">当前账号</span>' : ''}</td><td><select class="plain-select member-role" aria-label="${escape(member.name)}的角色" data-member-role="${escape(member.id)}" ${state.busy ? 'disabled' : ''}>${Object.entries(roles).map(([key, label]) => `<option value="${key}" ${member.role === key ? 'selected' : ''}>${label}</option>`).join('')}</select></td><td>${badge(member.status === 'active' ? '正常' : '已停用', member.status === 'active' ? 'green' : 'warn')}</td><td><div class="row"><button class="btn btn-small" type="button" data-save-member="${escape(member.id)}" ${state.busy ? 'disabled' : ''}>保存角色</button><button class="btn btn-small ${member.status === 'active' ? 'btn-danger' : ''}" type="button" data-member-status="${escape(member.id)}" data-next-status="${member.status === 'active' ? 'disabled' : 'active'}" ${state.busy || member.id === state.me.user.id ? 'disabled' : ''}>${member.status === 'active' ? '停用' : '恢复'}</button></div></td></tr>`).join('')}</tbody></table></div></section><section class="card"><h2>邀请记录</h2><div class="table-wrap"><table><thead><tr><th>邮箱</th><th>角色</th><th>状态 / 有效期</th><th>操作</th></tr></thead><tbody>${data.invitations.map(item => `<tr><td>${escape(item.email)}</td><td>${escape(roles[item.role] || item.role)}</td><td>${escape(({ pending: '待接受', accepted: '已接受', cancelled: '已取消', expired: '已过期' })[item.status] || item.status)}<span class="cell-note">${date(item.expiresAt)}</span></td><td>${item.status === 'pending' ? `<button class="btn btn-small" type="button" data-cancel-invite="${escape(item.id)}" ${state.busy ? 'disabled' : ''}>取消邀请</button>` : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">尚无邀请记录。</td></tr>'}</tbody></table></div></section>`;
}
function render() {
  document.body.setAttribute('aria-busy', String(state.busy));
  if (state.loading) { root.innerHTML = header() + '<main class="initial-loading" id="main-content" aria-live="polite">正在检查登录和团队信息…</main>'; return; }
  if (!state.me) { root.innerHTML = header() + (state.noMembership ? noMembershipView() : authView()); return; }
  const content = state.view === 'editor' ? editorView() : ({ overview: overviewView, proposals: proposalsView, resources: resourcesView, landings: landingsView, tracking: trackingView, codex: codexView, builds: buildsView, reporting: reportingView, audit: auditView, team: teamView }[state.view] || overviewView)();
  root.innerHTML = header() + `<div class="app-layout">${nav()}<main class="content" id="main-content">${banner()}${content}<div class="footer-note">${escape(state.me.team.name)} · 方案与历史由团队服务器保存 · <button class="table-link" type="button" data-action="refresh">刷新数据</button></div></main></div>`;
}

async function loadIdentity() {
  try {
    const me = await api('/api/me', { sessionCheck: true });
    if ((state.dataContext && (state.dataContext.userId !== me.user.id || state.dataContext.teamId !== me.team.id)) || (state.editor?.context && (state.editor.context.userId !== me.user.id || state.editor.context.teamId !== me.team.id))) {
      state.editor = null; state.items = []; state.counts = null; state.audits = []; state.view = 'overview'; state.teamData = null; state.inviteLink = ''; clearResourceState();
    }
    state.dataContext = {userId: me.user.id, teamId: me.team.id};
    state.me = me;
    if (!state.me.permissions?.canManage) { state.teamData = null; state.inviteLink = ''; }
    state.account = state.me.user; state.noMembership = false; return true;
  } catch (error) {
    if (error.status === 401) { state.me = null; state.account = null; state.noMembership = false; return false; }
    if (error.status === 403 && error.code === 'MEMBER_DISABLED') { state.me = null; state.account = null; state.noMembership = false; state.items = []; state.counts = null; state.audits = []; state.teamData = null; state.inviteLink = ''; state.authMode = 'login'; clearResourceState(); notify(error.message, 'error'); return false; }
    if (error.status === 403 && error.code === 'NO_MEMBERSHIP') { state.me = null; state.noMembership = true; state.account = state.account || { name: '已登录账号' }; return false; }
    throw error;
  }
}
async function loadItems() { const result = await api('/api/proposals'); state.items = result.items || []; state.counts = result.counts || null; }
async function loadAudit() { const query = state.auditProposalId ? '?proposalId=' + encodeURIComponent(state.auditProposalId) : ''; state.audits = (await api('/api/audit' + query)).items || []; }
async function loadTeam() { state.teamData = await api('/api/team'); }
async function loadWorkspace() {
  if (!(await loadIdentity())) return false;
  await loadItems();
  if (state.view === 'team' && canManage()) await loadTeam();
  if (state.view === 'audit') await loadAudit();
  if (['resources', 'landings'].includes(state.view)) await loadResources();
  if (state.view === 'tracking') await loadTracking();
  if (state.view === 'codex') await loadConnectors();
  if (state.view === 'builds') await loadBuilds();
  if (state.view === 'reporting') await loadReporting();
  return true;
}
function makeEditor(item) {
  return { id: item?.id || null, title: item?.title || '', brief: normalizedBrief(item?.brief), revision: item?.revision || 0, status: item?.status || 'draft', updatedAt: item?.updatedAt || '', dirty: !item, versions: [], audit: [], conflict: null, saveUncertain: false, recovery: null, workflow: null, workflowDirty: false, workflowDirtyFields: {}, landingRecommendations: [], workflowUncertain: false, importText: '', reviewNote: '', jobs: [], jobsLoaded: false, selectedConnectorId: '', manualGenerationOpen: false, jobReloadAvailable: null, executionData: null, executionDraft: null, executionDirty: false, executionUncertain: false, executionError: '', executionConnectorId: '', context: { userId: state.me?.user?.id, teamId: state.me?.team?.id } };
}
async function loadEditorHistory(editor) {
  const results = await Promise.allSettled([api('/api/proposals/' + encodeURIComponent(editor.id) + '/versions'), api('/api/audit?proposalId=' + encodeURIComponent(editor.id))]);
  if (results[0].status === 'fulfilled') editor.versions = results[0].value.items || [];
  if (results[1].status === 'fulfilled') editor.audit = results[1].value.items || [];
  const failed = results.filter(result => result.status === 'rejected');
  if (failed.length) {
    const authError = failed.find(result => result.reason.status === 401);
    if (authError) throw authError.reason;
    notify('方案内容已加载，部分历史记录未能取得，可以稍后刷新。', 'warn');
  }
}
function mayReplaceEditor() { return !editorHasChanges() || window.confirm('当前方案有未保存的输入。确定放弃这些输入并打开另一份方案吗？'); }
async function openProposal(id) {
  if (state.editor?.id === id && editorHasChanges()) { state.view = 'editor'; return; }
  if (state.editor?.id !== id && !mayReplaceEditor()) return;
  const result = await api('/api/proposals/' + encodeURIComponent(id));
  state.editor = makeEditor(result.item); state.editorTab = 'edit'; state.view = 'editor';
  await Promise.all([loadEditorHistory(state.editor), loadWorkflow(state.editor), loadResources(), loadConnectors(), loadGenerationJobs(state.editor)]);
}
async function saveProposal(status) {
  const editor = state.editor;
  if (!canEdit() || !editor) return;
  if (!editor.title.trim()) { notify('请先填写方案名称。', 'warn'); return; }
  if (editor.executionDirty || editor.executionUncertain) { notify('请先保存或核对账户与搭建设置，再保存投放需求。', 'warn'); return; }
  if (editor.workflowDirty) { notify('请先到对应步骤保存素材选择或文案，再保存投放需求。', 'warn'); return; }
  if (editor.conflict) { notify('请先查看最新版本并明确选择如何继续。', 'warn'); return; }
  const body = { title: editor.title.trim(), brief: clone(editor.brief), ...(status ? { status } : {}) };
  if (editor.id) body.expectedRevision = editor.revision;
  let result;
  try {
    result = await api(editor.id ? '/api/proposals/' + encodeURIComponent(editor.id) : '/api/proposals', { method: editor.id ? 'PATCH' : 'POST', body });
  } catch (error) {
    if (error.status === 409 && error.code === 'REVISION_CONFLICT') {
      editor.conflict = { latest: error.payload?.current?.item || error.payload?.current || null, reviewed: false };
      notify('保存遇到版本冲突。你的输入完整保留，请查看服务器最新版本。', 'warn');
      return;
    } else {
      if (error.status === 0) editor.saveUncertain = true;
      throw error;
    }
  }
  state.editor = makeEditor(result.item); state.editor.importText = editor.importText || ''; state.editor.reviewNote = editor.reviewNote || ''; state.view = 'editor';
  state.items = [result.item, ...state.items.filter(item => item.id !== result.item.id)];
  notify(status === 'archived' ? '方案已归档。广告平台没有发生变化。' : status === 'draft' ? '方案已恢复为草稿。' : '草稿已保存到团队工作区。');
  const refresh = await Promise.allSettled([loadItems(), loadEditorHistory(state.editor), loadWorkflow(state.editor), loadResources(), loadConnectors(), loadGenerationJobs(state.editor)]);
  const authFailure = refresh.find(item => item.status === 'rejected' && item.reason.status === 401);
  if (authFailure) throw authFailure.reason;
  if (refresh.some(item => item.status === 'rejected')) notify('保存已完成，但列表或历史记录刷新未完成。请稍后刷新；无需再次提交保存。', 'warn');
}
async function login(form) {
  const values = new FormData(form), email = String(values.get('email') || '').trim(), password = String(values.get('password') || '');
  state.authEmail = email;
  await perform(async () => {
    const result = await api('/api/auth/sign-in/email', { method: 'POST', body: { email, password }, sessionCheck: true });
    state.account = result.user || { email }; notify('已登录。'); await loadWorkspace();
  });
}
async function register(form) {
  const values = new FormData(form), name = String(values.get('name') || '').trim(), password = String(values.get('password') || '');
  await perform(async () => {
    await api('/api/invitations/register', { method: 'POST', body: { token: state.inviteToken, name, password }, sessionCheck: true });
    state.authEmail = state.invitation.email; state.authMode = 'login'; notify('注册已完成，请使用刚才设置的密码登录。');
  });
}
async function bootstrap(form) {
  const values = new FormData(form);
  const body = Object.fromEntries(['token', 'teamName', 'name', 'email', 'password'].map(key => [key, String(values.get(key) || '')]));
  await perform(async () => {
    await api('/api/bootstrap', { method: 'POST', body, sessionCheck: true });
    state.needsSetup = false; state.authMode = 'login'; state.authEmail = body.email.trim(); notify('团队与管理员已创建，请登录。');
  });
}
async function acceptInvitation() {
  await api('/api/invitations/accept', { method: 'POST', body: { token: state.inviteToken } });
  state.inviteToken = ''; state.invitation = null;
  history.replaceState(null, '', location.pathname + location.search);
  notify('邀请已接受。'); state.view = 'overview'; await loadWorkspace();
}
async function navigate(view) {
  if (state.view === 'team' && view !== 'team') state.inviteLink = '';
  if (state.view === 'codex' && view !== 'codex') state.pairing = null;
  state.view = view; state.message = '';
  if (view === 'audit') await loadAudit();
  if (view === 'team' && canManage()) await loadTeam();
  if (['resources', 'landings'].includes(view)) await loadResources();
  if (view === 'tracking') await loadTracking();
  if (view === 'codex') await loadConnectors();
  if (view === 'builds') await loadBuilds();
  if (view === 'reporting') await loadReporting();
}
function markEditorDirty() {
  if (!state.editor) return;
  state.editor.dirty = true;
  const indicator = root.querySelector?.('[data-editor-save-state]');
  if (indicator) indicator.textContent = '有未保存的修改';
  const archive = root.querySelector?.('[data-action="archive-proposal"]');
  if (archive) archive.disabled = true;
}
function setBrief(field, value) {
  const e = state.editor; if (!e || !canEdit() || e.status === 'archived') return;
  if (field === 'title') e.title = value;
  else if (field.startsWith('parent.')) e.brief.parentCampaign = { ...(e.brief.parentCampaign || {}), platform: e.brief.platforms[0] || 'Google', [field.slice(7)]: value };
  else e.brief[field] = value;
  markEditorDirty();
}

root.addEventListener('submit', event => {
  event.preventDefault(); if (state.busy) return;
  const form = event.target;
  if (form.id === 'login-form') { void login(form); return; }
  if (form.id === 'register-form') { void register(form); return; }
  if (form.id === 'setup-form') { void bootstrap(form); return; }
  if (form.id === 'proposal-form') { void perform(() => saveProposal()); return; }
  if (form.id === 'invite-form') {
    const values = new FormData(form), body = { email: String(values.get('email') || '').trim(), role: String(values.get('role') || 'editor') };
    void perform(async () => {
      const result = await api('/api/invitations', { method: 'POST', body });
      state.inviteLink = result.inviteUrl || ''; state.inviteEmail = ''; notify('邀请已生成，请复制链接自行发送；没有发送邮件。'); await loadTeam();
    });
  }
});
root.addEventListener('input', event => {
  const el = event.target;
  if (el.dataset.editField) setBrief(el.dataset.editField, el.value);
  if (el.dataset.briefField && !['operation', 'objective'].includes(el.dataset.briefField)) setBrief(el.dataset.briefField, el.value);
  if (el.dataset.budget && state.editor && canEdit()) { if (el.value === '') delete state.editor.brief.budgets[el.dataset.budget]; else state.editor.brief.budgets[el.dataset.budget] = Number(el.value); markEditorDirty(); }
  if (el.hasAttribute('data-invite-email')) state.inviteEmail = el.value;
});
root.addEventListener('change', event => {
  const el = event.target;
  if (el.hasAttribute('data-invite-role')) state.inviteRole = el.value;
  if (el.hasAttribute('data-audit-filter')) { state.auditProposalId = el.value; void perform(loadAudit); return; }
  const e = state.editor; if (!e || !canEdit() || e.status === 'archived') return;
  if (el.dataset.briefField) {
    setBrief(el.dataset.briefField, el.value);
    if (el.dataset.briefField === 'operation') {
      if (el.value === 'new_group') { const platform = e.brief.platforms[0] || 'Google'; e.newCampaignPlatforms = e.brief.platforms.slice(); e.brief.platforms = [platform]; e.brief.parentCampaign = { ...(e.brief.parentCampaign || {}), platform }; }
      else { e.brief.platforms = e.newCampaignPlatforms || e.brief.platforms; e.brief.parentCampaign = null; }
      render();
    }
  }
  if (el.dataset.platform) { e.brief.platforms = el.checked ? [...new Set([...e.brief.platforms, el.dataset.platform])] : e.brief.platforms.filter(p => p !== el.dataset.platform); e.dirty = true; render(); }
  if (el.hasAttribute('data-group-platform')) { e.brief.platforms = [el.value]; e.brief.parentCampaign = { ...(e.brief.parentCampaign || {}), platform: el.value }; e.dirty = true; render(); }
});
root.addEventListener('click', event => {
  const el = event.target.closest('button'); if (!el || el.disabled || state.busy) return;
  if (el.dataset.authMode) { state.authMode = el.dataset.authMode; state.message = ''; render(); return; }
  if (el.dataset.switchResource) state.resourceTab = el.dataset.switchResource;
  if (el.dataset.nav) { void perform(() => navigate(el.dataset.nav)); return; }
  if (el.dataset.openProposal) { void perform(() => openProposal(el.dataset.openProposal)); return; }
  if (el.dataset.editorTab) { state.editorTab = el.dataset.editorTab; render(); if (el.dataset.editorTab === 'content') void pollCodex(true); if (el.dataset.editorTab === 'execution') void perform(() => loadExecution(state.editor)); return; }
  if (handleExecutionClick(el)) return;
  if (handleReportingClick(el)) return;
  if (handleCodexClick(el)) return;
  if (handlePhaseClick(el)) return;
  if (el.dataset.cancelInvite) {
    if (!window.confirm('取消这条尚未接受的邀请？')) return;
    void perform(async () => { await api('/api/invitations/' + encodeURIComponent(el.dataset.cancelInvite), { method: 'DELETE' }); notify('邀请已取消。'); state.inviteLink = ''; await loadTeam(); }); return;
  }
  if (el.dataset.saveMember) {
    const id = el.dataset.saveMember, select = [...root.querySelectorAll('[data-member-role]')].find(node => node.dataset.memberRole === id);
    if (!select) return; const role = select.value;
    void perform(async () => { await api('/api/members/' + encodeURIComponent(id), { method: 'PATCH', body: { role } }); await loadIdentity(); if (canManage()) await loadTeam(); notify('成员角色已更新。'); }); return;
  }
  if (el.dataset.memberStatus) {
    const status = el.dataset.nextStatus; if (!window.confirm(status === 'disabled' ? '停用后，该成员将无法继续访问团队工作区。确定停用？' : '恢复该成员的团队访问权限？')) return;
    void perform(async () => { await api('/api/members/' + encodeURIComponent(el.dataset.memberStatus), { method: 'PATCH', body: { status } }); notify(status === 'disabled' ? '成员已停用。' : '成员已恢复。'); await loadTeam(); }); return;
  }
  const action = el.dataset.action;
  if (!action) return;
  if (action === 'new-proposal') { if (!mayReplaceEditor()) return; state.editor = makeEditor(); state.editorTab = 'edit'; state.view = 'editor'; state.message = ''; render(); return; }
  if (action === 'resume-editor') { void perform(async () => { state.view = 'editor'; if (state.editor?.id && !editorHasChanges()) await Promise.all([loadWorkflow(state.editor), loadEditorHistory(state.editor), loadResources(), loadConnectors(), loadGenerationJobs(state.editor)]); }); return; }
  if (action === 'dismiss-invite') { state.inviteLink = ''; render(); return; }
  if (action === 'copy-invite') {
    void (async () => { try { await navigator.clipboard.writeText(state.inviteLink); notify('邀请链接已复制，请自行发送给受邀成员。'); } catch { notify('请手动复制已选中的邀请链接。', 'warn'); render(); const field = document.getElementById('new-invite-link'); field?.focus(); field?.select(); return; } render(); })(); return;
  }
  if (action === 'adopt-latest' || action === 'rebase-local') {
    const e = state.editor, latest = e?.conflict?.latest;
    if (!e || !latest || !e.conflict.reviewed) return;
    if (action === 'adopt-latest') { const recovery = { title: e.title, brief: clone(e.brief), workflow: clone(e.workflow), executionDraft: clone(e.executionDraft), importText: e.importText, reviewNote: e.reviewNote }; state.editor = makeEditor(latest); state.editor.workflow = e.conflict.latestWorkflow || null; state.editor.recovery = recovery; notify('已载入最新内容。你刚才的输入保留在下方，只读可查看。'); }
    else { e.revision = latest.revision; e.status = latest.status; e.conflict = null; e.saveUncertain = false; e.workflowUncertain = false; e.executionUncertain = false; if (!e.workflowDirty && !e.executionDirty) e.dirty = true; notify('你的输入已保留，并改为基于最新版本编辑。请核对差异后主动保存；尚未覆盖服务器内容。', 'warn'); }
    state.editorTab = 'edit'; render(); return;
  }
  if (action === 'ack-save-uncertain') { if (!window.confirm('确认已检查服务器记录，并决定再次提交当前输入？')) return; state.editor.saveUncertain = false; notify('已解除保存结果待核对状态。请确认后再保存。', 'warn'); render(); return; }
  void perform(async () => {
    if (action === 'logout') { if (editorHasChanges() && !window.confirm('有未保存的方案输入。仍要退出登录吗？')) return; await api('/api/auth/sign-out', { method: 'POST', body: {} }); state.me = null; state.account = null; state.noMembership = false; state.editor = null; state.view = 'overview'; state.items = []; state.counts = null; state.audits = []; state.inviteLink = ''; state.teamData = null; clearResourceState(); notify('已退出登录。'); }
    if (action === 'accept-invitation') await acceptInvitation();
    if (action === 'all-proposals') await navigate('proposals');
    if (action === 'refresh') { if (!(await loadWorkspace())) { notify(state.noMembership ? '当前账号尚未加入可访问的团队。' : '登录已失效，请重新登录。未保存的输入仍在当前页面。', 'warn'); return; } if (state.view === 'editor' && state.editor?.id && !editorHasChanges()) { const result = await api('/api/proposals/' + encodeURIComponent(state.editor.id)); state.editor = makeEditor(result.item); await Promise.all([loadEditorHistory(state.editor), loadWorkflow(state.editor), loadResources(), loadConnectors(), loadGenerationJobs(state.editor)]); } notify('服务器数据已刷新。未保存的方案输入不会被覆盖。'); }
    if (action === 'archive-proposal') { if (editorHasChanges()) { notify('请先保存当前修改，再归档方案。', 'warn'); return; } if (window.confirm('将这份方案归档？不会改变任何广告平台状态。')) await saveProposal('archived'); }
    if (action === 'restore-proposal') await saveProposal('draft');
    if (action === 'load-latest') { const e = state.editor, result = await api('/api/proposals/' + encodeURIComponent(e.id) + '/workflow'); e.conflict = { latest: result.item, latestWorkflow: result.workflow, reviewed: true }; notify('服务器最新版本已显示，你的本地输入尚未改变。', 'warn'); }
    if (action === 'verify-new-save') { await loadItems(); state.view = 'proposals'; notify('已更新服务器方案列表。请检查是否已有刚才提交的方案；本地输入仍可继续查看。', 'warn'); }
  });
});

window.addEventListener('beforeunload', event => { if (editorHasChanges() || state.resourceDirty || state.trackingDirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('hashchange', () => {
  const token = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
  if (token === state.inviteToken) return;
  state.inviteToken = token; state.invitation = null; state.inviteError = '';
  if (token) void perform(inspectInvitation); else render();
});
async function inspectInvitation() {
  if (!state.inviteToken) return;
  try { state.invitation = await api('/api/invitations/inspect', { method: 'POST', body: { token: state.inviteToken }, sessionCheck: true }); state.inviteError = ''; }
  catch (error) { state.invitation = null; state.inviteError = error.message; }
}
async function start() {
  render();
  try {
    const results = await Promise.allSettled([api('/api/bootstrap/status', { sessionCheck: true }), inspectInvitation()]);
    if (results[0].status === 'fulfilled') state.needsSetup = Boolean(results[0].value.needsSetup);
    else throw results[0].reason;
    if (state.needsSetup) state.authMode = 'setup';
    await loadWorkspace();
  } catch (error) { fail(error); }
  finally { state.loading = false; render(); }
}


// Resource libraries and the reviewed proposal use server-owned versions.
const audienceTypes = { historical_paid: '历史付费用户', current_paid: '当前订阅用户', active_users: '使用人群', campaign_participants: '活动人群', custom: '自定义人群' };
const sourceNames = { upload: '手动上传', supplier: '供应商素材', creator: '达人素材' };
const reviewNames = { draft: '待完善', in_review: '待人工审核', changes_requested: '需要修改', approved: '审核通过' };
const emptySelection = () => ({materials: [], audiences: [], landing: null});
const safeHref = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? escape(url.href) : '#'; } catch { return '#'; } };
const lines = value => String(value || '').split('\n').map(v => v.trim()).filter(Boolean);
const editorHasChanges = () => Boolean(state.editor?.dirty || state.editor?.workflowDirty || state.editor?.workflowUncertain || state.editor?.executionDirty || state.editor?.executionUncertain || state.editor?.importText?.trim() || state.editor?.reviewNote?.trim());
function clearResourceState() {
  state.resources = {materials: [], audiences: [], landings: [], sitemap: {}};
  state.libraryDrafts = {}; state.libraryEdits = {}; state.resourceFiles = {};
  state.resourceDirty = false; state.trackingConfig = null; state.trackingDraft = null; state.trackingItems = []; state.trackingDirty = false; state.trackingConflict = null; state.sitemapInput = ''; state.sitemapDiscovery = null; state.sitemapSelection = []; state.sitemapSelectionDirty = false; state.landingSearch = ''; state.landingLanguage = ''; state.landingLimit = 60;
  state.connectors = []; state.connectorsLoaded = false; state.codexConfirmation = null; state.connectorError = ''; state.pairing = null; state.codexPollAt = 0; state.builds = []; state.buildsLoaded = false; state.buildDetail = null; state.buildPreview = null; state.buildConfirmation = null;
  state.reporting = {data: null, accountId: '', reportDate: '', campaignId: '', detail: null, detailKey: '', error: '', accountInput: '', scheduleDrafts: {}};
}
async function loadResources() {
  const result = await api('/api/resources');
  state.resources = {materials: result.materials || [], audiences: result.audiences || [], landings: result.landings || [], sitemap: result.sitemap || {}};
  if (!state.sitemapInput) state.sitemapInput = state.resources.sitemap.url || '';
  if (!state.sitemapSelectionDirty && state.sitemapInput === state.resources.sitemap.url) state.sitemapSelection = [...(state.resources.sitemap.selectedSitemaps || [])];
}
async function loadTracking() {
  const [configuration, registry] = await Promise.all([api('/api/tracking-config'), api('/api/tracking')]);
  if (state.trackingDirty && state.trackingConfig && state.trackingConfig.revision !== configuration.item.revision) state.trackingConflict = {latest: configuration.item, reviewed: false};
  else { state.trackingConfig = configuration.item; if (!state.trackingDirty) state.trackingDraft = {...clone(configuration.item), name: configuration.item.name || '团队UTM规则'}; }
  state.trackingItems = registry.items || [];
}
function libraryDraft(kind) {
  if (!state.libraryDrafts[kind]) state.libraryDrafts[kind] = kind === 'materials' ? {name: '', source: 'upload', sourceUrl: '', mediaType: 'image', notes: '', adCode: ''} : kind === 'audiences' ? {name: '', type: 'custom', description: '', authorized: false} : {name: '', url: '', description: '', tags: [], language: 'English', objective: 'both'};
  return state.libraryDrafts[kind];
}
const resourceInput = (kind, field, label, value, extra = '') => `<label class="field"><span>${label}</span><input data-library-kind="${kind}" data-library-field="${field}" value="${escape(value)}" ${extra} ${state.busy || !canEdit() ? 'disabled' : ''}></label>`;
function resourceForm(kind) {
  const d = libraryDraft(kind), edit = state.libraryEdits[kind], file = state.resourceFiles[kind];
  const disabled = state.busy ? 'disabled' : '';
  return `<section class="card"><div class="spread"><h2>${edit ? '编辑' : '添加'}${kind === 'materials' ? '素材' : kind === 'audiences' ? '人群包' : '落地页'}</h2>${edit ? button('取消编辑', 'cancel-library-' + kind) : ''}</div><form data-resource-form="${kind}"><fieldset ${disabled}><div class="form-grid">${resourceInput(kind, 'name', '名称', d.name, 'required maxlength="120"')}${kind === 'materials' ? `<label class="field"><span>素材来源</span><select data-library-kind="materials" data-library-field="source">${Object.entries(sourceNames).map(([key, label]) => `<option value="${key}" ${d.source === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field"><span>素材形式</span><select data-library-kind="materials" data-library-field="mediaType"><option value="image" ${d.mediaType === 'image' ? 'selected' : ''}>图片</option><option value="video" ${d.mediaType === 'video' ? 'selected' : ''}>视频</option></select></label>${resourceInput(kind, 'sourceUrl', '来源文档或素材链接（选填）', d.sourceUrl, 'type="url" maxlength="2048" placeholder="https://…"')}${resourceInput(kind, 'adCode', '达人广告代码（选填）', d.adCode, 'autocomplete="off" maxlength="1000" placeholder="仅适用达人视频；已有代码不会在网页中回显"')}<label class="field"><span>${edit ? '上传新版本（选填）' : '上传素材文件'}</span><input type="file" data-resource-file="materials" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"><small>${file ? '已选：' + escape(file.name) : '支持 PNG、JPG、WebP、GIF、MP4、WebM；单个不超过 100 MB。'}</small></label><label class="field full"><span>素材内容与使用说明</span><textarea data-library-kind="materials" data-library-field="notes" maxlength="3000">${escape(d.notes)}</textarea><small>写清素材主题、适用人群和使用范围，供 Codex 理解。</small></label>` : kind === 'audiences' ? `<label class="field"><span>人群类型</span><select data-library-kind="audiences" data-library-field="type">${Object.entries(audienceTypes).map(([key, label]) => `<option value="${key}" ${d.type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field full"><span>人群口径说明</span><textarea data-library-kind="audiences" data-library-field="description" maxlength="2000">${escape(d.description)}</textarea><small>例如“历史上至少成功付费一次”。未来可以增加数据库直接拉取。</small></label>${!edit ? `<label class="field full"><span>上传邮箱 CSV</span><input type="file" data-resource-file="audiences" accept=".csv,text/csv"><small>${file ? '已选：' + escape(file.name) : '不超过 5 MB，邮箱列名可用 email。后台会去重并转换为哈希值，页面只显示人数。'}</small></label><label class="check full"><input type="checkbox" data-library-kind="audiences" data-library-field="authorized" ${d.authorized ? 'checked' : ''} required>我确认该名单可以用于广告受众。</label>` : '<p class="small muted full">这里修改名称和口径说明。需要更新名单时，请上传为一个新的人群包，保留旧方案使用的版本。</p>'}` : `${resourceInput(kind, 'url', '广告点击后打开的页面', d.url, 'type="url" maxlength="2048" required placeholder="https://…"')}${resourceInput(kind, 'tags', '分类标签（用逗号分隔）', (d.tags || []).join(', '), 'placeholder="视频生成, 创作者, 活动"')}${resourceInput(kind, 'language', '页面语言', d.language, 'maxlength="80"')}<label class="field"><span>适用目标</span><select data-library-kind="landings" data-library-field="objective">${[['both', '注册和订阅'], ['registration', '网站注册'], ['first_subscription', '首次订阅']].map(([key, label]) => `<option value="${key}" ${d.objective === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label class="field full"><span>页面内容说明</span><textarea data-library-kind="landings" data-library-field="description" maxlength="3000">${escape(d.description)}</textarea><small>补充适用产品、场景与人群，帮助筛选落地页。</small></label>`}</div><div class="form-footer"><span class="small muted">${kind === 'materials' ? '文件由工作区配置的私有存储保存，登录后按团队权限访问。' : kind === 'audiences' ? '名单不会加入文案生成要求，也不会在此阶段上传到广告平台。' : '页面标签和内容说明由团队维护。'}</span><button class="btn btn-primary" type="submit">${edit ? '保存修改' : kind === 'materials' ? '保存素材' : kind === 'audiences' ? '导入人群包' : '保存落地页'}</button></div></fieldset></form></section>`;
}
function resourcesView() {
  const kind = state.resourceTab, items = state.resources[kind] || [];
  return title('素材与人群', '上传一次后从素材库选择；每份方案记录自己使用的资源版本。', button('刷新资源库', 'reload-resources')) + `<div class="tabs" role="tablist" aria-label="资源类型"><button class="tab" data-resource-tab="materials" aria-selected="${kind === 'materials'}">广告素材</button><button class="tab" data-resource-tab="audiences" aria-selected="${kind === 'audiences'}">人群包（选用）</button></div>${kind === 'materials' ? '<div class="banner banner-info">供应商和达人素材可登记原始飞书链接；将需要投放的文件下载后上传一次。记录来源链接本身不会自动下载文件。达人也可以登记广告代码。</div>' : '<div class="banner banner-info">人群包按需选择，可以用于包含或排除。无需每次投放都选择；“人群方向”与邮箱名单分别维护。</div>'}${canEdit() ? resourceForm(kind) : ''}<section class="card"><h2>${kind === 'materials' ? '素材库' : '人群库'} · ${items.length}</h2><div class="resource-grid">${items.map(item => `<article class="resource-card"><div class="spread"><h3>${escape(item.name)}</h3>${badge(item.status === 'archived' ? '已归档' : kind === 'materials' ? item.ready ? '可选用' : '待补文件或代码' : '已导入', item.status === 'archived' ? '' : kind === 'materials' && !item.ready ? 'warn' : 'green')}</div>${kind === 'materials' ? `<p>${escape(sourceNames[item.source] || item.source)} · ${item.mediaType === 'video' ? '视频' : '图片'} · V${item.revision}</p><p>${escape(item.notes || '尚无素材说明')}</p>${item.file ? `<p>${escape(item.file.name || '素材文件')} · ${((item.file.size || 0) / 1024 / 1024).toFixed(2)} MB</p><a class="btn btn-small" href="/api/materials/${encodeURIComponent(item.id)}/file?revision=${item.revision}" target="_blank" rel="noopener">查看已存文件 ↗</a>` : ''}${item.hasAdCode ? '<p>已保存达人广告代码</p>' : ''}${item.sourceUrl ? `<p><a href="${safeHref(item.sourceUrl)}" target="_blank" rel="noopener noreferrer">打开来源文档 ↗</a></p>` : ''}` : `<p>${escape(audienceTypes[item.type] || item.type)} · V${item.revision}</p><p>${escape(item.description || '尚无口径说明')}</p><p>去重后 ${escape(item.counts?.unique ?? item.uniqueCount ?? '未知')} 人 · 无效 ${escape(item.counts?.invalid ?? '未知')} 条 · 重复 ${escape(item.counts?.duplicate ?? '未知')} 条</p>`}<div class="row resource-actions">${canEdit() ? `<button class="btn btn-small" data-edit-resource="${escape(item.id)}" data-resource-kind="${kind}">编辑资料</button><button class="btn btn-small" data-archive-resource="${escape(item.id)}" data-resource-kind="${kind}" data-resource-status="${item.status === 'archived' ? 'active' : 'archived'}">${item.status === 'archived' ? '恢复' : '归档'}</button>` : ''}</div></article>`).join('') || '<div class="empty">资源库还没有内容。先添加需要投放的素材或人群。</div>'}</div></section>`;
}
function sitemapLabel(value) {
  try { const url = new URL(value); return decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || url.hostname); } catch { return value; }
}
function applySitemapDiscovery(discovery) {
  const children = Array.isArray(discovery?.children) ? discovery.children : [];
  state.sitemapDiscovery = {...discovery, children};
  state.sitemapSelection = state.sitemapSelection.filter(value => children.includes(value));
}
function sitemapScopeView() {
  const discovery = state.sitemapDiscovery;
  if (!discovery) return state.sitemapSelection.length ? `<div class="notice">上次保存的范围：${state.sitemapSelection.map(sitemapLabel).map(escape).join('、')}。可直接沿用，或点击“读取页面分类”重新选择。</div>` : '<p class="small muted notice">如果 sitemap 包含作品、用户主页等大量页面，请只选择产品、功能或活动相关的分类。</p>';
  if (discovery.kind === 'urlset') return '<div class="hint-box" style="margin-top:15px">这个 sitemap 直接列出页面，无需选择子分类。点击“更新落地页”读取。</div>';
  return `<div class="sitemap-scope"><h3>选择要加入落地页库的范围</h3><p class="small muted">只更新勾选的分类；建议选择产品、功能、活动等可用于广告落地的页面。作品和用户主页可以暂不加入。</p><div class="sitemap-choices">${discovery.children.map(value => `<label class="sitemap-choice"><input type="checkbox" data-sitemap-child value="${escape(value)}" ${state.sitemapSelection.includes(value) ? 'checked' : ''}><span><strong>${escape(sitemapLabel(value))}</strong><small>${escape(value)}</small></span></label>`).join('')}</div><p class="small muted" data-sitemap-count>已选择 ${state.sitemapSelection.length} 个分类</p></div>`;
}
async function syncSitemap() {
  if (state.sitemapDiscovery?.kind === 'sitemapindex' && !state.sitemapSelection.length) { notify('请先选择至少一个需要收录的页面分类。', 'warn'); return; }
  try {
    const result = await api('/api/landings/sync', {method: 'POST', body: {sitemapUrl: state.sitemapInput, ...(state.sitemapSelection.length ? {selectedSitemaps: [...state.sitemapSelection]} : {})}});
    state.sitemapSelectionDirty = false; await loadResources();
    const summary = result.result || result.summary;
    notify(summary ? `落地页更新完成：${summary.added !== undefined ? '新增 ' + summary.added + ' 个，' : ''}${summary.restored !== undefined ? '恢复 ' + summary.restored + ' 个，' : ''}${summary.removed !== undefined ? '暂不可用 ' + summary.removed + ' 个' : '已保存所选范围'}。` : '所选范围的落地页已更新。');
  } catch (error) {
    if (error.code === 'SITEMAP_SELECTION_REQUIRED' && error.payload?.sitemap) { applySitemapDiscovery(error.payload.sitemap); notify('这个 sitemap 包含多个页面分类。请选择要加入落地页库的范围，再点击更新。', 'warn'); return; }
    throw error;
  }
}
function landingsView() {
  const sitemap = state.resources.sitemap || {}, allItems = state.resources.landings || [], items = filterLandings(allItems);
  return title('落地页', '从 sitemap 更新官网页面，也可单独添加活动页；标签由团队共同维护。', button('刷新页面列表', 'reload-resources')) + `<section class="card"><h2>更新官网页面</h2><form id="sitemap-form"><fieldset ${state.busy || !canEdit() ? 'disabled' : ''}><label class="field"><span>Sitemap 地址</span><input type="url" data-sitemap-url value="${escape(state.sitemapInput)}" required placeholder="https://example.com/sitemap.xml"><small>只读取公开的 HTTPS sitemap。先读取页面分类，选择适合广告投放的范围；更新保留已有标签和人工添加的页面。</small></label><div class="row" style="margin-top:12px">${button('读取页面分类', 'inspect-sitemap')}</div><div data-sitemap-scope>${sitemapScopeView()}</div><div class="form-footer"><span class="small muted">最近成功更新：${date(sitemap.lastSyncedAt)}</span><button class="btn btn-primary" data-sitemap-update type="submit" ${state.sitemapDiscovery?.kind === 'sitemapindex' && !state.sitemapSelection.length ? 'disabled' : ''}>更新落地页</button></div></fieldset></form>${sitemap.lastError ? `<div class="banner banner-warn">${escape(sitemap.lastError)}</div>` : ''}</section>${canEdit() ? resourceForm('landings') : ''}<section class="card"><h2>落地页库</h2><div class="form-grid" style="margin-bottom:16px"><label class="field"><span>搜索页面名称、链接或标签</span><input data-landing-search value="${escape(state.landingSearch)}" placeholder="输入产品名、活动名或分类标签"></label><label class="field"><span>页面语言</span><select data-landing-language><option value="">全部语言</option><option value="__unknown" ${state.landingLanguage === '__unknown' ? 'selected' : ''}>语言待补充</option>${[...new Set(allItems.map(item => item.language).filter(Boolean))].sort().map(language => `<option value="${escape(language)}" ${state.landingLanguage === language ? 'selected' : ''}>${escape(language)}</option>`).join('')}</select></label></div><p class="small muted" data-landing-result-count>${landingCoverage(items)}</p><div class="resource-grid" data-landing-cards>${landingCards(items)}</div><div data-landing-more>${landingMoreButton(items)}</div></section>`;
}
function filterLandings(items) {
  const query = state.landingSearch.trim().toLowerCase();
  return items.filter(item => (!query || `${item.name} ${item.url} ${item.description} ${(item.tags || []).join(' ')}`.toLowerCase().includes(query)) && (!state.landingLanguage || (state.landingLanguage === '__unknown' ? !item.language : item.language === state.landingLanguage)));
}
function landingCoverage(items) { return `匹配 ${items.length} 个页面，当前显示 ${Math.min(items.length, state.landingLimit)} 个；库中共 ${state.resources.landings.length} 个。`; }
function landingCards(items) { return items.slice(0, state.landingLimit).map(item => `<article class="resource-card"><div class="spread"><h3>${escape(item.name)}</h3>${badge(item.status === 'archived' || item.available === false ? '暂不选用' : !item.language?.trim() || !item.description?.trim() ? '待补页面信息' : '可选用', item.status === 'archived' || item.available === false || !item.language?.trim() || !item.description?.trim() ? 'warn' : 'green')}</div><a class="small break" href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.url)}</a><p>${escape(item.description || '请补充页面说明，帮助选择适合的落地页。')}</p><div class="row">${(item.tags || []).map(tag => badge(tag)).join('') || '<span class="small muted">尚未分类</span>'}</div><p>${escape(item.language || '语言待补充')} · ${item.objective === 'registration' ? '网站注册' : item.objective === 'first_subscription' ? '首次订阅' : '注册和订阅'} · V${item.revision}</p>${canEdit() ? `<div class="row resource-actions"><button class="btn btn-small" data-edit-resource="${escape(item.id)}" data-resource-kind="landings">编辑页面与标签</button><button class="btn btn-small" data-archive-resource="${escape(item.id)}" data-resource-kind="landings" data-resource-status="${item.status === 'archived' ? 'active' : 'archived'}">${item.status === 'archived' ? '恢复' : '归档'}</button></div>` : ''}</article>`).join('') || '<div class="empty">当前条件下没有页面。可以修改筛选，或通过 sitemap 添加页面。</div>'; }
function landingMoreButton(items) { return items.length > state.landingLimit ? `<button class="btn" type="button" data-action="more-landings" style="margin-top:16px">继续显示 ${Math.min(60, items.length - state.landingLimit)} 个页面</button>` : ''; }
function updateLandingResults() {
  const items = filterLandings(state.resources.landings || []);
  const cards = root.querySelector('[data-landing-cards]'); if (cards) cards.innerHTML = landingCards(items);
  const count = root.querySelector('[data-landing-result-count]'); if (count) count.textContent = landingCoverage(items);
  const more = root.querySelector('[data-landing-more]'); if (more) more.innerHTML = landingMoreButton(items);
}
function trackingView() {
  const d = state.trackingDraft;
  if (!d) return title('UTM设置', '统一维护追踪规则；生成后的链接与方案、素材版本一起保存。') + '<section class="card">正在读取规则…</section>';
  const disabled = !canManage() || state.busy ? 'disabled' : '';
  const input = (field, label, value) => `<label class="field"><span>${label}</span><input data-tracking-field="${field}" value="${escape(value)}" ${disabled} maxlength="${field.includes('Map.') ? 80 : field === 'name' ? 120 : 300}"></label>`;
  return title('UTM设置', '规则保存在团队服务器，追踪链接保存为独立记录，可供以后接入公司后台。') + `<div class="banner banner-${d.configured ? 'info' : 'warn'}">${d.configured ? '已保存团队规则。修改规则不会改写以前已经生成的链接。' : '当前显示通用示例。请管理员按公司实际规则核对并保存后，再生成追踪链接。'}</div><section class="card"><h2>团队追踪规则</h2>${trackingConflictView()}<form id="tracking-form"><fieldset ${disabled}><div class="form-grid">${input('name', '规则名称', d.name || '团队UTM规则')}${platforms.map(p => input('sourceMap.' + p, p + ' · utm_source', d.sourceMap?.[p] || '')).join('')}${platforms.map(p => input('mediumMap.' + p, p + ' · utm_medium', d.mediumMap?.[p] || '')).join('')}${input('campaignTemplate', 'utm_campaign', d.campaignTemplate || '')}${input('contentTemplate', 'utm_content', d.contentTemplate || '')}${input('termTemplate', 'utm_term（选填）', d.termTemplate || '')}</div><div class="notice">可用字段：{proposalId} 方案编号、{platform} 平台、{materialId} 素材编号、{materialRevision} 素材版本、{landingId} 页面编号、{landingRevision} 页面版本、{trackingId} 链接编号、{groupName} 广告组名称、{title} 方案名称。请勿在 UTM 中加入邮箱等个人信息。<p>系统会附加唯一 tracking_code，便于未来与业务后台关联；这是当前开发版编号，企业原有编码规则仍需单独核对。</p><p>目前需要管理员手动配置并核对规则，尚未从原飞书表格导入公司编码逻辑。</p></div><div class="form-footer"><span class="small muted">${canManage() ? '保存规则后，到方案“人工审核”步骤生成并检查最终链接。' : '规则由管理员维护。'}</span>${canManage() ? `<button class="btn btn-primary" type="submit" ${state.trackingConflict ? 'disabled' : ''}>保存团队规则</button>` : ''}</div></fieldset></form></section><section class="card"><div class="spread"><h2>已保存的追踪链接</h2>${state.trackingItems.length ? button('导出追踪记录', 'export-tracking') : ''}</div><p class="card-description">展示最近 1000 条；完整记录保存在服务器，可通过接口接入后台。</p>${trackingTable(state.trackingItems)}</section>`;
}
function trackingConflictView() {
  const c = state.trackingConflict;
  if (!c) return '';
  return `<div class="banner banner-warn"><h3>其他管理员已更新规则</h3><p>你的输入保留在下方。先核对最新规则，再选择继续方式。</p><div class="row">${button('查看最新规则', 'tracking-view-latest')}</div>${c.reviewed ? `<pre class="workflow-snapshot">${escape(JSON.stringify(c.latest, null, 2))}</pre><div class="row">${button('载入最新规则', 'tracking-adopt-latest')}${button('保留我的输入，基于最新规则继续', 'tracking-rebase-local')}</div>` : ''}</div>`;
}
function trackingTable(items) {
  return items?.length ? `<div class="table-wrap"><table><thead><tr><th>平台 / 素材</th><th>最终链接</th><th>保存时间</th></tr></thead><tbody>${items.map(item => `<tr><td>${escape(item.platform)}<span class="cell-note">${escape(item.materialName || item.materialId || '')}</span><span class="cell-note">${escape(item.id)}</span></td><td><a class="break small" href="${safeHref(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.url)}</a></td><td>${date(item.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">还没有追踪链接。选好方案的落地页后，在审核步骤生成并保存。</div>';
}
async function loadWorkflow(editor) {
  if (!editor?.id) return;
  const [result, recommendations] = await Promise.all([api('/api/proposals/' + encodeURIComponent(editor.id) + '/workflow'), api('/api/proposals/' + encodeURIComponent(editor.id) + '/landing-recommendations')]);
  if (state.editor !== editor || editor.workflowDirty || editor.dirty) return;
  editor.workflow = normalizeWorkflow(result.workflow); editor.revision = result.item.revision; editor.title = result.item.title; editor.brief = normalizedBrief(result.item.brief); editor.status = result.item.status; editor.updatedAt = result.item.updatedAt; editor.landingRecommendations = recommendations.items || [];
}
function normalizeWorkflow(value) {
  const w = clone(value || {});
  return {...w, selection: {...emptySelection(), ...w.selection}, review: w.review || {status: 'draft', note: ''}, tracking: w.tracking || [], warnings: w.warnings || []};
}
function workflowSnapshotSummary(w) {
  const snap = w.selectionSnapshot || {}, content = w.content, review = w.review || {};
  return `<dl class="definition-grid"><dt>素材</dt><dd>${escape((snap.materials || []).map(m => `${m.name} V${m.revision}${m.file?.name ? ' · ' + m.file.name : ''}`).join('、') || '未选择')}</dd><dt>人群包</dt><dd>${escape((snap.audiences || []).map(a => `${a.name} V${a.revision} · ${a.use === 'exclude' ? '排除' : '包含'} · ${a.counts?.unique ?? a.uniqueCount ?? '未知'} 人`).join('、') || '未选择（选填）')}</dd><dt>落地页</dt><dd>${escape(snap.landing ? `${snap.landing.name} V${snap.landing.revision} · ${snap.landing.url}` : '未选择')}</dd><dt>审核状态</dt><dd>${escape(reviewNames[review.status] || '待完善')}</dd><dt>本次操作人</dt><dd>${escape(review.actor?.name || '尚未提交审核')}</dd><dt>审核操作时间</dt><dd>${date(review.at)}</dd><dt>审核意见</dt><dd>${escape(review.note || '暂无')}</dd>${content ? `<dt>策略</dt><dd>${escape(content.strategy)}</dd>` : ''}</dl>${w.executionConfiguration?.targets?.length ? `<h3>本版本广告账户与预算</h3>${executionTargetSummary(w.executionConfiguration.targets)}` : ''}${content ? contentPreview(content) : ''}${w.tracking?.length ? `<details><summary>本版本保存的追踪链接（${w.tracking.length} 条）</summary>${trackingTable(w.tracking)}</details>` : ''}`;
}
function workflowRecoveryView(w) {
  const snapshot = {...w.selectionSnapshot};
  for (const kind of ['materials', 'audiences']) snapshot[kind] = (w.selection?.[kind] || []).map(ref => {
    const found = w.selectionSnapshot?.[kind]?.find(item => item.id === ref.id && item.revision === ref.revision) || resourceByRef(kind, ref) || {name: ref.id};
    return {...found, ...ref};
  });
  const ref = w.selection?.landing;
  snapshot.landing = ref ? {...(w.selectionSnapshot?.landing?.id === ref.id && w.selectionSnapshot.landing.revision === ref.revision ? w.selectionSnapshot.landing : resourceByRef('landings', ref) || {name: ref.id}), ...ref} : null;
  return workflowSnapshotSummary({...w, selectionSnapshot: snapshot});
}
function workflowButton(label, action, enabled, primary = false) {
  return `<button class="btn ${primary ? 'btn-primary' : ''}" type="button" data-workflow-action="${action}" ${!enabled || state.busy || state.editor?.executionDirty || state.editor?.executionUncertain ? 'disabled' : ''}>${label}</button>`;
}
function workflowView(e, tab) {
  const w = e.workflow;
  if (!w) return '<section class="card"><div class="empty">方案步骤暂未加载。请点击下方刷新数据后重试。</div></section>';
  const editable = canEdit() && e.status !== 'archived';
  const clean = editable && !e.dirty && !e.workflowDirty && !e.conflict && !e.workflowUncertain;
  return `${e.dirty ? '<div class="banner banner-warn">投放需求有未保存的修改。请先回到“投放需求”保存，再继续生成和审核。</div>' : ''}${e.workflowDirty ? '<div class="banner banner-warn">本步骤有未保存的修改。请先保存，再进行下一步。</div>' : ''}${e.workflowUncertain ? `<div class="banner banner-warn">刚才提交的结果无法确认，输入已保留。${button('查看服务器最新版本', 'load-latest')} ${workflowButton('已核对，允许再次提交', 'ack-uncertain', editable)}</div>` : ''}${(w.warnings || []).map(v => `<div class="banner banner-warn">${escape(typeof v === 'string' ? v : v.message || JSON.stringify(v))}</div>`).join('')}${tab === 'resources' ? workflowResources(e, editable, clean) : tab === 'content' ? workflowContent(e, editable, clean) : workflowReview(e, editable, clean)}`;
}
function resourceByRef(kind, ref) { return state.resources[kind]?.find(item => item.id === ref?.id); }
function selectVersionNote(kind, ref) {
  const latest = resourceByRef(kind, ref);
  return !latest ? '此资源当前不在库中，请核对' : latest.revision !== ref.revision ? `方案使用 V${ref.revision}，资源库最新为 V${latest.revision}` : `已选 V${ref.revision}`;
}
function rankedLandings(e) {
  const query = `${e.title} ${e.brief.audienceDirection} ${e.brief.language}`.toLowerCase();
  const terms = query.split(/[\s,，、;；/]+/).filter(word => word.length > 1);
  return state.resources.landings.filter(v => v.status !== 'archived' && v.available !== false).map(item => {
    const text = `${item.name} ${item.description} ${(item.tags || []).join(' ')}`.toLowerCase();
    const score = terms.filter(term => text.includes(term)).length + (item.language?.toLowerCase() === e.brief.language?.toLowerCase() ? 2 : 0) + (item.objective === e.brief.objective ? 2 : item.objective === 'both' ? 1 : 0);
    return {item, score};
  }).sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
}
function landingRecommendationsView(e, disabled) {
  if (!e.landingRecommendations?.length) return '';
  return `<details class="landing-recommendations"><summary>按标签匹配推荐（点击查看理由）</summary><div class="stack">${e.landingRecommendations.slice(0, 3).map(rec => `<div class="hint-box"><strong>${escape(rec.landing.name)}</strong><p class="small">${escape(rec.reasons.join('；'))}</p><button class="btn btn-small" type="button" data-recommend-landing="${escape(rec.landing.id)}" ${disabled}>选择这个页面</button></div>`).join('')}</div></details>`;
}
function workflowResources(e, editable) {
  const w = e.workflow, s = w.selection, disabled = !editable || state.busy ? 'disabled' : '';
  const currentLanding = s.landing && w.selectionSnapshot?.landing?.id === s.landing.id && w.selectionSnapshot.landing.revision === s.landing.revision ? w.selectionSnapshot.landing : resourceByRef('landings', s.landing);
  return `<section class="card"><div class="spread"><h2>这次投放用哪些素材</h2><button class="btn btn-small" data-nav="resources">前往素材库</button></div><p class="card-description">明确选择本次使用的文件；以后库中新增素材不会自动加入这份方案。</p><div class="selection-grid">${state.resources.materials.filter(item => item.status !== 'archived' || s.materials.some(v => v.id === item.id)).map(item => {
    const ref = s.materials.find(v => v.id === item.id);
    return `<article class="selection-card"><label class="check"><input type="checkbox" data-select-material="${escape(item.id)}" ${ref ? 'checked' : ''} ${disabled || (!item.ready || item.status === 'archived') && !ref ? 'disabled' : ''}><strong>${escape(item.name)}</strong></label><span class="small muted">${escape(sourceNames[item.source] || item.source)} · ${item.mediaType === 'video' ? '视频' : '图片'} · ${item.ready ? '文件或代码已准备' : '待补文件或代码'}</span><span class="small">${escape(item.notes || '')}</span>${ref ? `<span class="small muted">${escape(selectVersionNote('materials', ref))}</span>${item.revision !== ref.revision ? `<button class="table-link" type="button" data-update-resource-ref="${escape(item.id)}" data-resource-kind="materials" ${disabled}>改用最新版本</button>` : ''}` : ''}</article>`;
  }).join('') || '<div class="empty">先到素材库上传文件或登记达人广告代码。</div>'}</div></section><section class="card"><div class="spread"><h2>人群包（选填）</h2><button class="btn btn-small" data-nav="resources" data-switch-resource="audiences">前往人群库</button></div><p class="card-description">可按需求包含或排除名单。留空时，仍可使用你在投放需求中填写的人群方向。</p>${state.resources.audiences.filter(item => item.status !== 'archived' || s.audiences.some(v => v.id === item.id)).map(item => {
    const ref = s.audiences.find(v => v.id === item.id);
    return `<div class="audience-choice"><div><strong>${escape(item.name)}</strong><p class="small muted">${escape(audienceTypes[item.type] || item.type)} · ${escape(item.counts?.unique ?? item.uniqueCount ?? '未知')} 人 · ${escape(item.description || '')}</p>${ref ? `<span class="small muted">${escape(selectVersionNote('audiences', ref))}</span>` : ''}</div><select aria-label="${escape(item.name)}用途" data-select-audience="${escape(item.id)}" ${disabled}><option value="" ${!ref ? 'selected' : ''}>不使用</option><option value="include" ${ref?.use === 'include' ? 'selected' : ''}>包含这批人</option><option value="exclude" ${ref?.use === 'exclude' ? 'selected' : ''}>排除这批人</option></select>${ref && item.revision !== ref.revision ? `<button class="btn btn-small" data-update-resource-ref="${escape(item.id)}" data-resource-kind="audiences" ${disabled}>改用最新版本</button>` : ''}</div>`;
  }).join('') || '<p class="small muted">还没有人群包，可以跳过。</p>'}</section><section class="card"><div class="spread"><h2>广告点击后打开哪个页面</h2><button class="btn btn-small" data-nav="landings">维护落地页</button></div><p class="card-description">按页面标签、语言和目标排序供你选择；请人工确认内容是否适合这次投放。Sitemap 只导入页面地址，最终审核前需要补充页面语言和内容说明。</p>${landingRecommendationsView(e, disabled)}<label class="field"><span>选择落地页</span><select data-select-landing ${disabled}><option value="">请选择页面</option>${rankedLandings(e).map(({item, score}, i) => `<option value="${escape(item.id)}" ${s.landing?.id === item.id ? 'selected' : ''}>${i === 0 && score > 0 ? '优先检查 · ' : ''}${escape(item.name)} · ${escape((item.tags || []).join(' / '))}${!item.language?.trim() || !item.description?.trim() ? ' · 需补语言和说明' : ''}</option>`).join('')}${s.landing && !rankedLandings(e).some(({item}) => item.id === s.landing.id) ? `<option value="${escape(s.landing.id)}" selected>已选页面暂不可用，请重新选择</option>` : ''}</select></label>${currentLanding ? `<div class="hint-box" style="margin-top:14px"><strong>${escape(currentLanding.name)}</strong><p><a href="${safeHref(currentLanding.url)}" target="_blank" rel="noopener noreferrer">${escape(currentLanding.url)} ↗</a></p><p>${escape(currentLanding.description || '请打开页面核对内容。')}</p><p class="small">${escape(selectVersionNote('landings', s.landing))}</p>${resourceByRef('landings', s.landing)?.revision !== s.landing?.revision ? `<button class="btn btn-small" data-update-resource-ref="${escape(s.landing?.id)}" data-resource-kind="landings" ${disabled}>改用最新版本</button>` : ''}</div>` : ''}</section><div class="form-footer"><span class="small muted">资源版本保存在方案里，素材库更新不会自动替换它们。</span>${workflowButton('保存本次选择', 'save-selection', editable && !e.dirty && !e.conflict && !e.workflowUncertain, true)}</div>`;
}
function contentPreview(content) {
  return `<div class="content-preview">${(content.platforms || []).map(p => `<section class="platform-preview"><h3>${escape(p.platform)}</h3>${[['headlines', '标题'], ['descriptions', '描述'], ['primaryTexts', '正文'], ['keywords', '关键词'], ['negativeKeywords', '否定关键词']].filter(([key]) => p[key]?.length).map(([key, label]) => `<h4>${label}</h4><ul>${p[key].map(t => `<li>${escape(t)}</li>`).join('')}</ul>`).join('')}${p.callToAction ? `<p class="small">行动按钮：${escape(p.callToAction)}</p>` : ''}</section>`).join('')}</div>`;
}
function googleCopyNotice() {
  return '<p class="hint-box small" style="margin-bottom:16px">Google 搜索广告需要 3–15 条标题、2–4 条描述；每条标题最多 30 个字符，描述最多 90 个字符。中文、日文、韩文等全角字符按 2 个字符计算。提交审核时会检查这些限制。</p>';
}
function workflowContent(e, editable, clean) {
  const w = e.workflow, g = w.generation, content = w.content, disabled = !editable || state.busy ? 'disabled' : '';
  return `${automaticGenerationView(e, editable, clean)}<details class="card manual-codex" data-manual-codex ${e.manualGenerationOpen ? 'open' : ''}><summary>手动交接（备用）</summary><h2>复制要求并导入结果</h2><p class="card-description">电脑连接暂不可用时，可复制要求到自己的 Codex，再手动导入 JSON。正常连接后，使用上方自动生成即可。</p><p class="notice">生成要求包含素材名称、说明和类型；不会把图片或视频画面自动发给 Codex。需要理解画面时，请同时附上已选文件。Google 当前准备搜索广告，YouTube 等形式后续接入；TikTok 审核时至少需要一份可用视频。</p>${workflowButton(g ? '重新准备生成要求' : '准备生成要求', 'prepare-generation', clean, true)}${g ? `<div class="section-divider"></div><p class="small muted">生成要求编号：${escape(g.id)} · ${date(g.createdAt)}</p><label class="field"><span>复制到 Codex 的完整要求</span><textarea id="codex-generation-prompt" class="code-textarea" readonly>${escape(g.prompt)}</textarea></label><div class="row" style="margin-top:12px">${workflowButton('复制生成要求', 'copy-prompt', true)}${workflowButton('下载生成要求', 'download-prompt', true)}</div><label class="field" style="margin-top:22px"><span>粘贴 Codex 返回的 JSON</span><textarea class="code-textarea" data-codex-result ${disabled} placeholder="仅粘贴完整 JSON 结果">${escape(e.importText)}</textarea><small>系统会校验平台、字段和本次生成要求是否仍有效。不要加入邮箱名单。</small></label><div class="row" style="margin-top:12px">${workflowButton('校验并导入生成结果', 'import-generation', clean, true)}</div>` : `<div class="notice">${w.selectionSnapshot?.materials?.length && w.selectionSnapshot?.landing && !e.workflowDirtyFields.selection ? '资源已保存，点击“准备生成要求”继续。' : '请先在上一步保存素材和落地页。'}</div>`}</details>${content ? `<section class="card"><h2>人工修改策略与文案</h2><label class="field"><span>投放策略与理由</span><textarea data-content-field="strategy" ${disabled}>${escape(content.strategy)}</textarea></label>${(content.platforms || []).map((p, index) => `<div class="platform-editor"><h3>${escape(p.platform)}</h3>${p.platform === 'Google' ? googleCopyNotice() : ''}<div class="form-grid">${(p.platform === 'Google' ? [['headlines', '标题'], ['descriptions', '描述'], ['keywords', '关键词'], ['negativeKeywords', '否定关键词']] : [['headlines', '标题'], ['primaryTexts', '广告正文'], ['descriptions', '补充描述']]).map(([key, label]) => `<label class="field"><span>${label}（每行一条）</span><textarea data-content-platform="${index}" data-content-field="${key}" ${disabled}>${escape((p[key] || []).join('\n'))}</textarea></label>`).join('')}<label class="field"><span>行动按钮</span><input data-content-platform="${index}" data-content-field="callToAction" value="${escape(p.callToAction || '')}" ${disabled}></label></div></div>`).join('')}<div class="form-footer"><span class="small muted">保存文案后再提交审核。修改已确认内容会重新进入待完善状态。</span>${workflowButton('保存策略与文案', 'save-content', editable && !e.dirty && !e.conflict && !e.workflowUncertain, true)}</div></section>` : '<section class="card"><div class="empty">还没有策略和文案。用自己的 Codex 生成后会自动显示在这里，再逐项修改和人工审核。</div></section>'}`;
}
function workflowReview(e, editable, clean) {
  const w = e.workflow, review = w.review || {}, snap = w.selectionSnapshot || {};
  return `<section class="card"><div class="spread"><h2>最终核对</h2>${badge(reviewNames[review.status] || '待完善', review.status === 'approved' ? 'green' : 'warn')}</div>${briefSummary(e.brief)}<div class="section-divider"></div>${e.brief.platforms.includes('Google') ? googleCopyNotice() : ''}${workflowSnapshotSummary(w)}</section><section class="card"><div class="spread"><h2>最终追踪链接</h2>${workflowButton(w.tracking?.length ? '重新核对并保存追踪链接' : '生成并保存追踪链接', 'generate-tracking', clean)}</div><p class="card-description">落地页确定后，按团队 UTM 规则生成。链接保存后可用于后台归因。</p>${trackingTable(w.tracking)}<button class="table-link" data-nav="tracking">查看团队 UTM 规则</button></section><section class="card"><h2>人工审核</h2><p class="card-description">审核确认的是当前版本的需求、素材、落地页、文案和链接。通过后仍需后续广告搭建与启用步骤。</p><label class="field"><span>审核或修改意见（退回时必填）</span><textarea data-review-note ${!editable || state.busy ? 'disabled' : ''}>${escape(e.reviewNote)}</textarea></label><div class="row" style="margin-top:18px">${['draft', 'changes_requested'].includes(review.status) ? workflowButton('提交人工审核', 'submit', clean, true) : ''}${review.status === 'in_review' ? workflowButton('审核通过', 'approve', clean, true) + workflowButton('需要修改', 'request_changes', clean) : ''}${review.status === 'approved' ? workflowButton('重新编辑方案', 'reopen', clean) : ''}</div>${review.status === 'approved' ? '<div class="banner banner-info" style="margin-top:18px">方案已通过审核。下一步先核对账户和搭建设置，再创建暂停广告；启用需要另行确认。</div>' : ''}</section>`;
}
async function saveResource(kind) {
  const d = clone(libraryDraft(kind)), edit = state.libraryEdits[kind], file = state.resourceFiles[kind];
  if (kind === 'materials' && file && file.size > 100 * 1024 * 1024) throw new Error('素材超过 100 MB，请先压缩再上传。');
  if (kind === 'audiences' && !edit && (!file || file.size > 5 * 1024 * 1024)) throw new Error('请选择不超过 5 MB 的邮箱 CSV。');
  let body = {...d};
  if (edit) body.expectedRevision = edit.revision;
  if (kind === 'materials' && edit && !d.adCode) delete body.adCode;
  if (kind === 'audiences' && !edit) body.csv = await file.text();
  if (kind === 'audiences' && edit) delete body.authorized;
  let result = await api('/api/' + kind + (edit ? '/' + encodeURIComponent(edit.id) : ''), {method: edit ? 'PATCH' : 'POST', body});
  if (kind === 'materials' && file) {
    // Store the new resource ID before upload, so a failed file transfer is retried on this record.
    state.libraryEdits[kind] = result.item;
    const response = await fetch('/api/materials/' + encodeURIComponent(result.item.id) + '/file?expectedRevision=' + result.item.revision, {method: 'PUT', credentials: 'same-origin', headers: {'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name)}, body: file});
    const payload = await response.json();
    if (!response.ok) throw new RequestError(payload.error?.message || '文件上传未完成，已保留资料和所选文件。', response.status, payload.error?.code || 'UPLOAD_FAILED', payload);
    result = payload;
  }
  state.libraryDrafts[kind] = null; state.libraryEdits[kind] = null; delete state.resourceFiles[kind]; state.resourceDirty = false;
  await loadResources(); notify(kind === 'materials' ? '素材已保存。以后从素材库选用，无需重复上传。' : kind === 'audiences' ? '人群包已保存，仅保留处理后的名单和人数。' : '落地页资料已保存。');
}
function markWorkflowDirty(field = 'selection') {
  if (!state.editor) return;
  state.editor.workflowDirty = true; state.editor.workflowDirtyFields[field] = true;
  const indicator = root.querySelector('[data-editor-save-state]');
  if (indicator) indicator.textContent = '有未保存的修改';
  root.querySelectorAll('[data-workflow-action]').forEach(el => { if (!['save-selection', 'save-content', 'copy-prompt', 'download-prompt', 'ack-uncertain'].includes(el.dataset.workflowAction)) el.disabled = true; });
}
async function mutateWorkflow(suffix, body, message, method = 'POST') {
  const e = state.editor;
  if (!e?.id || !canEdit() || e.dirty || e.conflict || e.workflowUncertain || e.executionDirty || e.executionUncertain) return;
  try {
    const result = await api('/api/proposals/' + encodeURIComponent(e.id) + suffix, {method, body: {expectedRevision: e.revision, ...body}});
    const keepTab = state.editorTab, importText = e.importText;
    state.editor = makeEditor(result.item); state.editor.workflow = normalizeWorkflow(result.workflow); state.editor.importText = suffix.endsWith('/generation/result') ? '' : importText; state.editorTab = keepTab;
    state.editor.landingRecommendations = e.landingRecommendations || []; state.editor.jobs = e.jobs || []; state.editor.jobsLoaded = e.jobsLoaded; state.editor.selectedConnectorId = e.selectedConnectorId || ''; state.editor.manualGenerationOpen = e.manualGenerationOpen;
    if (result.job) { state.editor.jobs = [result.job, ...state.editor.jobs.filter(job => job.id !== result.job.id)]; state.editor.jobsLoaded = true; }
    await Promise.all([loadItems(), loadEditorHistory(state.editor)]); notify(message);
  } catch (error) {
    if (error.status === 409 && error.code === 'REVISION_CONFLICT') {
      e.conflict = {latest: error.payload?.current?.item || error.payload?.current || null, reviewed: false}; notify('方案已被更新。当前选择和文案仍保留，请查看最新版本后继续。', 'warn'); return;
    }
    if (error.status === 0) e.workflowUncertain = true;
    throw error;
  }
}
function handlePhaseClick(el) {
  if (el.dataset.switchResource) state.resourceTab = el.dataset.switchResource;
  if (el.dataset.resourceTab) { state.resourceTab = el.dataset.resourceTab; render(); return true; }
  if (el.dataset.editResource) {
    const kind = el.dataset.resourceKind, item = state.resources[kind].find(v => v.id === el.dataset.editResource);
    if (!item) return true;
    state.libraryEdits[kind] = {id: item.id, revision: item.revision};
    state.libraryDrafts[kind] = kind === 'materials' ? {name: item.name, source: item.source, sourceUrl: item.sourceUrl || '', mediaType: item.mediaType, notes: item.notes || '', adCode: ''} : kind === 'audiences' ? {name: item.name, type: item.type, description: item.description || ''} : {name: item.name, url: item.url, description: item.description || '', tags: clone(item.tags || []), language: item.language || '', objective: item.objective || 'both'};
    delete state.resourceFiles[kind]; render(); root.querySelector('[data-resource-form]')?.scrollIntoView({block: 'start', behavior: 'smooth'}); return true;
  }
  if (el.dataset.archiveResource) {
    const kind = el.dataset.resourceKind, item = state.resources[kind].find(v => v.id === el.dataset.archiveResource);
    void perform(async () => { await api('/api/' + kind + '/' + encodeURIComponent(item.id), {method: 'PATCH', body: {expectedRevision: item.revision, status: el.dataset.resourceStatus}}); await loadResources(); notify('资源状态已更新；已有方案保留原先的版本。'); }); return true;
  }
  if (el.dataset.recommendLanding) {
    const e = state.editor, item = resourceByRef('landings', {id: el.dataset.recommendLanding}); if (!e?.workflow || !item) return true;
    e.workflow.selection.landing = {id: item.id, revision: item.revision}; markWorkflowDirty(); render(); return true;
  }
  if (el.dataset.updateResourceRef) {
    const e = state.editor, kind = el.dataset.resourceKind, item = state.resources[kind].find(v => v.id === el.dataset.updateResourceRef);
    if (!e?.workflow || !item) return true;
    if (kind === 'landings') e.workflow.selection.landing = {id: item.id, revision: item.revision};
    else e.workflow.selection[kind] = e.workflow.selection[kind].map(v => v.id === item.id ? {...v, revision: item.revision} : v);
    markWorkflowDirty(); render(); return true;
  }
  if (el.dataset.action?.startsWith('cancel-library-')) { const kind = el.dataset.action.slice(15); state.libraryDrafts[kind] = null; state.libraryEdits[kind] = null; delete state.resourceFiles[kind]; state.resourceDirty = false; render(); return true; }
  if (el.dataset.action === 'tracking-view-latest') { state.trackingConflict.reviewed = true; render(); return true; }
  if (el.dataset.action === 'tracking-adopt-latest' || el.dataset.action === 'tracking-rebase-local') {
    const c = state.trackingConflict; if (!c?.reviewed) return true; state.trackingConfig = clone(c.latest);
    if (el.dataset.action === 'tracking-adopt-latest') { state.trackingDraft = clone(c.latest); state.trackingDirty = false; }
    state.trackingConflict = null; notify('已确认当前版本。保留输入时仍需主动保存规则。'); render(); return true;
  }
  if (el.dataset.action === 'export-tracking') {
    const url = URL.createObjectURL(new Blob([JSON.stringify({exportedAt: new Date().toISOString(), limit: 1000, items: state.trackingItems}, null, 2)], {type: 'application/json'})); const a = document.createElement('a'); a.href = url; a.download = 'ad-tracking-records.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
  }
  if (el.dataset.action === 'more-landings') { state.landingLimit += 60; updateLandingResults(); return true; }
  if (el.dataset.action === 'inspect-sitemap') {
    void perform(async () => {
      if (!state.sitemapInput.trim()) throw new Error('请先填写 sitemap 地址。');
      const result = await api('/api/landings/inspect', {method: 'POST', body: {sitemapUrl: state.sitemapInput}});
      applySitemapDiscovery(result.sitemap); notify(result.sitemap.kind === 'sitemapindex' ? '页面分类已读取。请选择这次要收录的范围，再更新落地页。' : '这是直接列出页面的 sitemap，可以更新落地页。');
    }); return true;
  }
  if (el.dataset.action === 'reload-resources') { void perform(async () => { await loadResources(); notify('资源库已刷新。'); }); return true; }
  const action = el.dataset.workflowAction;
  if (!action) return false;
  const e = state.editor;
  if (!e?.workflow) return true;
  if (action === 'copy-prompt') {
    void (async () => { try { await navigator.clipboard.writeText(e.workflow.generation.prompt); notify('要求已复制。请发给你自己的 Codex，再将结果导入此处。'); } catch { notify('请手动复制已选中的生成要求。', 'warn'); render(); const field = document.getElementById('codex-generation-prompt'); field?.focus(); field?.select(); return; } render(); })(); return true;
  }
  if (action === 'download-prompt') {
    const url = URL.createObjectURL(new Blob([e.workflow.generation.prompt], {type: 'text/plain;charset=utf-8'}));
    const a = document.createElement('a'); a.href = url; a.download = 'codex-generation-' + e.workflow.generation.id + '.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
  }
  if (action === 'ack-uncertain') { if (window.confirm('已查看服务器最新记录，确认需要再次提交？')) { e.workflowUncertain = false; render(); } return true; }
  void perform(async () => {
    if (action === 'save-selection') await mutateWorkflow('/workflow', {...(e.workflowDirtyFields.content ? {content: e.workflow.content} : {}), selection: e.workflow.selection}, '本次素材、人群和落地页选择已保存。', 'PATCH');
    if (action === 'save-content') await mutateWorkflow('/workflow', {...(e.workflowDirtyFields.selection ? {selection: e.workflow.selection} : {}), content: e.workflow.content}, '策略与文案已保存，请在下一步核对并提交审核。', 'PATCH');
    if (action === 'automatic-generation') {
      const connector = state.connectors.find(item => item.id === e.selectedConnectorId);
      if (!connectorReady(connector || {})) throw new Error('请先连接自己已登录 Codex 的电脑。');
      await mutateWorkflow('/generation/jobs', {connectorId: connector.id}, '任务已交给自己的 Codex。完成后文案会自动回填，仍需人工审核。');
    }
    if (action === 'prepare-generation') await mutateWorkflow('/generation', {}, '生成要求已准备，请复制给你自己的 Codex。');
    if (action === 'import-generation') {
      let result;
      try { result = JSON.parse(e.importText); } catch { throw new Error('请粘贴有效的完整 JSON，不要包含代码框标记。'); }
      await mutateWorkflow('/generation/result', {generationId: e.workflow.generation.id, result}, '生成结果已导入。请人工修改和审核后再使用。');
    }
    if (action === 'generate-tracking') await mutateWorkflow('/tracking', {}, '最终追踪链接已生成并保存。');
    if (['submit', 'approve', 'request_changes', 'reopen'].includes(action)) await mutateWorkflow('/review', {action, note: e.reviewNote}, action === 'approve' ? '当前方案已审核通过。可继续核对设置并创建暂停广告；不会直接启用。' : action === 'submit' ? '方案已提交，等待人工审核。' : action === 'reopen' ? '方案已重新进入编辑状态。' : '方案已退回修改。');
  });
  return true;
}
root.addEventListener('input', event => {
  const el = event.target;
  if (el.dataset.libraryField) {
    const d = libraryDraft(el.dataset.libraryKind), value = el.type === 'checkbox' ? el.checked : el.value;
    d[el.dataset.libraryField] = el.dataset.libraryField === 'tags' ? value.split(/[,，]/).map(v => v.trim()).filter(Boolean) : value;
    state.resourceDirty = true;
  }
  if (el.hasAttribute('data-sitemap-url') && state.sitemapInput !== el.value) {
    state.sitemapInput = el.value; state.sitemapDiscovery = null; state.sitemapSelection = []; state.sitemapSelectionDirty = true;
    const section = root.querySelector('[data-sitemap-scope]'); if (section) section.innerHTML = '<p class="small muted notice">地址已变化，请重新读取页面分类。</p>';
    const update = root.querySelector('[data-sitemap-update]'); if (update) update.disabled = false;
  }
  if (el.hasAttribute('data-landing-search')) { state.landingSearch = el.value; state.landingLimit = 60; updateLandingResults(); }
  if (el.dataset.trackingField) {
    const parts = el.dataset.trackingField.split('.');
    if (parts.length === 2) { state.trackingDraft[parts[0]] ||= {}; state.trackingDraft[parts[0]][parts[1]] = el.value; }
    else state.trackingDraft[parts[0]] = el.value;
    state.trackingDirty = true;
  }
  if (el.hasAttribute('data-codex-result') && state.editor) state.editor.importText = el.value;
  if (el.hasAttribute('data-review-note') && state.editor) state.editor.reviewNote = el.value;
  if (el.dataset.contentField && state.editor?.workflow?.content) {
    const target = el.hasAttribute('data-content-platform') ? state.editor.workflow.content.platforms[Number(el.dataset.contentPlatform)] : state.editor.workflow.content;
    target[el.dataset.contentField] = ['strategy', 'callToAction'].includes(el.dataset.contentField) ? el.value : lines(el.value);
    markWorkflowDirty('content');
  }
});
root.addEventListener('change', event => {
  const el = event.target;
  if (el.hasAttribute('data-landing-language')) { state.landingLanguage = el.value; state.landingLimit = 60; updateLandingResults(); }
  if (el.hasAttribute('data-sitemap-child')) {
    const discovery = state.sitemapDiscovery; if (!discovery?.children.includes(el.value)) return;
    state.sitemapSelection = el.checked ? [...new Set([...state.sitemapSelection, el.value])] : state.sitemapSelection.filter(value => value !== el.value); state.sitemapSelectionDirty = true;
    const update = root.querySelector('[data-sitemap-update]'); if (update) update.disabled = !state.sitemapSelection.length;
    const count = root.querySelector('[data-sitemap-count]'); if (count) count.textContent = `已选择 ${state.sitemapSelection.length} 个分类`;
  }
  if (el.dataset.resourceFile) { state.resourceFiles[el.dataset.resourceFile] = el.files?.[0] || null; state.resourceDirty = true; }
  if (el.dataset.libraryField) { const d = libraryDraft(el.dataset.libraryKind); d[el.dataset.libraryField] = el.dataset.libraryField === 'tags' ? el.value.split(/[,，]/).map(v => v.trim()).filter(Boolean) : el.type === 'checkbox' ? el.checked : el.value; state.resourceDirty = true; }
  const e = state.editor;
  if (!e?.workflow || !canEdit() || e.status === 'archived') return;
  const s = e.workflow.selection;
  if (el.dataset.selectMaterial) {
    const item = resourceByRef('materials', {id: el.dataset.selectMaterial});
    s.materials = el.checked ? [...s.materials.filter(v => v.id !== item.id), {id: item.id, revision: item.revision}] : s.materials.filter(v => v.id !== item.id);
    markWorkflowDirty(); render();
  }
  if (el.dataset.selectAudience) {
    const item = resourceByRef('audiences', {id: el.dataset.selectAudience});
    s.audiences = s.audiences.filter(v => v.id !== item.id);
    if (el.value) s.audiences.push({id: item.id, revision: item.revision, use: el.value});
    markWorkflowDirty(); render();
  }
  if (el.hasAttribute('data-select-landing')) {
    const item = resourceByRef('landings', {id: el.value}); s.landing = item ? {id: item.id, revision: item.revision} : null;
    markWorkflowDirty(); render();
  }
});
root.addEventListener('submit', event => {
  const form = event.target;
  if (form.dataset.resourceForm) { event.preventDefault(); if (!state.busy) void perform(() => saveResource(form.dataset.resourceForm)); }
  if (form.id === 'sitemap-form') { event.preventDefault(); if (!state.busy) void perform(syncSitemap); }
  if (form.id === 'tracking-form') {
    event.preventDefault(); if (!state.busy) void perform(async () => {
      const d = state.trackingDraft;
      if (state.trackingConflict) throw new Error('请先核对其他管理员保存的最新规则。');
      try { await api('/api/tracking-config', {method: 'PUT', body: {expectedRevision: state.trackingConfig.revision, name: d.name, sourceMap: d.sourceMap, mediumMap: d.mediumMap, campaignTemplate: d.campaignTemplate, contentTemplate: d.contentTemplate, termTemplate: d.termTemplate}}); }
      catch (error) { if (error.status === 409) { const current = await api('/api/tracking-config'); state.trackingConflict = {latest: current.item, reviewed: false}; } throw error; }
      state.trackingDirty = false; await loadTracking(); notify('团队 UTM 规则已保存。以前生成的链接保留原记录。');
    });
  }
});
// Each browser account pairs only its own local connector. Pairing codes never
// enter URLs, browser storage, proposal snapshots, or activity text.
const jobNames = {queued: '等待这台电脑领取', running: 'Codex 正在生成', succeeded: '已回填，等待人工审核', failed: '生成未完成', cancelled: '已取消', stale: '方案已变化，结果未回填', needs_attention: '需要处理后重试'};
const activeJob = job => ['queued', 'running'].includes(job.status);
const connectorOnline = item => item.online ?? Boolean(item.lastSeenAt && Date.now() - new Date(item.lastSeenAt).getTime() < 45000);
const connectorReady = item => item.status === 'active' && (item.ready ?? (connectorOnline(item) && item.codex?.available === true && item.codex?.authenticated === true));
function connectorLabel(item) {
  if (item.status === 'pending') return ['待本人确认', 'warn'];
  if (item.status === 'revoked') return ['已断开', ''];
  if (!connectorOnline(item)) return ['电脑未连接', 'warn'];
  if (!item.codex?.available) return ['这台电脑未找到 Codex', 'warn'];
  if (!item.codex?.authenticated) return ['Codex 需要登录', 'warn'];
  if (item.codex?.compatible === false) return ['Codex 需要更新', 'warn'];
  return connectorReady(item) ? ['可以生成', 'green'] : ['等待连接器就绪', 'warn'];
}
function ownConnectorCommand() { return `node runner/connect.mjs --server "${location.origin}"`; }
function codexConfirmationView(pending) {
  return `<section class="banner banner-warn connector-confirmation" role="alertdialog" aria-label="确认 Codex 操作" data-codex-confirmation><p>${escape(pending.message)}</p>${pending.type === 'confirm' ? `<p class="small"><strong>${pending.uncertain ? '保存结果尚未核对，请先检查状态，不要重复提交。' : '尚未保存，请在下方确认。'}</strong></p>` : ''}<div class="row" style="margin-top:12px"><button type="button" class="btn btn-primary" data-confirm-codex-action ${state.busy ? 'disabled' : ''}>${escape(pending.uncertain ? '检查保存状态' : pending.label)}</button><button type="button" class="btn" data-dismiss-codex-action ${state.busy ? 'disabled' : ''}>暂不操作</button></div></section>`;
}
function connectorConfirmationSaved(item, pending) {
  return item?.id === pending.id && (pending.type === 'confirm' ? item.status === 'active' && Boolean(item.confirmedAt) && Number.isFinite(Date.parse(item.confirmedAt)) : item.status === 'revoked');
}
async function saveConnectorConfirmation(pending) {
  let responseItem, requestError;
  if (!pending.uncertain) {
    try { responseItem = (await api('/api/connectors/' + encodeURIComponent(pending.id) + '/' + pending.type, {method: 'POST', body: {}})).item; }
    catch (error) { requestError = error; }
  }
  // Even a lost POST response can mean the confirmation was saved. Read back
  // first; an uncertain response never automatically submits a second time.
  try { await loadConnectors(); }
  catch (error) {
    pending.uncertain = true;
    if (connectorConfirmationSaved(responseItem, pending)) {
      notify('服务器已收到确认，暂时无法核对保存状态。请点击“检查保存状态”，不要重复提交。', 'warn');
      return;
    }
    throw error;
  }
  const saved = state.connectors.find(item => item.id === pending.id);
  if (connectorConfirmationSaved(saved, pending)) {
    if (state.codexConfirmation === pending) state.codexConfirmation = null;
    state.pairing = null;
    notify(pending.type === 'confirm' ? '这台电脑已确认连接，保存结果已核对。回到方案即可使用自己的 Codex。' : '连接已断开，保存结果已核对。工作区中已保存的文案继续保留。');
    return;
  }
  pending.uncertain = false;
  throw requestError || new Error(pending.type === 'confirm' ? '连接确认尚未保存。请核对设备状态，再点击“确认连接并保存”。' : '断开连接尚未保存。请核对设备状态后重试。');
}
function connectorCards() {
  if (!state.connectorsLoaded) return '<div class="empty">还没有取得你的连接状态，请点击刷新。</div>';
  if (!state.connectors.length) return '<div class="empty">还没有连接自己的电脑。完成下方步骤后，回到这里确认连接。</div>';
  return state.connectors.map(item => {
    const [label, tone] = connectorLabel(item);
    const diagnostics = item.status === 'active' && connectorOnline(item) ? !item.codex?.available ? '请在这台电脑上安装 Codex 命令行工具，再重新运行连接器。' : !item.codex?.authenticated ? '请在这台电脑上完成 Codex 登录，再重新运行连接器。网页不接收你的 Codex 密码或登录令牌。' : item.codex?.compatible === false ? '请更新这台电脑的 Codex 命令行工具，再重新启动连接器。' : '文案生成使用这台电脑自己的 Codex 登录状态。浏览器搭建还需桌面 Codex 的本人浏览器权限，启用广告需另行确认。' : item.status === 'pending' ? '确认并保存后，才能领取由你发起的文案生成和浏览器搭建任务。' : item.status === 'revoked' ? '这台电脑不能再领取或回填文案生成和浏览器搭建任务。' : '检查这台电脑是否开机，以及连接器是否仍在运行。';
    return `<article class="resource-card connector-card"><div class="spread"><h3>${escape(item.name || '我的电脑')}</h3>${badge(label, tone)}</div><p>${escape(diagnostics)}</p><p class="small muted">最近连接：${date(item.lastSeenAt)}${item.codex?.version ? ' · Codex ' + escape(item.codex.version) : ''}</p>${item.confirmedAt ? `<p class="small muted">已确认并保存：${date(item.confirmedAt)}</p>` : ''}<p class="small muted">连接编号：${escape(item.id)}</p><div class="row resource-actions">${item.status === 'pending' && canEdit() ? `<button type="button" class="btn btn-primary btn-small" data-confirm-connector="${escape(item.id)}" ${state.busy ? 'disabled' : ''}>核对并确认连接</button>` : ''}${item.status !== 'revoked' && canEdit() ? `<button type="button" class="btn btn-small" data-revoke-connector="${escape(item.id)}" ${state.busy ? 'disabled' : ''}>断开连接</button>` : ''}</div>${state.codexConfirmation?.id === item.id && ['confirm', 'revoke'].includes(state.codexConfirmation.type) ? codexConfirmationView(state.codexConfirmation) : ''}</article>`;
  }).join('');
}
function pairingView() {
  const p = state.pairing;
  if (!p) return '';
  const expired = new Date(p.expiresAt).getTime() <= Date.now();
  return `<section class="banner banner-${expired ? 'warn' : 'info'} pairing-panel"><h3>${expired ? '连接码已过期' : '在自己的电脑上输入连接码'}</h3>${expired ? '<p>请重新生成连接码；这不会断开已经确认的电脑。</p>' : `<p>连接码只用于本次配对。有效期至 ${date(p.expiresAt)}，请勿发送给他人。</p><label class="field"><span>一次性连接码</span><input id="codex-pairing-code" class="pairing-code" value="${escape(p.code)}" readonly autocomplete="off" spellcheck="false"></label><div class="row" style="margin-top:12px">${button('复制连接码', 'copy-pairing-code')}${button('隐藏连接码', 'hide-pairing-code')}</div><p class="small" style="margin-top:12px">连接器输入代码后，这里会出现待确认电脑。核对电脑名称，再点击“核对并确认连接”，并完成“确认连接并保存”。</p>`}</section>`;
}
function codexView() {
  const viewer = !canEdit();
  return title('我的 Codex', '每位成员连接自己的电脑，生成文案或领取自己的浏览器搭建任务。', button('刷新连接状态', 'reload-connectors')) + `<section class="card"><h2>我的电脑</h2><p class="card-description">这里只显示你的连接。文案生成需要命令行连接器保持运行；浏览器搭建由本人桌面 Codex 领取，并核对本人浏览器权限。文案仍需人工审核，启用广告需另行确认。</p>${state.connectorError ? `<p class="banner banner-warn" data-connector-error>${escape(state.connectorError)}</p>` : ''}<div class="resource-grid" data-connector-list>${connectorCards()}</div></section>${viewer ? '<section class="card"><p class="notice">当前账号是只读成员，可以查看已保存的团队方案。连接个人 Codex 和创建生成任务需要编辑权限。</p></section>' : `<section class="card"><h2>连接一台电脑</h2><ol class="connector-steps"><li>在自己的电脑安装 Codex 命令行工具，并完成本人登录。</li><li>在这份项目代码所在文件夹打开终端，运行下面的连接命令。需要 Node.js 24.15 或更新版本。</li><li>点击“生成连接码”，在连接器提示时输入代码，再回到这里核对并确认这台电脑。</li></ol><label class="field"><span>连接命令</span><textarea id="codex-runner-command" class="runner-command" readonly>${escape(ownConnectorCommand())}</textarea></label><div class="row" style="margin-top:14px">${button('复制连接命令', 'copy-runner-command')}${button('生成连接码', 'create-pairing', 'primary')}</div><p class="notice">命令行连接器负责文案生成；浏览器搭建由本人桌面 Codex 领取，仍需本人浏览器权限。启用广告需另行确认。Codex 登录信息留在本机，平台仅保存工作区连接记录。其他同事需要能访问同一个工作区地址；本机 localhost 地址只能供本机使用。</p><div data-pairing-panel>${pairingView()}</div></section>`}`;
}
async function loadConnectors() {
  const context = state.me && {userId: state.me.user.id, teamId: state.me.team.id};
  if (!context) return;
  const result = await api('/api/connectors');
  if (state.me?.user.id !== context.userId || state.me?.team.id !== context.teamId) return;
  state.connectors = result.items || []; state.connectorsLoaded = true; state.connectorError = '';
  if (state.editor && !state.connectors.some(c => c.id === state.editor.selectedConnectorId && c.status !== 'revoked')) state.editor.selectedConnectorId = state.connectors.find(connectorReady)?.id || '';
}
async function loadGenerationJobs(editor) {
  if (!editor?.id) return;
  const result = await api('/api/proposals/' + encodeURIComponent(editor.id) + '/generation/jobs');
  if (state.editor !== editor) return;
  editor.jobs = result.items || []; editor.jobsLoaded = true;
}
function generationJobsView(e) {
  if (!e.jobsLoaded) return '<p class="small muted">生成任务尚未加载，请刷新连接与任务状态。</p>';
  if (!e.jobs.length) return '<p class="small muted">这份方案还没有自动生成任务。</p>';
  const card = job => `<article class="generation-job"><div class="spread"><strong>${escape(jobNames[job.status] || '状态待核对')}</strong>${badge(job.status === 'succeeded' ? '已保存' : activeJob(job) ? '进行中' : '已结束', job.status === 'succeeded' ? 'green' : activeJob(job) ? 'warn' : '')}</div><p class="small">${escape(person(job.owner))} · ${escape(job.deviceName || '我的电脑')} · ${date(job.updatedAt || job.createdAt)}</p><p class="small muted">任务编号：${escape(job.id)}</p>${job.error?.message ? `<p class="small job-error">${escape(job.error.message)}</p>` : ''}${['stale', 'needs_attention', 'failed'].includes(job.status) ? '<p class="small muted">现有文案继续保留。处理问题并保存当前方案后，可重新生成。</p>' : ''}${activeJob(job) && job.owner?.id === state.me?.user.id ? `<div class="row" style="margin-top:10px"><button type="button" class="btn btn-small" data-cancel-generation="${escape(job.id)}" ${state.busy ? 'disabled' : ''}>取消这次生成</button></div>` : ''}</article>`;
  return `<div class="generation-job-list">${card(e.jobs[0])}${e.jobs.length > 1 ? `<details class="history-item" data-codex-job-history ${e.jobHistoryOpen ? 'open' : ''}><summary>之前的生成任务（${e.jobs.length - 1} 条）</summary>${e.jobs.slice(1).map(card).join('')}</details>` : ''}</div>`;
}
function automaticGenerationView(e, editable, clean) {
  const choices = state.connectors.filter(c => c.status === 'active'), selected = state.connectors.find(c => c.id === e.selectedConnectorId), running = (e.jobs || []).find(activeJob);
  const resourcesSaved = e.workflow?.selectionSnapshot?.materials?.length && e.workflow?.selectionSnapshot?.landing;
  return `<section class="card" data-auto-generation><div class="spread"><h2>用自己的 Codex 生成</h2><button class="table-link" type="button" data-nav="codex">管理我的 Codex</button></div><p class="card-description">连接自己的电脑后，一次生成策略、关键词、标题和文案，完成后自动保存到这份方案，等待你修改和审核。</p><p class="notice">本阶段根据已保存的素材名称、说明和页面资料撰写，不会自动读取视频画面。Google 当前准备搜索广告；其他广告形式仍需后续配置。</p>${!state.connectorsLoaded ? '<div class="notice">还没有取得连接状态。</div>' : !choices.length ? '<div class="banner banner-info">先到“我的 Codex”连接自己的电脑，再回到这里生成。也可以使用下方的备用手动交接。</div>' : `<label class="field"><span>用哪台电脑上的 Codex</span><select data-generation-connector ${!editable || state.busy || running ? 'disabled' : ''}>${!selected ? '<option value="">请选择电脑</option>' : ''}${choices.map(item => `<option value="${escape(item.id)}" ${e.selectedConnectorId === item.id ? 'selected' : ''}>${escape(item.name || '我的电脑')} · ${escape(connectorLabel(item)[0])}</option>`).join('')}</select></label>`}${state.connectorError ? `<div class="banner banner-warn">${escape(state.connectorError)}</div>` : ''}${!resourcesSaved ? '<p class="notice">先在“素材与落地页”保存本次选择，再生成文案。</p>' : ''}<div class="row" style="margin-top:15px">${workflowButton(e.workflow?.content ? '重新生成策略与文案' : '自动生成策略与文案', 'automatic-generation', clean && resourcesSaved && connectorReady(selected || {}) && !running, true)}${button('刷新连接与任务', 'reload-generation')}</div>${running ? `<p class="notice">生成任务已交给 ${escape(running.deviceName || '选中的电脑')}。可以继续浏览；手动修改方案后，旧结果会要求重新核对。</p>` : ''}<div data-job-update>${generationUpdateView(e)}</div><div data-codex-jobs>${generationJobsView(e)}</div></section>`;
}
function generationUpdateView(e) {
  return e.jobReloadAvailable ? `<div class="banner banner-info" style="margin-top:16px"><h3>有新的服务器版本可查看</h3><p>你的未保存输入保留在当前页面。请查看服务器最新内容，再决定如何继续。</p><div class="row" style="margin-top:10px">${button('查看服务器最新版本', 'load-latest')}</div></div>` : '';
}
function updateCodexRegions() {
  if (!state.me) { render(); return; }
  if (state.view === 'codex') {
    const list = root.querySelector('[data-connector-list]'); if (list) list.innerHTML = connectorCards();
    const pairing = root.querySelector('[data-pairing-panel]');
    if (pairing && (!state.pairing || new Date(state.pairing.expiresAt).getTime() <= Date.now())) pairing.innerHTML = pairingView();
  }
  if (state.view === 'editor' && state.editorTab === 'content' && state.editor) {
    const area = root.querySelector('[data-auto-generation]');
    if (area && !area.contains(document.activeElement)) {
      const e = state.editor, editable = canEdit() && e.status !== 'archived', clean = editable && !e.dirty && !e.workflowDirty && !e.conflict && !e.workflowUncertain;
      area.outerHTML = automaticGenerationView(e, editable, clean);
    } else {
      const jobs = root.querySelector('[data-codex-jobs]'); if (jobs) jobs.innerHTML = generationJobsView(state.editor);
      const update = root.querySelector('[data-job-update]'); if (update) update.innerHTML = generationUpdateView(state.editor);
    }
  }
}
async function pollCodex(force = false) {
  if (state.codexPollBusy || state.busy || (state.codexConfirmation && state.view === 'codex') || state.loading || !state.me || document.hidden || (!force && Date.now() - state.codexPollAt < 3000)) return;
  const inContent = state.view === 'editor' && state.editorTab === 'content' && state.editor?.id;
  if (state.view !== 'codex' && !inContent) return;
  state.codexPollBusy = true; state.codexPollAt = Date.now();
  const context = {userId: state.me.user.id, teamId: state.me.team.id}, editor = state.editor;
  const oldJobs = clone(editor?.jobs || []);
  try {
    const results = await Promise.allSettled([loadConnectors(), ...(inContent ? [loadGenerationJobs(editor)] : [])]);
    if (state.me?.user.id !== context.userId || state.me?.team.id !== context.teamId) return;
    const rejected = results.find(r => r.status === 'rejected');
    if (rejected) { state.connectorError = '暂时无法刷新连接或任务状态，请检查网络后点击刷新。'; updateCodexRegions(); return; }
    if (inContent && state.editor === editor) {
      const succeeded = editor.jobs.find(job => job.status === 'succeeded' && (Number(job.resultRevision) > editor.revision || oldJobs.some(old => old.id === job.id && old.status !== 'succeeded')));
      if (succeeded) {
        const result = await api('/api/proposals/' + encodeURIComponent(editor.id) + '/workflow');
        if (state.editor !== editor || state.me?.user.id !== context.userId || state.me?.team.id !== context.teamId) return;
        if (result.item.revision > editor.revision) {
          if (editorHasChanges() || state.busy || state.view !== 'editor') {
            editor.jobReloadAvailable = {revision: result.item.revision, jobId: succeeded.id};
          } else {
            const keepTab = state.editorTab, jobs = editor.jobs, selectedConnectorId = editor.selectedConnectorId;
            state.editor = makeEditor(result.item); state.editor.workflow = normalizeWorkflow(result.workflow); state.editor.jobs = jobs; state.editor.jobsLoaded = true; state.editor.selectedConnectorId = selectedConnectorId; state.editorTab = keepTab;
            await Promise.allSettled([loadItems(), loadEditorHistory(state.editor)]);
            notify('Codex 文案已自动回填。请人工修改、核对并提交审核。'); render(); return;
          }
        }
      }
    }
    updateCodexRegions();
  } catch (error) {
    if (!state.me) render();
    else { state.connectorError = '暂时无法刷新连接状态，请点击刷新重试。'; updateCodexRegions(); }
  } finally { state.codexPollBusy = false; }
}
async function copyCodexText(text, success, fallbackId) {
  try { await navigator.clipboard.writeText(text); notify(success); }
  catch { notify('请手动复制已选中的内容。', 'warn'); render(); const input = document.getElementById(fallbackId); input?.focus(); input?.select(); return; }
  render();
}
function handleCodexClick(el) {
  if (el.hasAttribute('data-dismiss-codex-action')) {state.codexConfirmation = null; render(); return true;}
  if (el.hasAttribute('data-confirm-codex-action')) {
    const pending = state.codexConfirmation; if (!pending) return true;
    void perform(async () => {
      if (pending.type === 'cancel') {
        await api('/api/generation-jobs/' + encodeURIComponent(pending.id) + '/cancel', {method: 'POST', body: {}});
        await loadGenerationJobs(state.editor); state.codexConfirmation = null; notify('这次生成已取消。');
      } else {
        await saveConnectorConfirmation(pending);
      }
    }); return true;
  }
  if (el.dataset.confirmConnector || el.dataset.revokeConnector) {
    const id = el.dataset.confirmConnector || el.dataset.revokeConnector, item = state.connectors.find(c => c.id === id); if (!item) return true;
    const confirm = Boolean(el.dataset.confirmConnector);
    state.codexConfirmation = {id, type: confirm ? 'confirm' : 'revoke', message: confirm ? `请核对电脑“${item.name || '我的电脑'}”。确认后，它可以领取由你发起的文案生成和浏览器搭建任务；浏览器操作仍需桌面 Codex 的本人浏览器权限，启用广告需另行确认。Codex 登录信息仍留在本机。` : `断开“${item.name || '我的电脑'}”后，它将无法继续领取或回填文案生成和浏览器搭建任务；已保存内容和执行记录保留，广告后台的现有状态不会因此改变。`, label: confirm ? '确认连接并保存' : '确认断开连接'};
    render();
    const confirmation = root.querySelector('[data-codex-confirmation]');
    confirmation?.scrollIntoView({block: 'nearest'});
    confirmation?.querySelector('[data-confirm-codex-action]')?.focus({preventScroll: true});
    return true;
  }
  if (el.dataset.cancelGeneration) {
    state.codexConfirmation = {id: el.dataset.cancelGeneration, type: 'cancel', message: '取消这次生成后，已保存的文案和人工审核记录继续保留。', label: '确认取消这次生成'};
    render(); return true;
  }
  const action = el.dataset.action;
  if (action === 'hide-pairing-code') { state.pairing = null; render(); return true; }
  if (action === 'copy-pairing-code') { if (state.pairing) void copyCodexText(state.pairing.code, '连接码已复制，请在自己的连接器中输入。', 'codex-pairing-code'); return true; }
  if (action === 'copy-runner-command') { void copyCodexText(ownConnectorCommand(), '连接命令已复制，请在项目代码文件夹中运行。', 'codex-runner-command'); return true; }
  if (action === 'create-pairing') {
    void perform(async () => { const result = await api('/api/connectors/pairing', {method: 'POST', body: {}}); state.pairing = result.pairing; await loadConnectors(); notify('连接码已生成，请在自己的电脑输入，随后回到这里确认。'); }); return true;
  }
  if (action === 'reload-connectors') { void perform(async () => { await loadConnectors(); notify('你的连接状态已刷新。'); }); return true; }
  if (action === 'reload-generation') { void perform(async () => { await Promise.all([loadConnectors(), loadGenerationJobs(state.editor)]); notify('连接和任务状态已刷新。输入仍保留在当前页面。'); }); return true; }
  return false;
}
root.addEventListener('change', event => { if (event.target.hasAttribute('data-generation-connector') && state.editor) state.editor.selectedConnectorId = event.target.value; });
root.addEventListener('toggle', event => { if (!state.editor) return; if (event.target.hasAttribute?.('data-manual-codex')) state.editor.manualGenerationOpen = event.target.open; if (event.target.hasAttribute?.('data-codex-job-history')) state.editor.jobHistoryOpen = event.target.open; }, true);
setInterval(() => { void pollCodex(); }, 3000);

// Browser execution has a separate owner, capability check and enable approval.
// A text-generation connector is never treated as proof of browser access.
const buildNames = {queued: '等待桌面 Codex 领取', claimed: '本人 Codex 已领取', running: '正在核对并搭建', paused_verified: '已创建，并核对为暂停', partially_created: '部分对象已创建', failed: '未完成', unknown: '提交结果待核对', needs_attention: '需要处理后继续', cancelled: '已取消', blocked: '当前条件无法继续', enabled_verified: '已核对启用状态'};
Object.assign(buildNames, {preflight_checked: '已核对账户和表单', publishing: '已取得提交许可，等待结果'});
Object.assign(actionNames, {'build.configuration_updated': '保存广告账户与搭建设置', 'build.queued': '提交创建暂停广告任务', 'build.claimed': '本人桌面 Codex 领取任务', 'build.cancelled': '取消尚未提交的操作', 'build.retry_requested': '请求重试已确认未创建的对象', 'build.enable_previewed': '读取启用确认清单', 'build.enable_confirmed': '单独确认启用指定广告', 'build.evidence_saved': '保存浏览器核对截图', 'build.preflight_saved': '保存账户与暂停方式核对结果', 'build.submit_authorized': '允许本任务提交一次', 'build.result_saved': '回填平台对象与状态', 'build.unexpected_enabled': '发现对象意外启用，需要立即检查', 'build.reconciled': '回填未知结果的核对结论', 'build.lease_expired': '桌面任务连接过期，需核对后继续', 'build.enable_reconciled': '同步已启用对象，保留其余暂停对象', 'build.paused_checkpoint_saved': '保留已创建的暂停对象，继续核对下一步'});
const buildActive = item => ['queued', 'claimed', 'running'].includes(item?.status);
const executionEnums = {
  Google: {campaignType: ['search'], bids: ['manual_cpc', 'maximize_clicks', 'maximize_conversions'], placements: ['google_search']},
  Meta: {campaignType: ['sales'], bids: ['lowest_cost', 'cost_cap'], placements: ['facebook_feed', 'instagram_feed']},
  TikTok: {campaignType: ['website_conversions'], bids: ['lowest_cost', 'cost_cap'], placements: ['tiktok']}
};
const executionLabels = {search: '搜索广告', sales: '网站销售', website_conversions: '网站转化', manual_cpc: '手动点击出价', maximize_clicks: '尽可能争取点击', maximize_conversions: '尽可能争取转化', lowest_cost: '最低成本', cost_cap: '成本上限', campaign: '广告计划预算', ad_group: '广告组预算', inherit_campaign: '沿用父计划预算（不修改父计划）', text: '文字搜索广告', file: '上传的图片或视频文件', creator_code: '达人广告代码（本期可保存，暂不发布）', phrase: '词组匹配', exact: '完全匹配'};
function executionTargetSeed(e, platform) {
  const Google = platform === 'Google';
  return {platform, accountId: e.brief.operation === 'new_group' ? e.brief.parentCampaign?.accountId || '' : '', accountName: '', accountCurrency: '', accountTimeZone: '', accountUrl: '', campaignName: e.brief.operation === 'new_group' ? e.brief.parentCampaign?.name || '' : e.title, groupName: e.brief.groupName || '', campaignType: executionEnums[platform].campaignType[0], budgetLevel: e.brief.operation === 'new_group' && Google ? 'inherit_campaign' : Google ? 'campaign' : 'ad_group', dailyBudget: e.brief.budgets[platform] ?? '', bidStrategy: Google ? 'manual_cpc' : 'lowest_cost', bidValue: null, conversionEventId: '', conversionEventName: '', pixelId: '', identityId: '', locationIds: String(e.brief.country || '').split(/[,，]/).map(v => v.trim()).filter(Boolean), languageCodes: String(e.brief.language || '').split(/[,，]/).map(v => v.trim()).filter(Boolean), placements: platform === 'Meta' ? ['facebook_feed'] : executionEnums[platform].placements.slice(), keywordMatchType: Google ? 'phrase' : null, creativeMode: Google ? 'text' : 'file', instagramAccountId: '', audienceBindings: (e.workflow?.selection?.audiences || []).map(a => ({resourceId: a.id, resourceRevision: a.revision, use: a.use, platformAudienceId: ''}))};
}
function executionDraftTargets(e) {
  const existing = e.executionDraft || [];
  return e.brief.platforms.map(platform => {
    const target = {...executionTargetSeed(e, platform), ...(existing.find(t => t.platform === platform) || {})};
    target.audienceBindings = (e.workflow?.selection?.audiences || []).map(ref => ({resourceId: ref.id, resourceRevision: ref.revision, use: ref.use, platformAudienceId: target.audienceBindings?.find(binding => binding.resourceId === ref.id && binding.resourceRevision === ref.revision && binding.use === ref.use)?.platformAudienceId || ''}));
    return target;
  });
}
function executionConfigurationMatchesSelection(e) {
  const targets = e.executionData?.configuration?.targets || [], audiences = e.workflow?.selection?.audiences || [];
  return targets.length === e.brief.platforms.length && e.brief.platforms.every(platform => {
    const target = targets.find(value => value.platform === platform);
    return target && target.dailyBudget === e.brief.budgets[platform] && target.audienceBindings?.length === audiences.length && audiences.every(ref => target.audienceBindings.some(binding => binding.resourceId === ref.id && binding.resourceRevision === ref.revision && binding.use === ref.use));
  });
}
function executionField(platform, field, label, value, disabled, options = {}) {
  const attr = `data-execution-platform="${platform}" data-execution-field="${field}"`;
  const common = `${disabled ? 'disabled' : ''} ${options.type === 'number' ? 'type="number" min="0" step="0.01"' : 'type="text" maxlength="' + (field === 'accountUrl' ? 2048 : 200) + '"'}`;
  return `<label class="field ${options.full ? 'full' : ''}"><span>${escape(label)}</span>${options.choices ? `<select ${attr} ${disabled ? 'disabled' : ''}>${options.choices.map(choice => `<option value="${escape(choice)}" ${String(value) === choice ? 'selected' : ''}>${escape(executionLabels[choice] || choice)}</option>`).join('')}</select>` : `<input ${attr} ${common} value="${escape(Array.isArray(value) ? value.join(', ') : value ?? '')}" ${options.placeholder ? 'placeholder="' + escape(options.placeholder) + '"' : ''}>`}${options.note ? `<small>${escape(options.note)}</small>` : ''}</label>`;
}
function executionPlacementField(target, disabled) {
  const labels = {google_search: 'Google 搜索结果', facebook_feed: 'Facebook 动态', instagram_feed: 'Instagram 动态', tiktok: 'TikTok 信息流'};
  return `<fieldset class="full"><legend>投放位置</legend><div class="checks">${executionEnums[target.platform].placements.map(placement => `<label class="check"><input type="checkbox" data-execution-platform="${escape(target.platform)}" data-execution-placement="${placement}" ${target.placements?.includes(placement) ? 'checked' : ''} ${disabled ? 'disabled' : ''}>${escape(labels[placement])}</label>`).join('')}</div><p class="small muted">只使用这里选中的位置，不自动扩展到其他广告网络。</p></fieldset>`;
}
function capabilityView(capabilities) {
  if (!capabilities?.length) return '<div class="notice">浏览器能力尚未核对。已连接文案生成器，不等于已连接广告后台。</div>';
  return `<div class="execution-capabilities">${capabilities.map(c => { const status = c.createPaused || c.status || 'unverified'; return `<div class="hint-box"><div class="spread"><strong>${escape(c.platform || '浏览器')}</strong>${badge(status === 'supported' ? '暂停搭建方式已核对' : status === 'blocked' ? '当前不能搭建' : '等待浏览器核对', status === 'supported' ? 'green' : 'warn')}</div><p class="small">${escape(c.reason || '执行前仍需核对实际账户、表单和暂停开关。')}</p></div>`; }).join('')}</div>`;
}
function executionConfigView(e) {
  const editable = canEdit() && e.status !== 'archived', disabled = !editable || state.busy;
  const targets = executionDraftTargets(e);
  const input = (t, field, label, options = {}) => executionField(t.platform, field, label, t[field], disabled, options);
  return `<section class="card"><h2>广告账户与搭建设置</h2><p class="card-description">先登记本次要操作的账户。保存这些设置会产生新方案版本，需要重新人工审核；不会直接修改广告后台。</p>${!targets.length ? '<p class="notice">先在投放需求中选择平台并保存，再填写账户设置。</p>' : `<form id="execution-config-form">${targets.map(t => `<section class="execution-target"><h3>${escape(t.platform)} · ${e.brief.operation === 'new_group' ? '已有计划下新增广告组' : '新建广告计划'}</h3><div class="form-grid">${input(t, 'accountId', '广告账户编号')}${input(t, 'accountName', '广告账户名称')}${input(t, 'accountCurrency', '账户币种', {placeholder: '例如 USD、CNY'})}${input(t, 'accountTimeZone', '账户时区', {placeholder: '例如 America/Los_Angeles'})}${input(t, 'accountUrl', '广告账户后台地址', {full: true, placeholder: '请从本人已登录的广告后台复制地址'})}${input(t, 'campaignType', '广告形式', {choices: executionEnums[t.platform].campaignType})}${input(t, 'campaignName', e.brief.operation === 'new_group' ? '父计划名称（仅用于核对）' : '新广告计划名称')}${input(t, 'groupName', '新广告组名称')}${input(t, 'budgetLevel', '预算设置在哪一层', {choices: t.platform === 'Google' ? [e.brief.operation === 'new_group' ? 'inherit_campaign' : 'campaign'] : t.platform === 'TikTok' ? ['ad_group'] : e.brief.operation === 'new_group' ? ['ad_group', 'inherit_campaign'] : ['ad_group', 'campaign']})}${input(t, 'dailyBudget', '日预算（按账户币种）', {type: 'number', note: '沿用父计划预算时，此值只用于核对，不会修改父计划。'})}${input(t, 'bidStrategy', '出价方式', {choices: executionEnums[t.platform].bids})}${input(t, 'bidValue', '点击出价或成本上限（需要时填写）', {type: 'number'})}${input(t, 'creativeMode', '广告素材使用方式', {choices: t.platform === 'Google' ? ['text'] : ['file', 'creator_code']})}${input(t, 'conversionEventId', '转化目标／事件编号')}${input(t, 'conversionEventName', '转化目标／事件名称')}${t.platform !== 'Google' ? input(t, 'pixelId', '网站像素／数据集编号') + input(t, 'identityId', t.platform === 'Meta' ? '用于投放的主页编号' : '用于投放的关联身份编号') + (t.platform === 'Meta' ? input(t, 'instagramAccountId', 'Instagram 账号编号（选择 Instagram 版位时填写）') : '') : input(t, 'keywordMatchType', '关键词匹配方式', {choices: ['phrase', 'exact']})}${input(t, 'locationIds', '后台地区名称或编号', {placeholder: '多项用逗号分隔', note: '浏览器必须核对到唯一选项，不能猜测位置。'})}${input(t, 'languageCodes', '后台语言名称或编号', {placeholder: '多项用逗号分隔'})}${executionPlacementField(t, disabled)}</div>${t.audienceBindings?.length ? `<div class="section-divider"></div><h3>已选人群在广告平台中的对应编号</h3><p class="small muted">导入邮箱不等于已完成平台匹配。需要先在该平台拥有可用的人群，或回到素材步骤取消选用。</p><div class="form-grid">${t.audienceBindings.map((a, i) => `<label class="field"><span>${escape(e.workflow?.selectionSnapshot?.audiences?.find(v => v.id === a.resourceId)?.name || a.resourceId)} · ${a.use === 'exclude' ? '排除' : '包含'}</span><input data-execution-platform="${t.platform}" data-execution-audience="${i}" value="${escape(a.platformAudienceId || '')}" ${disabled ? 'disabled' : ''} maxlength="200" placeholder="平台人群编号"></label>`).join('')}</div>` : ''}</section>`).join('')}<div class="form-footer"><span class="small muted">${e.executionDirty ? '本页有未保存的设置。' : '设置只在保存后进入方案版本。'}</span>${editable ? `<button class="btn btn-primary" type="submit" ${state.busy || e.dirty || e.workflowDirty || e.conflict || e.executionUncertain ? 'disabled' : ''}>保存账户与搭建设置</button>` : ''}</div></form>`}${e.executionUncertain ? `<div class="banner banner-warn" style="margin-top:16px">刚才的保存结果尚未确认。输入仍保留，请先读取服务器记录再决定是否重试。${button('核对服务器设置', 'inspect-execution-latest')}</div>` : ''}</section>`;
}
function executionView(e) {
  if (!e.executionData) return `<section class="card"><h2>广告搭建</h2><p>${escape(e.executionError || '正在读取账户设置和搭建记录…')}</p>${button('读取搭建信息', 'reload-execution')}</section>`;
  const d = e.executionData, editable = canEdit() && e.status !== 'archived';
  const clean = editable && !editorHasChanges() && !e.conflict && !e.saveUncertain;
  const reviewed = e.workflow?.review?.status === 'approved';
  const blocked = (d.capabilities || []).some(c => (c.createPaused || c.status) === 'blocked');
  const active = (d.builds || []).some(buildActive);
  const devices = state.connectors.filter(c => c.status === 'active');
  if (!devices.some(c => c.id === e.executionConnectorId)) e.executionConnectorId = devices[0]?.id || '';
  const singleMaterial = e.workflow?.selection?.materials?.length === 1, matched = executionConfigurationMatchesSelection(e);
  const unsupportedCreative = (d.configuration?.targets || []).some(target => target.platform !== 'Google' && target.creativeMode !== 'file');
  return `<section class="card"><h2>先创建暂停广告，再单独启用</h2><p class="card-description">浏览器先核对账户、表单和暂停方式。无法确认发布前已关闭投放时，会停止并回报原因；不会先启用再补暂停。</p>${capabilityView(d.capabilities)}</section>${executionConfigView(e)}<section class="card"><h2>提交搭建前核对</h2><div class="notice">首版每个平台创建一个广告组、一条广告，共用本方案选定的一份素材。Google 使用已审核的标题和描述组合；Meta、TikTok 使用首条标题和正文。多素材方案请拆分后分别审核。</div>${briefSummary(e.brief)}${executionTargetSummary(d.configuration?.targets || [])}<details class="execution-snapshot"><summary>查看本方案已保存的素材、文案与链接</summary>${e.workflow ? workflowSnapshotSummary(e.workflow) : '<p>请先加载方案内容。</p>'}</details><p class="notice">只操作当前方案指定的账户、计划和广告组。新增广告组不修改父计划原有内容。成功创建的对象会保留，结果不明时先核对，避免重复创建。</p>${unsupportedCreative ? '<div class="banner banner-warn">本期仅支持 Meta 图片／视频文件及 TikTok 视频文件广告。达人代码可以保存为素材来源，纯代码广告需等待专用授权流程。</div>' : ''}${!reviewed ? '<div class="banner banner-warn">当前版本尚未通过人工审核。保存账户设置后，请回到“人工审核”重新确认。</div>' : ''}${!d.configuration?.targets?.length ? '<div class="banner banner-warn">请先保存账户与搭建设置。</div>' : !matched ? '<div class="banner banner-warn">平台、预算或所选人群与已保存的搭建设置不同。请核对本页设置并保存，再重新人工审核。</div>' : ''}<label class="field"><span>用哪个本人连接领取桌面任务</span><select data-build-connector ${!editable || state.busy || active ? 'disabled' : ''}><option value="">请选择已确认的本人连接</option>${devices.map(c => `<option value="${escape(c.id)}" ${c.id === e.executionConnectorId ? 'selected' : ''}>${escape(c.name || '我的电脑')}</option>`).join('')}</select><small>这是本人身份绑定，不代表文案连接器拥有浏览器权限。桌面 Codex 仍需使用本人已登录的浏览器。</small></label><div class="row" style="margin-top:14px">${executionAction('核对并创建暂停广告', 'create-build', clean && reviewed && Boolean(d.configuration?.targets?.length) && !blocked && !active && Boolean(e.executionConnectorId) && singleMaterial && matched && !unsupportedCreative, true)}${button('刷新搭建记录', 'reload-execution')}</div><p class="small muted" style="margin-top:12px">搭建和启用是两个任务。文案生成连接器不会因为已在线，就直接操作广告后台。</p></section><section class="card"><h2>本方案搭建记录</h2>${buildListTable(d.builds || [])}</section>${state.buildDetail?.item?.proposalId === e.id ? buildDetailView(state.buildDetail) : ''}`;
}
function executionAction(label, action, enabled, primary = false, attrs = '') {return `<button type="button" class="btn ${primary ? 'btn-primary' : ''}" data-execution-action="${action}" ${attrs} ${!enabled || state.busy ? 'disabled' : ''}>${escape(label)}</button>`;}
function executionTargetSummary(targets) {
  if (!targets?.length) return '<p class="notice">尚未保存广告账户设置。</p>';
  return `<div class="table-wrap"><table><thead><tr><th>平台／账户</th><th>预算与出价</th><th>转化与身份</th></tr></thead><tbody>${targets.map(t => `<tr><td>${escape(t.platform)} · ${escape(t.accountName || '账户名称待补充')}<span class="cell-note">账户 ${escape(t.accountId)} · ${escape(t.accountTimeZone || '时区待补充')}</span><span class="cell-note">${escape(t.campaignName || '')} / ${escape(t.groupName || '')}</span></td><td>${escape(t.dailyBudget ?? '待补充')} ${escape(t.accountCurrency || '币种待补充')} / 日<span class="cell-note">${escape(executionLabels[t.budgetLevel] || t.budgetLevel || '')} · ${escape(executionLabels[t.bidStrategy] || t.bidStrategy || '')}${t.bidValue ? ' · ' + escape(t.bidValue) : ''}</span></td><td>${escape(t.conversionEventName || '转化目标待补充')}<span class="cell-note">${escape(t.conversionEventId || '')}${t.identityId ? ' · 身份 ' + escape(t.identityId) : ''}</span></td></tr>`).join('')}</tbody></table></div>`;
}
function buildListTable(items) {
  if (!items.length) return '<div class="empty">还没有搭建任务。审核通过后，从方案提交创建暂停广告。</div>';
  return `<div class="table-wrap"><table><thead><tr><th>任务／方案</th><th>状态</th><th>发起人</th><th>更新时间</th></tr></thead><tbody>${items.map(item => `<tr><td><button type="button" class="table-link" data-open-build="${escape(item.id)}">${item.kind === 'enable' ? '启用任务' : '创建暂停广告'} · ${escape(item.proposalTitle || item.proposalId || item.id)}</button><span class="cell-note">${escape(item.id)} · V${escape(item.proposalRevision || '')}</span></td><td>${badge(buildNames[item.status] || '状态待核对', item.status === 'paused_verified' ? 'green' : ['unknown', 'needs_attention', 'failed', 'partially_created'].includes(item.status) ? 'warn' : '')}</td><td>${escape(person(item.owner))}</td><td>${date(item.updatedAt || item.createdAt)}</td></tr>`).join('')}</tbody></table></div>`;
}
function buildsView() {
  return title('广告搭建', '团队共享查看任务、对象编号和核对结果；创建暂停广告与确认启用分开进行。', button('刷新任务', 'reload-builds')) + `<section class="card"><h2>搭建与启用任务</h2>${!state.buildsLoaded ? '<div class="empty">正在读取任务…</div>' : buildListTable(state.builds)}</section>${state.buildDetail ? buildDetailView(state.buildDetail) : '<section class="card"><p class="notice">点击任务查看指定账户、冻结方案、创建对象和结果证据。</p></section>'}`;
}
function buildObjectsView(objects) {
  if (!objects?.length) return '<div class="notice">尚未回填可核对的广告对象编号。空记录不代表创建成功。</div>';
  const observed = value => ({paused: '已观察为暂停', enabled: '已观察为启用', unknown: '尚未确认', draft: '仅草稿'})[value] || '状态待核对';
  return `<div class="table-wrap"><table><thead><tr><th>平台／账户</th><th>对象编号</th><th>浏览器核对结果</th></tr></thead><tbody>${objects.map(o => `<tr><td>${escape(o.platform)}<span class="cell-note">账户 ${escape(o.accountId)}</span></td><td>${o.level ? `${escape(({campaign: '广告计划', adGroup: '广告组', ad: '广告'})[o.level] || o.level)} ${escape(o.id)}<span class="cell-note">父对象 ${escape(o.parentId || '无')}</span>` : `计划 ${escape(o.campaignId || '未回填')}<span class="cell-note">广告组 ${escape(o.adGroupId || o.groupId || '未回填')}</span><span class="cell-note">广告 ${escape(o.adId || '未回填')}</span>`}</td><td>${badge(observed(o.statusObserved || o.status), (o.statusObserved || o.status) === 'paused' ? 'green' : 'warn')}<span class="cell-note">${o.observedAt ? date(o.observedAt) : '核对时间见执行过程与截图'}</span>${o.url ? `<a href="${safeHref(o.url)}" target="_blank" rel="noopener noreferrer">查看广告后台 ↗</a>` : ''}${o.evidence?.observation ? `<p class="small">${escape(o.evidence.observation)}</p>` : ''}</td></tr>`).join('')}</tbody></table></div>`;
}
function pausedHierarchyNote(snapshot, objects) {
  const groupOnly = snapshot.brief?.operation === 'new_group', gate = groupOnly ? 'adGroup' : 'campaign';
  const affected = [...new Set(objects.filter(object => object.level === gate && object.status === 'paused' && objects.some(child => child.platform === object.platform && child.level !== gate && child.status === 'enabled')).map(object => object.platform))];
  if (!affected.length) return '';
  return `<div class="banner banner-info" style="margin-top:14px">${escape(affected.join('、'))} 的${groupOnly ? '新广告组' : '广告计划'}已暂停，当前不会投放；下级对象的开关可能保持启用，仍受上级暂停控制。</div>`;
}
function buildSpecificationView(snapshot, {enable = false, platforms: targetPlatforms = null} = {}) {
  const specs = (snapshot.adSpecifications || []).filter(spec => !targetPlatforms || targetPlatforms.includes(spec.platform));
  if (!specs.length) return '';
  const values = items => (Array.isArray(items) ? items : items ? [items] : []).map(value => typeof value === 'object' ? value.text || value.keyword || JSON.stringify(value) : value).join('\n');
  return `<section class="execution-snapshot"><h3>${enable ? '本次启用对应的广告内容' : '这次实际要创建的广告内容'}</h3><p class="small muted">${enable ? '仅核对冻结内容，不重新创建或改文案；本次只启用已单独确认的原有编号。' : '首版每个平台一个广告组、一条广告。Google 使用以下标题与描述组合；Meta、TikTok 使用以下首条标题和正文。新增对象名称包含任务短号，方便核对。'}</p>${specs.map(spec => `<details class="history-item" open><summary>${escape(spec.platform)} · ${escape(spec.name || '广告名称见冻结方案')}</summary><dl class="definition-grid"><dt>标题</dt><dd class="preserve-lines">${escape(values(spec.headlines))}</dd><dt>描述</dt><dd class="preserve-lines">${escape(values(spec.descriptions))}</dd><dt>正文</dt><dd class="preserve-lines">${escape(spec.primaryText || '不适用')}</dd><dt>行动按钮</dt><dd>${escape(spec.callToAction || '不适用')}</dd><dt>关键词</dt><dd class="preserve-lines">${escape(values(spec.keywords) || '不适用')}</dd><dt>排除关键词</dt><dd class="preserve-lines">${escape(values(spec.negativeKeywords) || '无')}</dd><dt>最终链接</dt><dd>${spec.landingUrl ? `<a href="${safeHref(spec.landingUrl)}" target="_blank" rel="noopener noreferrer">${escape(spec.landingUrl)}</a>` : '未返回'}</dd><dt>素材／追踪记录</dt><dd>${escape(spec.materialId || '不适用')} / ${escape(spec.trackingId || '未返回')}</dd></dl></details>`).join('')}${snapshot.effectiveNames && Object.keys(snapshot.effectiveNames).length ? `<p class="small preserve-lines">${enable ? '原搭建名称' : '创建名称'}：${escape(Object.entries(snapshot.effectiveNames).filter(([platform]) => !targetPlatforms || targetPlatforms.includes(platform)).map(([platform, names]) => `${platform}：计划 ${names.campaign || ''} / 广告组 ${names.adGroup || ''} / 广告 ${names.ad || ''}`).join('；'))}</p>` : ''}</section>`;
}
function enableAccountsView(preview) {
  const accounts = preview.targetAccounts || [], budgets = preview.budgets || [];
  if (!accounts.length) return executionTargetSummary(preview.targets || []);
  return `<div class="table-wrap"><table><thead><tr><th>平台／账户</th><th>币种／时区</th><th>日预算</th></tr></thead><tbody>${accounts.map(account => {const budget = budgets.find(value => value.platform === account.platform) || {}; return `<tr><td>${escape(account.platform)} · ${escape(account.accountName)}<span class="cell-note">${escape(account.accountId)}</span></td><td>${escape(account.currency || account.accountCurrency || budget.currency)}<span class="cell-note">${escape(account.timeZone || account.accountTimeZone)}</span></td><td>${escape(budget.dailyBudget ?? '未返回')} ${escape(budget.currency || account.currency)}<span class="cell-note">${escape(executionLabels[budget.budgetLevel] || budget.budgetLevel || '')}</span></td></tr>`;}).join('')}</tbody></table></div>`;
}
function buildTargetStatusView(targets) {
  if (!targets?.length) return '';
  return `<div class="execution-capabilities" style="margin:16px 0">${targets.map(target => `<div class="hint-box"><div class="spread"><strong>${escape(target.platform)}</strong>${badge(buildNames[target.status] || '等待核对', target.status === 'paused_verified' ? 'green' : ['blocked', 'unknown', 'failed', 'needs_attention', 'partially_created'].includes(target.status) ? 'warn' : '')}</div>${target.reason ? `<p class="small">${escape(target.reason)}</p>` : ''}</div>`).join('')}</div>`;
}
function buildEvidenceView(data) {
  if (!data.evidence?.length) return '';
  const stages = {preflight: '账户与表单核对', before_publish: '创建前暂停核对', after_publish: '创建后重新打开核对', before_enable: '启用前核对', after_enable: '启用后核对', reconcile: '查询提交结果'};
  return `<details class="execution-snapshot"><summary>查看浏览器核对截图（${data.evidence.length} 张）</summary><p class="small muted">截图由执行者从广告后台保存，供团队复核；不代表另有广告 API 独立验证。</p><ul>${data.evidence.map(evidence => `<li><a href="/api/builds/${encodeURIComponent(data.item.id)}/evidence/${encodeURIComponent(evidence.id)}" target="_blank" rel="noopener noreferrer">${escape(evidence.platform)} · ${escape(stages[evidence.stage] || '核对截图')}</a><span class="cell-note">${date(evidence.createdAt)}${evidence.caption ? ' · ' + escape(evidence.caption) : ''}</span></li>`).join('')}</ul></details>`;
}
function buildDetailView(data) {
  const item = data.item || {}, snapshot = data.snapshot || item.snapshot || {}, events = data.events || item.events || [];
  const objects = (data.objects || item.objects || []).map(object => ({...object, observedAt: object.observedAt || item.targets?.find(target => target.platform === object.platform)?.lastObservedAt}));
  const snapshotWorkflow = snapshot.workflow || (snapshot.selectionSnapshot ? snapshot : null);
  const owner = canEdit() && item.owner?.id === state.me?.user?.id, clean = !editorHasChanges() && !state.busy;
  const paused = item.kind !== 'enable' && objects.length > 0 && (item.targets || []).length > 0 && item.targets.every(target => ['paused_verified', 'enabled_verified'].includes(target.status)) && item.targets.some(target => target.status === 'paused_verified');
  const needsReconcile = ['unknown', 'needs_attention'].includes(item.status) || (item.targets || []).some(target => ['unknown', 'needs_attention'].includes(target.status));
  return `<section class="card execution-detail"><div class="spread"><h2>${item.kind === 'enable' ? '启用任务' : '暂停搭建任务'} · ${escape(buildNames[item.status] || '状态待核对')}</h2>${executionAction('刷新此任务', 'refresh-build', true, false, `data-build-id="${escape(item.id)}"`)}</div><p class="small muted">任务 ${escape(item.id)} · ${escape(person(item.owner))} · ${date(item.createdAt)}</p>${item.error?.message || item.message ? `<div class="banner banner-warn">${escape(item.error?.message || item.message)}</div>` : ''}${item.status === 'unknown' ? '<div class="banner banner-warn">提交结果尚未确认。必须先从广告后台查询现有对象，不能直接重新创建。</div>' : ''}${item.status === 'enabled_verified' ? '<div class="banner banner-info">已核对启用状态。这不代表已开始展示；平台审核、账户预算和投放条件仍会影响实际投放。</div>' : ''}${executionTargetSummary((snapshot.targets || snapshot.configuration?.targets || item.targets || []).filter(target => item.kind !== 'enable' || (item.targets || []).some(current => current.platform === target.platform)))}${buildTargetStatusView(item.targets)}${buildObjectsView(objects)}${pausedHierarchyNote(snapshot, objects)}${buildEvidenceView(data)}${buildSpecificationView(snapshot, {enable: item.kind === 'enable', platforms: item.kind === 'enable' ? (item.targets || []).map(target => target.platform) : null})}<div class="row" style="margin-top:18px">${owner && ['queued', 'claimed', 'running', 'unknown', 'needs_attention', 'partially_created', 'blocked'].includes(item.status) ? executionAction('复制桌面执行说明', 'copy-build-handoff', true, false, `data-build-id="${escape(item.id)}"`) : ''}${owner && ['queued', 'claimed'].includes(item.status) ? executionAction(item.status === 'queued' ? '取消尚未开始的任务' : '请求停止当前任务', 'cancel-build', clean, false, `data-build-id="${escape(item.id)}"`) : ''}${owner && item.kind !== 'enable' && !needsReconcile && (item.targets || []).some(target => ['failed', 'blocked'].includes(target.status)) && ['failed', 'partially_created', 'blocked'].includes(item.status) ? executionAction('只重试未成功的对象', 'retry-build', clean, false, `data-build-id="${escape(item.id)}"`) : ''}${owner && needsReconcile ? executionAction('交给本人 Codex 核对结果', 'reconcile-build', clean, false, `data-build-id="${escape(item.id)}"`) : ''}${owner && paused ? executionAction(item.targets?.some(target => target.status === 'enabled_verified') ? '核对其余暂停广告的启用清单' : '核对启用清单', 'enable-preview', clean, true, `data-build-id="${escape(item.id)}"`) : ''}</div><p class="notice">这个任务由桌面 Codex 通过本人浏览器执行。文案连接器不会自动开启浏览器；请在自己的桌面聊天中绑定浏览器并领取任务。没有观察到平台对象和暂停状态时，不会显示为创建成功。</p>${owner ? `<details class="execution-snapshot"><summary>桌面执行说明（可复制）</summary><label class="field"><span>在自己的桌面 Codex 聊天中继续</span><textarea id="browser-handoff-${escape(item.id)}" readonly rows="7">${escape(buildHandoffText(data))}</textarea></label></details>` : ''}${enablePreviewView(item.id)}<details class="execution-snapshot"><summary>查看这次执行冻结的方案</summary>${snapshot.brief || snapshot.proposal?.brief ? briefSummary(snapshot.brief || snapshot.proposal.brief) : ''}${snapshotWorkflow ? workflowSnapshotSummary(snapshotWorkflow) : '<p class="notice">本任务未返回完整方案快照，请刷新核对。</p>'}</details>${events.length ? `<details class="execution-snapshot"><summary>查看执行过程（${events.length} 条）</summary><ol class="execution-events">${events.map(event => `<li><strong>${escape(event.message || actionNames[event.action] || event.action || event.type || '任务更新')}</strong><span class="cell-note">${date(event.createdAt || event.at)}</span>${event.detail?.message ? `<p class="small">${escape(event.detail.message)}</p>` : ''}</li>`).join('')}</ol></details>` : ''}</section>`;
}
function buildHandoffText(data) {
  if (data.handoff?.prompt) return data.handoff.prompt;
  const item = data.item || {}, enable = item.kind === 'enable';
  return `请先读取本项目 docs/BROWSER-EXECUTION.md，在当前桌面 Codex 中检查浏览器工具是否可用。工作区：${location.origin}；任务编号：${item.id}。在项目代码目录运行：node runner/browser-client.mjs claim --build ${item.id}。这个命令只读取已审核快照，不代表已打开浏览器。使用本人已登录的浏览器核对账户、预算、素材、目标和对象。${enable ? '这是已单独确认的启用任务，只能操作冻结清单中的对象；先核对清单和对象实际状态，保存 before_enable 证据并申请 intent 后才启用。' : '保存 preflight、before_publish 证据并申请 intent 后才提交。必须在提交前确认暂停控制，创建后重新打开核对暂停。不可先启用再暂停；无法保证时停止并回填 blocked。本任务不授权启用。'}每 60 秒 heartbeat 续期。结果不明时先查询现有对象，不重复创建。按文档回填平台对象编号和证据。不要复制登录凭据、连接令牌或浏览器会话到聊天。`;
}
function enablePreviewView(buildId) {
  const preview = state.buildPreview;
  if (!preview || preview.buildId !== buildId) return '';
  const expired = !preview.expiresAt || new Date(preview.expiresAt).getTime() <= Date.now();
  return `<section class="banner banner-warn execution-enable" role="region" aria-label="启用前人工确认"><h3>确认后，以下广告对象可能开始花费预算</h3><p>请逐项核对账户、币种、预算、计划和广告组。本次只申请启用清单内的对象，不扩展到其他计划。</p>${enableAccountsView(preview)}${buildObjectsView(preview.objects || [])}${preview.changeSummary ? `<p>${escape(typeof preview.changeSummary === 'string' ? preview.changeSummary : JSON.stringify(preview.changeSummary))}</p>` : ''}<p class="small">确认清单有效期至 ${date(preview.expiresAt)}；过期或方案变化后需要重新核对。</p>${expired ? '<p>清单已过期，请重新读取后确认。</p>' : `<label class="check"><input type="checkbox" data-enable-acknowledgement ${preview.acknowledged ? 'checked' : ''}>我已核对上述账户、对象和预算，确认允许启用。</label>`}<div class="row" style="margin-top:14px">${executionAction('确认启用这些广告', 'confirm-enable', !expired && preview.acknowledged, true, `data-build-id="${escape(buildId)}"`)}${executionAction('暂不启用', 'dismiss-enable', true)}</div><p class="small" style="margin-top:12px">这是独立的启用确认。方案审核通过、任务领取或创建成功都不会代替这一步。</p></section>`;
}
const executionContext = () => `${state.me?.user?.id || ''}:${state.me?.team?.id || ''}`;
async function loadBuilds() {const context = executionContext(), result = await api('/api/builds'); if (!state.me || context !== executionContext()) return; state.builds = result.items || []; state.buildsLoaded = true;}
async function loadBuildDetail(id) {const context = executionContext(), result = await api('/api/builds/' + encodeURIComponent(id)); if (!state.me || context !== executionContext()) return; state.buildDetail = result; return result;}
async function loadExecution(e, {preserve = true} = {}) {
  if (!e?.id) return;
  const context = executionContext();
  try {
    const result = await api('/api/proposals/' + encodeURIComponent(e.id) + '/execution');
    if (state.editor !== e || !state.me || context !== executionContext()) return;
    e.executionData = result; e.executionError = '';
    if (!preserve || (!e.executionDirty && !e.executionUncertain)) e.executionDraft = clone(result.configuration?.targets || []);
    if (!editorHasChanges() && result.item && result.item.revision >= e.revision) {
      e.revision = result.item.revision; e.title = result.item.title; e.brief = normalizedBrief(result.item.brief); e.status = result.item.status; e.updatedAt = result.item.updatedAt;
      if (result.workflow) e.workflow = normalizeWorkflow(result.workflow);
    }
    return result;
  } catch (error) { e.executionError = error.message; if (error.status === 401) throw error; return null; }
}
function markExecutionDirty() {
  const e = state.editor; if (!e || !canEdit() || e.status === 'archived') return;
  e.executionDirty = true; state.buildPreview = null;
  const indicator = root.querySelector('[data-editor-save-state]'); if (indicator) indicator.textContent = '有未保存的修改';
  root.querySelectorAll('[data-execution-action], [data-workflow-action]').forEach(button => {if (!['reload-execution', 'refresh-build', 'dismiss-enable'].includes(button.dataset.executionAction)) button.disabled = true;});
}
function executionTargetsPayload(e) {
  const targets = executionDraftTargets(e);
  return targets.map(t => ({...t, dailyBudget: t.dailyBudget === '' ? null : Number(t.dailyBudget), bidValue: t.bidValue === '' || t.bidValue === null ? null : Number(t.bidValue), locationIds: Array.isArray(t.locationIds) ? t.locationIds : [], languageCodes: Array.isArray(t.languageCodes) ? t.languageCodes : [], placements: Array.isArray(t.placements) ? t.placements : []}));
}
async function saveExecutionConfig() {
  const e = state.editor;
  if (!e?.id || !canEdit() || e.dirty || e.workflowDirty || e.conflict || e.executionUncertain) return;
  try {
    const result = await api('/api/proposals/' + encodeURIComponent(e.id) + '/execution/config', {method: 'POST', body: {expectedRevision: e.revision, targets: executionTargetsPayload(e)}});
    const next = makeEditor(result.item); next.workflow = normalizeWorkflow(result.workflow || result.item.workflow); next.importText = e.importText; next.reviewNote = e.reviewNote; next.executionConnectorId = e.executionConnectorId; next.recovery = e.recovery; next.executionData = result.execution || {...(e.executionData || {}), ...result}; next.executionDraft = clone((result.configuration || result.execution?.configuration)?.targets || executionTargetsPayload(e));
    state.editor = next; state.editorTab = 'execution'; state.buildPreview = null;
    await Promise.all([loadItems(), loadEditorHistory(next), loadExecution(next, {preserve: false})]); notify('账户与搭建设置已保存，请重新核对并人工审核。广告后台没有发生变化。');
  } catch (error) {
    if (error.status === 409 && error.code === 'REVISION_CONFLICT') { e.conflict = {latest: error.payload?.current?.item || null, reviewed: false}; notify('同事已保存了新版本。你的账户设置仍保留，请先核对最新版本。', 'warn'); return; }
    if (error.status === 0) e.executionUncertain = true;
    throw error;
  }
}
function handleExecutionClick(el) {
  if (el.dataset.openBuild) {void perform(async () => {await loadBuildDetail(el.dataset.openBuild); if (state.view !== 'editor') state.view = 'builds';}); return true;}
  const action = el.dataset.executionAction || (['reload-execution', 'inspect-execution-latest', 'reload-builds'].includes(el.dataset.action) ? el.dataset.action : '');
  if (!action) return false;
  if (action === 'copy-build-handoff') {
    const item = state.buildDetail?.item; if (!item || item.id !== el.dataset.buildId) return true;
    void copyCodexText(buildHandoffText(state.buildDetail), '桌面执行说明已复制。请在自己的 Codex 桌面聊天中使用。', 'browser-handoff-' + item.id); return true;
  }
  if (action === 'dismiss-enable') {state.buildPreview = null; render(); return true;}
  if (action === 'confirm-enable' && (!state.buildPreview?.acknowledged || state.buildPreview.buildId !== el.dataset.buildId)) return true;
  void perform(async () => {
    const e = state.editor, id = el.dataset.buildId || state.buildDetail?.item?.id;
    if (action === 'reload-builds') {await loadBuilds(); if (state.buildDetail?.item?.id) await loadBuildDetail(state.buildDetail.item.id); notify('搭建任务已刷新。');}
    if (action === 'reload-execution') {if (await loadExecution(e)) notify('搭建记录已刷新，未保存的设置仍保留。'); else notify(e?.executionError || '搭建信息尚未读取成功，请重试。', 'warn');}
    if (action === 'inspect-execution-latest') {
      const result = await api('/api/proposals/' + encodeURIComponent(e.id) + '/execution');
      e.executionData = result; e.executionUncertain = false; e.executionDirty = true;
      notify('服务器设置已读取。你的输入仍保留，请比较后决定是否重新保存。', 'warn');
    }
    if (action === 'create-build') {
      if (!e || editorHasChanges() || e.workflow?.review?.status !== 'approved') return;
      const result = await api('/api/proposals/' + encodeURIComponent(e.id) + '/builds', {method: 'POST', body: {expectedRevision: e.revision, connectorId: e.executionConnectorId}});
      if (result.item) state.buildDetail = result;
      await loadExecution(e); await loadBuilds(); notify('已提交暂停搭建任务。需要在自己的桌面 Codex 中领取并核对浏览器与账户，尚未启用广告。');
    }
    if (action === 'refresh-build') await loadBuildDetail(id);
    if (action === 'cancel-build') {await api('/api/builds/' + encodeURIComponent(id) + '/cancel', {method: 'POST', body: {}}); await loadBuildDetail(id); if (e?.executionData) await loadExecution(e); await loadBuilds(); notify('停止请求已记录。已提交的对象仍需按后台结果核对。');}
    if (action === 'retry-build') {await api('/api/builds/' + encodeURIComponent(id) + '/retry', {method: 'POST', body: {expectedRevision: e?.revision || state.buildDetail?.item?.proposalRevision}}); await loadBuildDetail(id); await loadBuilds(); notify('已请求仅重试明确未成功的对象，成功对象保留。');}
    if (action === 'reconcile-build') {await loadBuildDetail(id); await copyCodexText(buildHandoffText(state.buildDetail), '核对说明已复制。请在自己的桌面 Codex 聊天中领取同一任务并查询结果，尚未自动执行。', 'browser-handoff-' + id);}
    if (action === 'enable-preview') {const result = await api('/api/builds/' + encodeURIComponent(id) + '/enable-preview', {method: 'POST', body: {}}); state.buildPreview = {...result.preview, buildId: id, acknowledged: false};}
    if (action === 'confirm-enable') {
      const preview = state.buildPreview;
      if (!preview || !preview.acknowledged || preview.buildId !== id || new Date(preview.expiresAt).getTime() <= Date.now()) throw new Error('请重新读取启用清单并逐项核对。');
      const result = await api('/api/builds/' + encodeURIComponent(id) + '/enable', {method: 'POST', body: {previewId: preview.id, confirmation: 'ENABLE_REVIEWED_OBJECTS'}});
      state.buildPreview = null; if (result.item) state.buildDetail = result; else await loadBuildDetail(id); await loadBuilds();
      notify('启用确认已记录。任务完成后仍需回填实际状态，不能据此认定已开始投放。');
    }
  }); return true;
}
root.addEventListener('submit', event => {if (event.target.id === 'execution-config-form') {event.preventDefault(); if (!state.busy) void perform(saveExecutionConfig);}});
function changeExecutionField(el) {
  const e = state.editor; if (!e?.id || !canEdit() || e.status === 'archived') return;
  const platform = el.dataset.executionPlatform; if (!platform) return;
  e.executionDraft = executionDraftTargets(e);
  const target = e.executionDraft.find(t => t.platform === platform); if (!target) return;
  if (el.hasAttribute('data-execution-audience')) {
    const binding = target.audienceBindings[Number(el.dataset.executionAudience)]; if (binding) binding.platformAudienceId = el.value;
  } else if (el.dataset.executionPlacement) {
    target.placements = el.checked ? [...new Set([...(target.placements || []), el.dataset.executionPlacement])] : (target.placements || []).filter(value => value !== el.dataset.executionPlacement);
  } else if (el.dataset.executionField) {
    const field = el.dataset.executionField;
    target[field] = ['locationIds', 'languageCodes', 'placements'].includes(field) ? el.value.split(/[,，]/).map(v => v.trim()).filter(Boolean) : el.value;
  }
  markExecutionDirty();
}
root.addEventListener('input', event => {if (event.target.dataset.executionPlatform) changeExecutionField(event.target);});
root.addEventListener('change', event => {
  const el = event.target;
  if (el.dataset.executionPlatform) changeExecutionField(el);
  if (el.hasAttribute('data-build-connector') && state.editor) state.editor.executionConnectorId = el.value;
  if (el.hasAttribute('data-enable-acknowledgement') && state.buildPreview) {state.buildPreview.acknowledged = el.checked; const button = root.querySelector('[data-execution-action="confirm-enable"]'); if (button) button.disabled = !el.checked || state.busy;}
});
async function pollExecution() {
  if (state.executionPollBusy || state.busy || state.loading || !state.me || document.hidden || Date.now() - state.executionPollAt < 5000) return;
  const inEditor = state.view === 'editor' && state.editorTab === 'execution' && state.editor?.id;
  if (!inEditor && state.view !== 'builds') return;
  state.executionPollBusy = true; state.executionPollAt = Date.now();
  const e = state.editor;
  try {
    if (inEditor) await loadExecution(e);
    else await loadBuilds();
    if (state.buildDetail?.item?.id) await loadBuildDetail(state.buildDetail.item.id);
    if (!editorHasChanges() && !state.buildPreview && !state.busy && document.activeElement?.closest?.('form')?.id !== 'execution-config-form') render();
  } catch { /* A manual refresh exposes the actionable error without erasing inputs. */ }
  finally {state.executionPollBusy = false;}
}
setInterval(() => {void pollExecution();}, 5000);

// Daily reporting is read-only. Filters never change a proposal or an ad switch.
function reportingContext() {return `${state.me?.user?.id || ''}:${state.me?.team?.id || ''}`;}
function reportingAccountId(account) {return String(account?.id || account?.accountId || '');}
function reportingKey() {const r = state.reporting; return [r.accountId, r.reportDate, r.campaignId].join(':');}
function completeReportingDate(timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
    const field = type => parts.find(part => part.type === type)?.value;
    const day = new Date(`${field('year')}-${field('month')}-${field('day')}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() - 1); return day.toISOString().slice(0,10);
  } catch {return '';}
}
function reportingNumber(value, digits = 0) {return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('zh-CN', {maximumFractionDigits:digits}).format(value) : '未知';}
function reportingRate(value) {return typeof value === 'number' && Number.isFinite(value) ? reportingNumber(value * 100, 2) + '%' : '—';}
function reportingMoney(value, currency) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  return reportingNumber(value, 2) + (currency ? ' ' + escape(currency) : '');
}
function reportingStateName(value) {return ({PAUSED:'已暂停',ENABLED:'已启用',REMOVED:'已移除',UNKNOWN:'状态未知',UNSPECIFIED:'状态未知'})[value] || '状态未知';}
function reportMoment(value, timeZone) {
  if (!value) return '尚无记录';
  try {return new Intl.DateTimeFormat('zh-CN', {timeZone:timeZone || 'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}
  catch {return '时间待核对';}
}
async function loadReportingDetail(reportId) {
  const r = state.reporting, context = reportingContext(), key = reportingKey();
  try {
    const payload = await api('/api/reporting/reports/' + encodeURIComponent(reportId) + (r.campaignId ? '?campaignId=' + encodeURIComponent(r.campaignId) : ''));
    if (!state.me || context !== reportingContext() || key !== reportingKey()) return;
    const detail = payload.report || payload.item || payload;
    r.detail = detail; r.detailKey = key; r.error = '';
    if (!r.campaignId) r.campaignOptions = detail.campaigns || [];
  } catch (error) {
    if (context === reportingContext() && key === reportingKey()) r.error = error.message || '日报暂时无法读取。';
    throw error;
  }
}
async function loadReporting() {
  const context = reportingContext();
  try {
    const data = await api('/api/reporting');
    if (!state.me || context !== reportingContext()) return;
    const r = state.reporting;
    r.data = data; r.error = '';
    const accounts = data.accounts || [];
    if (!accounts.some(account => reportingAccountId(account) === r.accountId)) {
      r.accountId = reportingAccountId(accounts[0]); r.reportDate = ''; r.campaignId = ''; r.detail = null; r.detailKey = ''; r.campaignOptions = [];
    }
    const reports = (data.reports || []).filter(report => String(report.accountId || report.account?.id || '') === r.accountId).sort((a,b) => String(b.reportDate).localeCompare(String(a.reportDate)));
    const account = accounts.find(item => reportingAccountId(item) === r.accountId);
    if (!r.reportDate) r.reportDate = reports[0]?.reportDate || completeReportingDate(account?.timeZone);
    const report = reports.find(item => item.reportDate === r.reportDate);
    if (report) await loadReportingDetail(report.id);
    else {r.detail = null; r.detailKey = ''; r.campaignOptions = [];}
  } catch (error) {
    if (context === reportingContext()) state.reporting.error = error.message || '日报暂时无法读取。';
    throw error;
  }
}
function reportMetric(label, value, change) {
  const relative = change && typeof change.relative === 'number' && Number.isFinite(change.relative) ? `${change.relative > 0 ? '+' : ''}${reportingNumber(change.relative * 100, 1)}%` : null;
  const absolute = change && typeof change.absolute === 'number' && Number.isFinite(change.absolute) ? `${change.absolute > 0 ? '+' : ''}${reportingNumber(change.absolute, 2)}` : null;
  return `<section class="card report-metric"><div class="metric-label">${escape(label)}</div><div class="report-metric-value">${value}</div>${absolute === null ? '' : `<div class="small muted">较上一日 ${escape(absolute)}${relative ? `（${escape(relative)}）` : '（无可比百分比）'}</div>`}</section>`;
}
function reportTrendView(report) {
  const rows = report.trend || [];
  if (!rows.length) return '<section class="card"><h2>近期费用</h2><p class="muted small">当前没有可用的逐日数据。</p></section>';
  const values = rows.map(row => row.cost ?? row.totals?.cost), known = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  const max = Math.max(...known, 0), step = rows.length > 1 ? 600 / (rows.length - 1) : 0;
  let segments = [], segment = [];
  values.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {if (segment.length) segments.push(segment.join(' ')); segment = []; return;}
    segment.push(`${30 + index * step},${max ? 138 - value / max * 116 : 138}`);
  });
  if (segment.length) segments.push(segment.join(' '));
  const chart = known.length ? `<svg class="report-trend" viewBox="0 0 660 190" role="img" aria-label="${escape(rows[0].date)}至${escape(rows.at(-1).date)}每日费用趋势，${escape(report.currency || report.account?.currency || '')}"><line x1="30" y1="138" x2="630" y2="138" class="report-chart-axis"/>${segments.map(points => `<polyline points="${points}" class="report-chart-line"/>`).join('')}${values.map((value,index) => typeof value === 'number' && Number.isFinite(value) ? `<circle cx="${30 + index * step}" cy="${max ? 138 - value / max * 116 : 138}" r="4" class="report-chart-point"><title>${escape(rows[index].date)}：${escape(reportingNumber(value,2))} ${escape(report.currency || report.account?.currency || '')}</title></circle>` : '').join('')}<text x="30" y="171">${escape(rows[0].date)}</text><text x="630" y="171" text-anchor="end">${escape(rows.at(-1).date)}</text><text x="30" y="15">${escape(reportingNumber(max,2))} ${escape(report.currency || report.account?.currency || '')}</text></svg>` : '<p class="small muted">费用数据未知。</p>';
  return `<section class="card"><h2>近期费用</h2>${chart}<details class="report-source"><summary>查看逐日数据</summary><div class="table-wrap"><table><thead><tr><th>日期</th><th>费用</th><th>展示</th><th>点击</th><th>平台转化</th></tr></thead><tbody>${rows.map(row => {const t = row.totals || row; return `<tr><td>${escape(row.date)}</td><td>${reportingMoney(t.cost,report.currency || report.account?.currency)}</td><td>${reportingNumber(t.impressions)}</td><td>${reportingNumber(t.clicks)}</td><td>${reportingNumber(t.conversions,2)}</td></tr>`;}).join('')}</tbody></table></div></details></section>`;
}
function reportCampaignsView(report) {
  return `<section class="card"><div class="spread"><h2>广告计划明细</h2>${state.reporting.campaignId ? '<button type="button" class="btn btn-small" data-reporting-action="all-campaigns">查看整个账户</button>' : ''}</div><p class="card-description">指标属于所选日期；状态是最近同步时的当前状态。</p><div class="table-wrap"><table class="report-campaign-table"><thead><tr><th>计划 / 编号</th><th>当前状态</th><th>费用</th><th>展示 / 点击</th><th>点击率</th><th>平台转化 / 每次转化费用</th><th>对应的已执行方案</th></tr></thead><tbody>${(report.campaigns || []).map(item => {const t = item.totals || {};return `<tr><td><button type="button" class="table-link" data-report-campaign="${escape(item.id)}">${escape(item.name || item.id)}</button><span class="cell-note">${escape(item.id)}</span>${item.startDate && item.startDate > report.reportDate ? `<span class="cell-note">${escape(item.startDate)} 开始，所选日期尚未投放</span>` : ''}</td><td>${badge(reportingStateName(item.status),item.status === 'PAUSED' ? '' : item.status === 'ENABLED' ? 'green' : 'warn')}</td><td>${reportingMoney(t.cost, report.currency || report.account?.currency)}</td><td>${reportingNumber(t.impressions)} / ${reportingNumber(t.clicks)}</td><td>${reportingRate(t.ctr)}</td><td>${reportingNumber(t.conversions,2)} / ${t.cpa === null ? '—' : reportingMoney(t.cpa, report.currency || report.account?.currency)}</td><td>${(item.associations || []).map(link => `<button type="button" class="table-link report-association" data-report-build="${escape(link.buildId)}">${escape(link.title || '查看执行记录')} · V${escape(link.proposalRevision)}</button>`).join('') || '<span class="small muted">未关联工作区方案</span>'}</td></tr>`;}).join('') || '<tr><td colspan="7" class="empty">所选范围没有广告计划记录。</td></tr>'}</tbody></table></div></section>`;
}
function reportingDetailView(report) {
  const t = report.totals || {}, changes = report.comparison?.changes || report.changes || {}, currency = report.currency || report.account?.currency || '';
  const facts = report.summary || [], advice = report.recommendations || [];
  return `<div class="report-scope"><strong>${escape(report.scope?.campaignId ? '单个计划：' + (report.scope.name || report.scope.campaignId) : '整个 Google Ads 账户')}</strong><span>${escape(report.reportDate)} · ${escape(report.timeZone || report.account?.timeZone)} · ${escape(currency)}</span></div><div class="report-metrics">${reportMetric('费用',reportingMoney(t.cost,currency),changes.cost)}${reportMetric('展示次数',reportingNumber(t.impressions),changes.impressions)}${reportMetric('点击次数',reportingNumber(t.clicks),changes.clicks)}${reportMetric('点击率',reportingRate(t.ctr))}${reportMetric('平均点击费用',t.cpc === null ? '—' : reportingMoney(t.cpc,currency))}${reportMetric('Google Ads 平台转化',reportingNumber(t.conversions,2),changes.conversions)}${reportMetric('每次平台转化费用',t.cpa === null ? '—' : reportingMoney(t.cpa,currency))}${reportMetric('平台转化价值',reportingMoney(t.conversionValue,currency))}</div><section class="card"><h2>数据总结</h2>${facts.length ? `<ul class="report-findings">${facts.map(line => `<li>${escape(line)}</li>`).join('')}</ul>` : '<p class="small muted">当前数据不足以生成总结。</p>'}<p class="small muted report-note">根据已同步数据和固定规则生成；不推断尚未验证的原因。</p></section><section class="card"><h2>迭代建议</h2><p class="card-description">建议供人工复核。采纳后仍需另建方案、审核和执行，不会自动调整预算或启用广告。</p>${advice.map(item => `<article class="report-advice"><h3>${escape(item.title || '建议先核对')}</h3><p class="small">${escape(item.detail || '')}</p></article>`).join('') || '<p class="small muted">当前没有有依据的调整建议；继续观察数据。</p>'}</section>${reportTrendView(report)}<section class="card"><h2>转化目标明细</h2><p class="card-description">以下是 Google Ads 归因转化，可含小数；不能直接当作网站注册人数、首订人数或去重付费用户。</p><div class="table-wrap"><table><thead><tr><th>转化目标 / 编号</th><th>类别</th><th>平台转化</th><th>转化价值</th></tr></thead><tbody>${(report.conversionActions || []).map(item => `<tr><td>${escape(item.name || item.id)}<span class="cell-note">${escape(item.id)}</span></td><td>${escape(({SIGNUP:'注册',PURCHASE:'购买',BEGIN_CHECKOUT:'开始结账'})[item.category] || item.category || '未知')}</td><td>${reportingNumber(item.conversions,2)}</td><td>${reportingMoney(item.conversionValue,currency)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">所选日期没有返回转化目标记录。</td></tr>'}</tbody></table></div></section>${reportCampaignsView(report)}<section class="card report-source"><h2>数据来源与范围</h2><p class="small">来源：${escape(report.source?.provider || 'Google Ads')} · 数据日期截至 ${escape(report.source?.observedThrough || report.observedThrough || report.reportDate)}<br>最近成功读取：${escape(reportMoment(report.source?.fetchedAt || report.fetchedAt, report.timeZone || report.account?.timeZone))}（${escape(report.timeZone || report.account?.timeZone)}）</p>${(report.limitations || []).length ? `<ul class="report-findings small">${report.limitations.map(line => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}<details><summary>查看统计说明</summary><p class="small preserve-lines">${escape(report.source?.zeroSemantics || '')}</p><p class="small">本日报趋势覆盖 ${escape(report.source?.window?.startDate || '未知')} 至 ${escape(report.source?.window?.endDate || '未知')}。${report.source?.queryWindow ? `本次实际读取 ${escape(report.source.queryWindow.startDate || '未知')} 至 ${escape(report.source.queryWindow.endDate || '未知')}，用于回补近期日报。` : ''}${report.source?.queriedThrough && report.source.queriedThrough !== report.source?.queryWindow?.endDate ? `本次读取截至 ${escape(report.source.queriedThrough)}。` : ''}平台转化会随归因回补而变化，后续同步可能修订历史日报。未读取的网站后台注册、首订和其他平台数据均为未知。</p></details></section>`;
}
function reportingScheduleView(account) {
  const r = state.reporting, accountId = reportingAccountId(account), draft = r.scheduleDrafts[accountId] || account;
  return `<section class="card"><h2>每天更新</h2><p class="card-description">本机服务运行时自动更新；关闭电脑或停止服务后不会持续执行。重新运行后，会补查最新完整日。</p>${canManage() ? `<form id="report-schedule-form"><fieldset ${state.busy ? 'disabled' : ''}><div class="report-schedule-fields"><label class="check"><input type="checkbox" data-report-schedule-enabled ${draft.dailyEnabled ? 'checked' : ''}>每天生成前一天的日报</label><label class="field"><span>更新时间（${escape(account.timeZone)}）</span><input type="time" data-report-schedule-time value="${escape(draft.localTime || '10:00')}" required></label><button type="submit" class="btn">保存更新时间</button></div></fieldset></form>` : `<p class="small">${account.dailyEnabled ? `已开启，每天 ${escape(account.localTime || '10:00')}` : '尚未开启自动更新'}（${escape(account.timeZone)}）。由管理员管理更新时间。</p>`}<p class="notice">最近成功同步：${escape(reportMoment(account.lastSuccessAt || account.lastSyncAt, account.timeZone))}</p></section>`;
}
function reportingView() {
  const r = state.reporting, data = r.data, accounts = data?.accounts || [], account = accounts.find(item => reportingAccountId(item) === r.accountId), detail = r.detailKey === reportingKey() ? r.detail : null;
  const connection = data?.connection || {}, configured = Boolean(connection.configured);
  const connectionMessage = connection.message || (typeof connection.error === 'string' ? connection.error : connection.error?.message) || (configured ? '配置已就绪；同步成功后才会显示真实日报。' : '请由部署者配置服务器上的 Google Ads 只读数据连接。已有日报仍可查看。');
  let html = title('投放日报', '读取 Google Ads 真实数据，查看每日表现和待人工核对的建议。', '<button type="button" class="btn" data-reporting-action="reload" ' + (state.busy ? 'disabled' : '') + '>刷新日报列表</button>');
  if (!data) return html + `<section class="card"><p class="muted">${r.error ? escape(r.error) : '正在读取日报…'}</p></section>`;
  html += `<section class="card"><div class="spread"><h2>Google Ads 数据</h2>${badge(configured ? '已配置，只读读取' : '尚未配置读取', configured ? '' : 'warn')}</div><p class="small">${escape(connectionMessage)}</p>${canManage() ? `<details class="report-account-setup" ${accounts.length ? '' : 'open'}><summary>接入一个 Google Ads 账户</summary><form id="report-account-form"><fieldset ${state.busy || !configured ? 'disabled' : ''}><div class="report-account-input"><label class="field"><span>Google Ads 账户编号</span><input data-report-account-input value="${escape(r.accountInput)}" inputmode="numeric" pattern="[0-9]{10}" maxlength="10" placeholder="填写 10 位账户编号" required><small>仅接入服务器已获准读取的账户。无需在网页填写密钥。</small></label><button type="submit" class="btn btn-primary">接入并生成日报</button></div></fieldset></form></details>` : ''}</section>`;
  if (r.error) html += `<div class="banner banner-warn" role="alert">${escape(r.error)}${detail ? ' 下方保留最近成功读取的数据，请留意同步时间。' : ''}</div>`;
  if (!accounts.length) return html + '<section class="card"><div class="empty">还没有接入的账户。接入后会生成最近完整日的真实日报；暂无数据时不会显示示例数字。</div></section>';
  const lastError = typeof account?.lastError === 'string' ? account.lastError : account?.lastError?.message;
  html += `<section class="card"><div class="form-grid"><label class="field"><span>广告账户</span><select data-report-account ${state.busy ? 'disabled' : ''}>${accounts.map(item => `<option value="${escape(reportingAccountId(item))}" ${reportingAccountId(item) === r.accountId ? 'selected' : ''}>${escape(item.name || 'Google Ads')} · ${escape(reportingAccountId(item))} · ${escape(item.currency)}</option>`).join('')}</select></label><label class="field"><span>日报日期（${escape(account?.timeZone || '账户时区')}）</span><input type="date" data-report-date value="${escape(r.reportDate)}" max="${escape(completeReportingDate(account?.timeZone))}" ${state.busy ? 'disabled' : ''}><small>只统计完整日，不将今天未结束的数据当作完整日报。</small></label><label class="field full"><span>查看计划</span><select data-report-campaign-filter ${state.busy ? 'disabled' : ''}><option value="">整个账户</option>${(r.campaignOptions || []).map(item => `<option value="${escape(item.id)}" ${r.campaignId === item.id ? 'selected' : ''}>${escape(item.name || item.id)} · ${escape(item.id)}</option>`).join('')}</select></label></div><div class="form-footer"><span class="small muted">${escape(account?.currency || '')} · ${escape(account?.timeZone || '')}</span>${canEdit() ? `<button type="button" class="btn btn-primary" data-reporting-action="sync" ${state.busy || !configured || !r.reportDate ? 'disabled' : ''}>${state.busy ? '正在处理…' : '更新数据并生成日报'}</button>` : '<span class="small muted">编辑成员和管理员可以更新数据。</span>'}</div>${lastError && lastError !== r.error ? `<div class="banner banner-warn report-note">上次同步未完成：${escape(lastError)}。已有日报未被覆盖。</div>` : ''}</section>`;
  html += detail ? reportingDetailView(detail) : '<section class="card"><div class="empty">这个日期尚未生成日报。更新成功后才会显示数据；当前指标为未知。</div></section>';
  if (account) html += reportingScheduleView(account);
  return html;
}
async function syncReporting() {
  const r = state.reporting;
  if (!canEdit() || !r.accountId || !r.reportDate) return;
  try {
    await api('/api/reporting/sync', {method:'POST',body:{accountId:r.accountId,reportDate:r.reportDate}});
    await loadReporting(); notify('Google Ads 数据已读取，日报已保存。广告状态未改变。');
  } catch (error) {
    r.error = error.message || '本次同步未完成。';
    // Readback can reveal an acknowledged report after a lost POST response.
    try {await loadReporting(); r.error = error.message || '本次同步结果需要核对。';} catch { /* Keep the last successful visible data. */ }
    throw error;
  }
}
function handleReportingClick(el) {
  if (el.dataset.reportCampaign !== undefined) {
    const r = state.reporting; r.campaignId = el.dataset.reportCampaign;
    const report = (r.data?.reports || []).find(item => item.accountId === r.accountId && item.reportDate === r.reportDate);
    if (report) void perform(() => loadReportingDetail(report.id)); return true;
  }
  if (el.dataset.reportBuild) {void perform(async () => {await loadBuildDetail(el.dataset.reportBuild); state.view = 'builds'; await loadBuilds();}); return true;}
  const action = el.dataset.reportingAction;
  if (!action) return false;
  void perform(async () => {
    if (action === 'open') await navigate('reporting');
    if (action === 'reload') {await loadReporting(); notify('日报列表已刷新。');}
    if (action === 'sync') await syncReporting();
    if (action === 'all-campaigns') {state.reporting.campaignId = ''; await loadReporting();}
  }); return true;
}
root.addEventListener('input', event => {
  const el = event.target, r = state.reporting;
  if (el.hasAttribute('data-report-account-input')) r.accountInput = el.value;
  if (el.hasAttribute('data-report-schedule-time')) {const account = r.data?.accounts?.find(item => reportingAccountId(item) === r.accountId); if (account) r.scheduleDrafts[r.accountId] = {...(r.scheduleDrafts[r.accountId] || account),localTime:el.value};}
});
root.addEventListener('change', event => {
  const el = event.target, r = state.reporting;
  if (el.hasAttribute('data-report-schedule-enabled')) {const account = r.data?.accounts?.find(item => reportingAccountId(item) === r.accountId); if (account) r.scheduleDrafts[r.accountId] = {...(r.scheduleDrafts[r.accountId] || account),dailyEnabled:el.checked}; return;}
  if (state.busy) return;
  if (el.hasAttribute('data-report-account')) {r.accountId = el.value; r.reportDate = ''; r.campaignId = ''; r.campaignOptions = []; r.detail = null; r.detailKey = ''; void perform(loadReporting);}
  if (el.hasAttribute('data-report-date')) {r.reportDate = el.value; r.campaignId = ''; r.campaignOptions = []; r.detail = null; r.detailKey = ''; void perform(loadReporting);}
  if (el.hasAttribute('data-report-campaign-filter')) {r.campaignId = el.value; void perform(loadReporting);}
});
root.addEventListener('submit', event => {
  if (!['report-account-form','report-schedule-form'].includes(event.target.id)) return;
  event.preventDefault(); if (state.busy || !canManage()) return;
  void perform(async () => {
    const r = state.reporting;
    if (event.target.id === 'report-account-form') {
      const accountId = r.accountInput.trim();
      if (!/^\d{10}$/.test(accountId)) {notify('请填写 10 位 Google Ads 账户编号。','warn'); return;}
      await api('/api/reporting/accounts', {method:'POST',body:{accountId}});
      r.accountId = accountId; r.reportDate = ''; r.campaignId = ''; r.accountInput = ''; await loadReporting(); notify('账户已接入，真实日报已保存。');
    } else {
      const account = r.data?.accounts?.find(item => reportingAccountId(item) === r.accountId), draft = r.scheduleDrafts[r.accountId] || account;
      if (!account || !draft) return;
      await api('/api/reporting/accounts/' + encodeURIComponent(r.accountId), {method:'PATCH',body:{dailyEnabled:Boolean(draft.dailyEnabled),localTime:draft.localTime || '10:00'}});
      delete r.scheduleDrafts[r.accountId]; await loadReporting(); notify('每日更新时间已保存。自动更新需要本机服务保持运行。');
    }
  });
});

void start();
