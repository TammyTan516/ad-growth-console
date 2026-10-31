// SPDX-License-Identifier: MIT
// Reporting owns local snapshots only. Its reader exposes no advertising writes.
import {randomUUID, createHash} from 'node:crypto';
import {ensure, AppError} from './errors.mjs';
import {fields} from './validation.mjs';

const ACCOUNT = /^\d{10}$/;
const REMOTE = /^\d{1,30}$/;
const validAccount = value => typeof value==='string' && ACCOUNT.test(value);
const DAY = 86400000;
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;
const offset = (date, days) => new Date(Date.parse(date + 'T12:00:00Z') + days * DAY).toISOString().slice(0,10);
const clean = (value, max = 500) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const byKeys = (...keys) => (a,b) => {for(const key of keys) {if(a[key]<b[key]) return -1;if(a[key]>b[key]) return 1;}return 0;};
function localParts(now, zone) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(v=>[v.type,v.value]));
    return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};
  } catch { throw new AppError(422,'INVALID_REPORT_SOURCE','Google 返回的账户时区无法识别，未保存日报。'); }
}
function totals(rows) {
  let cost = 0n, impressions = 0, clicks = 0, conversions = 0, conversionValue = 0;
  for (const r of rows) {cost += BigInt(r.costMicros); impressions += r.impressions; clicks += r.clicks; conversions += r.conversions; conversionValue += r.conversionValue;}
  const amount = Number(cost) / 1e6;
  ensure(cost<=BigInt(Number.MAX_SAFE_INTEGER) && Number.isFinite(amount) && Number.isSafeInteger(impressions) && Number.isSafeInteger(clicks) && Number.isFinite(conversions) && Number.isFinite(conversionValue),422,'INVALID_REPORT_SOURCE','Google 返回的数值超出本版日报可核对范围。');
  return {impressions,clicks,costMicros:String(cost),cost:amount,conversions,conversionValue,ctr:impressions ? clicks / impressions : null,cpc:clicks ? amount / clicks : null,cpa:conversions>0 ? amount / conversions : null};
}
const change = (now, before) => ({absolute:now-before,relative:before === 0 ? null : (now-before)/before});
function changes(current, before) {return Object.fromEntries(['impressions','clicks','cost','conversions'].map(k=>[k,change(current[k],before[k])]));}
function validateData(value, accountId, startDate, endDate) {
  const invalid = () => new AppError(422,'INVALID_REPORT_SOURCE','Google 返回的数据不完整或口径不一致，未替换上次日报。');
  if (!value || !value.account || value.account.id !== accountId || !clean(value.account.name,250) || !/^[A-Z]{3}$/.test(value.account.currency || '') || !clean(value.account.timeZone,100) || !Array.isArray(value.campaigns) || !Array.isArray(value.daily) || !Array.isArray(value.conversionDaily) || value.campaigns.length > 20000 || value.daily.length > 300000 || value.conversionDaily.length > 300000) throw invalid();
  localParts(Date.now(), value.account.timeZone);
  const seen = new Set(), ids = new Set();
  for (const c of value.campaigns) {
    if (!REMOTE.test(c.id || '') || ids.has(c.id) || !clean(c.name,500) || !clean(c.status,50) || !clean(c.channelType,80) || (c.startDate && !isoDate(c.startDate))) throw invalid();
    ids.add(c.id);
  }
  for (const r of value.daily) {
    const key = r.date + ':' + r.campaignId;
    if (!isoDate(r.date) || r.date < startDate || r.date > endDate || !ids.has(r.campaignId) || seen.has(key) || !Number.isSafeInteger(r.impressions) || r.impressions < 0 || !Number.isSafeInteger(r.clicks) || r.clicks < 0 || !/^\d{1,25}$/.test(r.costMicros || '') || !Number.isFinite(r.conversions) || !Number.isFinite(r.conversionValue)) throw invalid();
    seen.add(key);
  }
  const actionRows = new Set();
  for (const r of value.conversionDaily) {
    const key = [r.date,r.campaignId,r.conversionActionId].join(':');
    if (!isoDate(r.date) || r.date < startDate || r.date > endDate || !ids.has(r.campaignId) || !REMOTE.test(r.conversionActionId || '') || actionRows.has(key) || !clean(r.conversionActionName,500) || !clean(r.category,100) || !Number.isFinite(r.conversions) || !Number.isFinite(r.conversionValue)) throw invalid();
    actionRows.add(key);
  }
  // Provider pagination/order is not a data revision. Canonicalize the validated
  // projections before either aggregation or hashing, without mutating input.
  return {account:{id:value.account.id,name:value.account.name,currency:value.account.currency,timeZone:value.account.timeZone},campaigns:value.campaigns.map(c=>({id:c.id,name:c.name,status:c.status,channelType:c.channelType,...(c.startDate ? {startDate:c.startDate} : {})})).sort(byKeys('id')),daily:value.daily.map(r=>({date:r.date,campaignId:r.campaignId,impressions:r.impressions,clicks:r.clicks,costMicros:r.costMicros,conversions:r.conversions,conversionValue:r.conversionValue})).sort(byKeys('date','campaignId')),conversionDaily:value.conversionDaily.map(r=>({date:r.date,campaignId:r.campaignId,conversionActionId:r.conversionActionId,conversionActionName:r.conversionActionName,category:r.category,conversions:r.conversions,conversionValue:r.conversionValue})).sort(byKeys('date','campaignId','conversionActionId'))};
}
function summarize(document) {
  const t = document.totals, before = document.comparison.totals, currency = document.account.currency;
  const n = v => new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(v);
  const summary = [`${document.reportDate}：花费 ${n(t.cost)} ${currency}，获得 ${n(t.impressions)} 次展示、${n(t.clicks)} 次点击，记录 ${n(t.conversions)} 次平台转化。`];
  const recommendations = [];
  if (!t.impressions && !t.clicks && !t.cost) {
    const paused = document.campaigns.length && document.campaigns.every(c=>c.status === 'PAUSED' || (c.startDate && c.startDate > document.reportDate));
    if(t.conversions!==0 || t.conversionValue!==0) {
      summary.push('报告日未记录展示、点击或费用，但存在平台归因转化或转化价值；这些指标不能直接解释为当日新增注册或首订。');
      recommendations.push({id:'attribution-review',priority:'review',title:'先核对归因日期与转化回补',detail:'请人工核对 Google 的归因日期、转化目标、回补或调整记录。原因尚未验证，不能据此判断当日新流量或素材效果；不会自动调整预算或启用暂停对象。',requiresReview:true});
    } else {
      summary.push(paused ? '所选计划当前暂停或尚未开始；报告日没有投放记录，不能据此判断素材效果。' : '报告日没有投放记录；先核对计划状态、日期、审核结果和数据范围，再判断原因。');
      recommendations.push({id:'no-delivery',priority:'review',title:'先核对没有投放的原因',detail:paused ? '保留暂停状态；这份日报不会启用验收计划，也不把零投放判定为素材表现差。' : '人工检查计划状态、广告审核、开始日期与数据范围，确认后再决定下一步。',requiresReview:true});
    }
  } else {
    const delta = t.cost - before.cost;
    summary.push(`较 ${document.comparison.date}，花费${delta < 0 ? '减少' : '增加'} ${n(Math.abs(delta))} ${currency}，平台转化${t.conversions < before.conversions ? '减少' : '增加'} ${n(Math.abs(t.conversions-before.conversions))} 次。`);
    if (t.clicks && !t.conversions) recommendations.push({id:'conversion-check',priority:'review',title:'检查点击后的转化链路',detail:'已有点击，报告日暂未记录平台转化。先核对转化目标、落地页和追踪链接，并等待转化回补；尚不能认定文案无效。',requiresReview:true});
    if (t.conversions && t.cpa !== null && before.cpa !== null && t.cpa > before.cpa) recommendations.push({id:'cpa-review',priority:'review',title:'核对每次平台转化费用的变化',detail:`本日为 ${n(t.cpa)} ${currency}，前一日为 ${n(before.cpa)} ${currency}。先查看各计划与转化目标的构成，判断流量变化或数据回补；这不构成自动改预算的依据。`,requiresReview:true});
    const spend = document.campaigns.filter(c=>c.totals.cost>0).sort((a,b)=>b.totals.cost-a.totals.cost);
    if (spend.length) summary.push(`花费最多的计划为“${spend[0].name}”，占所选范围花费的 ${n(spend[0].totals.cost/t.cost*100)}%。`);
    recommendations.push({id:'iteration-review',priority:'observe',title:'选择一个变量做下一轮测试',detail:'结合计划明细人工选择文案、关键词或落地页中的一个变量，创建新的待审核方案；建议不会直接修改广告。',requiresReview:true});
  }
  return {summary,recommendations};
}

export function createReporting({store,reader,clock=Date.now,sourceTeamId}) {
  const db = store.db, locks = new Set();
  ensure(sourceTeamId===undefined || (typeof sourceTeamId==='string' && /^[A-Za-z0-9-]{1,100}$/.test(sourceTeamId)),500,'INVALID_REPORT_CONFIG','日报数据来源的团队设置不正确。');
  const stamp = () => new Date(clock()).toISOString();
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_reporting_account (
      team_id TEXT NOT NULL REFERENCES app_team(id),account_id TEXT NOT NULL,name TEXT NOT NULL,currency TEXT NOT NULL,time_zone TEXT NOT NULL,
      daily_enabled INTEGER NOT NULL DEFAULT 1,local_time TEXT NOT NULL DEFAULT '10:00',created_by TEXT NOT NULL,created_at TEXT NOT NULL,
      last_attempt_at TEXT,last_success_at TEXT,last_report_date TEXT,last_error_json TEXT,next_retry_at TEXT,attempt_date TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(team_id,account_id)
    );
    CREATE TABLE IF NOT EXISTS app_reporting_report (
      id TEXT PRIMARY KEY,team_id TEXT NOT NULL,account_id TEXT NOT NULL,report_date TEXT NOT NULL,revision INTEGER NOT NULL,
      document_json TEXT NOT NULL,source_hash TEXT NOT NULL,fetched_at TEXT NOT NULL,UNIQUE(team_id,account_id,report_date)
    );
    CREATE INDEX IF NOT EXISTS app_reporting_report_team ON app_reporting_report(team_id,report_date DESC,fetched_at DESC);
    CREATE TABLE IF NOT EXISTS app_reporting_report_version (
      report_id TEXT NOT NULL REFERENCES app_reporting_report(id),revision INTEGER NOT NULL,document_json TEXT NOT NULL,fetched_at TEXT NOT NULL,
      PRIMARY KEY(report_id,revision)
    );
  `);
  const sourceOwner = () => sourceTeamId || db.prepare('SELECT id FROM app_team ORDER BY created_at,rowid LIMIT 1').get()?.id;
  const hasSource = member => member.team_id === sourceOwner();
  function requireSource(member) {ensure(hasSource(member),403,'REPORT_SOURCE_NOT_ASSIGNED','Google Ads 数据来源尚未分配给本团队。');}
  function currentActor(member,roles) {
    const current=db.prepare('SELECT team_id,role,status FROM app_member WHERE user_id=?').get(member.user_id);
    ensure(current && current.team_id===member.team_id && current.status==='active',403,'MEMBER_DISABLED','团队访问权限已发生变化，请重新登录。');
    ensure(roles.includes(current.role),403,'FORBIDDEN','当前角色没有执行此操作的权限。');
  }
  function sourceStatus(member) {
    if(!hasSource(member)) return {configured:false,readOnly:true,mode:'read_only',message:'Google Ads 数据来源尚未分配给本团队。'};
    const status=reader.status();
    // Even a valid installation must not publish the private credential allowlist.
    return {configured:Boolean(status.configured),readOnly:true,mode:'read_only',...(typeof status.apiVersion==='string' ? {apiVersion:status.apiVersion} : {}),...(status.error ? {error:{code:'REPORT_SOURCE_CONFIGURATION',message:'Google Ads 只读来源配置需要核对。'}} : {})};
  }
  const accountRow = (team,id) => db.prepare('SELECT * FROM app_reporting_account WHERE team_id=? AND account_id=?').get(team,id);
  function accountCapacity(team) {ensure(db.prepare('SELECT count(*) AS n FROM app_reporting_account WHERE team_id=?').get(team).n<20,400,'REPORT_ACCOUNT_LIMIT','本版每个团队最多接入 20 个 Google Ads 账户。');}
  function publicAccount(row) {
    return {id:row.account_id,name:row.name,currency:row.currency,timeZone:row.time_zone,dailyEnabled:Boolean(row.daily_enabled),localTime:row.local_time,createdAt:row.created_at,lastAttemptAt:row.last_attempt_at,lastSuccessAt:row.last_success_at,lastReportDate:row.last_report_date,lastError:row.last_error_json ? JSON.parse(row.last_error_json) : null,nextRetryAt:row.next_retry_at};
  }
  function audit(member, action, detail) {if(store.audit) store.audit(member.team_id,member.user_id,action,null,null,detail);}
  function knownAccount(member,id) {
    ensure(validAccount(id),400,'INVALID_REPORT_ACCOUNT','请输入 10 位 Google Ads 子账户编号。');
    const row=accountRow(member.team_id,id);ensure(row,404,'REPORT_ACCOUNT_NOT_FOUND','没有找到本团队已接入的广告账户。');return row;
  }
  function associations(team,accountId,campaignId) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_execution_object'").get() || !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_build'").get()) return [];
    const list=db.prepare("SELECT b.id,b.proposal_id,b.proposal_revision,b.snapshot_json FROM app_execution_object o JOIN app_build b ON b.id=o.build_id WHERE o.team_id=? AND o.platform='Google' AND o.account_id=? AND o.level='campaign' AND o.object_id=? AND b.team_id=?").all(team,accountId,campaignId,team);
    return list.map(r=>({buildId:r.id,proposalId:r.proposal_id,proposalRevision:r.proposal_revision,title:JSON.parse(r.snapshot_json).title || '冻结方案'}));
  }
  function filterDetail(document,campaignId) {
    if (!campaignId) return document;
    ensure(REMOTE.test(campaignId) && document.campaigns.some(c=>c.id===campaignId),404,'REPORT_CAMPAIGN_NOT_FOUND','此日报没有该广告计划。');
    const selected=document.campaigns.filter(c=>c.id===campaignId), series=document._input.daily.filter(r=>r.campaignId===campaignId), actions=document._input.conversionDaily.filter(r=>r.campaignId===campaignId);
    const filtered=buildDocument({...document._input,campaigns:selected.map(({totals,previousTotals,associations,...c})=>c),daily:series,conversionDaily:actions},document.reportDate,document.fetchedAt,document._teamId,document.id,document.revision,campaignId,document.source.queryWindow);
    for(const c of filtered.campaigns) c.associations=selected.find(original=>original.id===c.id).associations;
    return filtered;
  }
  function buildDocument(data,reportDate,fetchedAt,team,id,revision=1,campaignId=null,queryWindow={startDate:offset(reportDate,-14),endDate:reportDate}) {
    const previousDate=offset(reportDate,-1), daily=data.daily.filter(r=>r.date===reportDate), previous=data.daily.filter(r=>r.date===previousDate);
    const campaignTotals=data.campaigns.map(c=>({...c,totals:totals(daily.filter(r=>r.campaignId===c.id)),previousTotals:totals(previous.filter(r=>r.campaignId===c.id)),associations:associations(team,data.account.id,c.id)}));
    const actions=new Map();
    for(const r of data.conversionDaily.filter(r=>r.date===reportDate)) {
      const key=r.conversionActionId;
      const a=actions.get(key) || {id:key,name:r.conversionActionName,category:r.category,conversions:0,conversionValue:0};
      ensure(a.name===r.conversionActionName && a.category===r.category,422,'INVALID_REPORT_SOURCE','转化目标明细发生冲突，未保存日报。');a.conversions+=r.conversions;a.conversionValue+=r.conversionValue;actions.set(key,a);
    }
    const t=totals(daily), before=totals(previous), conversionActions=[...actions.values()], startDate=offset(reportDate,-7);
    const document={id,revision,accountId:data.account.id,account:data.account,currency:data.account.currency,timeZone:data.account.timeZone,reportDate,fetchedAt,observedThrough:reportDate,scope:{campaignId,name:campaignId ? data.campaigns.find(c=>c.id===campaignId).name : '整个 Google Ads 账户'},totals:t,comparison:{date:previousDate,totals:before,changes:changes(t,before)},campaigns:campaignTotals,conversionActions,trend:Array.from({length:8},(_,i)=>{const date=offset(startDate,i);return {date,...totals(data.daily.filter(r=>r.date===date))};}),source:{provider:'Google Ads',mode:'read_only',fetchedAt,observedThrough:reportDate,window:{startDate,endDate:reportDate},queryWindow,queriedThrough:queryWindow.endDate,zeroSemantics:'仅在全部只读查询成功并返回完整计划范围后，将无投放记录的日期显示为零；查询失败保留上次结果。',summaryMethod:'由已核对数据按规则生成，非 Codex 自由生成。'},limitations:['转化次数及转化价值为 Google Ads 平台归因指标，可能含小数，不等于网站注册人数或首订人数。','转化数据可能在报告日后继续回补；每次同步读取 15 天，并刷新已保存的前 7 日日报及其对比和趋势。','日报反映历史投放；计划状态是同步时的当前状态。','迭代建议仅供人工审核，不会修改预算、计划、广告或启用暂停对象。'],_teamId:team,_input:data,_daily:data.daily,_conversionDaily:data.conversionDaily};
    if(Math.abs(conversionActions.reduce((n,a)=>n+a.conversions,0)-t.conversions)>0.01) document.limitations.push('转化目标明细与账户汇总存在差异，本报分别保留，暂不据此比较目标效率。');
    return {...document,...summarize(document)};
  }
  function publicDetail(document) {const {_teamId,_input,_daily,_conversionDaily,...safe}=document;return safe;}
  function summary(row) {const d=JSON.parse(row.document_json);return {id:d.id,revision:d.revision,accountId:d.accountId,account:d.account,reportDate:d.reportDate,fetchedAt:d.fetchedAt,observedThrough:d.observedThrough,totals:d.totals,summary:d.summary,scope:d.scope};}
  function dateRange(timeZone, reportDate) {
    const today=localParts(clock(),timeZone).date, target=reportDate || offset(today,-1);
    ensure(isoDate(target) && target<today && target>=offset(today,-30),400,'INVALID_REPORT_DATE','请选择账户时区内已结束的日期，最多回看最近 30 天；今天的数据不计入完整日报。');
    return {reportDate:target,startDate:offset(target,-14),endDate:target};
  }
  function sanitized(error,hasReport=false) {
    const safeCodes = ['GOOGLE_ADS_NOT_CONFIGURED','GOOGLE_ADS_AUTH_FAILED','GOOGLE_ADS_ACCESS_DENIED','GOOGLE_ADS_RATE_LIMITED','GOOGLE_ADS_UNAVAILABLE','GOOGLE_ADS_INVALID_RESPONSE','INVALID_REPORT_SOURCE','REPORT_ACCOUNT_CHANGED'];
    const mapping={GOOGLE_NOT_CONFIGURED:'GOOGLE_ADS_NOT_CONFIGURED',GOOGLE_CONFIG_INVALID:'GOOGLE_ADS_NOT_CONFIGURED',GOOGLE_AUTH_REQUIRED:'GOOGLE_ADS_AUTH_FAILED',GOOGLE_ACCESS_DENIED:'GOOGLE_ADS_ACCESS_DENIED',GOOGLE_ACCOUNT_NOT_ALLOWED:'GOOGLE_ADS_ACCESS_DENIED',GOOGLE_RATE_LIMITED:'GOOGLE_ADS_RATE_LIMITED',GOOGLE_UNAVAILABLE:'GOOGLE_ADS_UNAVAILABLE',GOOGLE_INVALID_RESPONSE:'GOOGLE_ADS_INVALID_RESPONSE',GOOGLE_REDIRECT_BLOCKED:'GOOGLE_ADS_INVALID_RESPONSE',GOOGLE_RESPONSE_TOO_LARGE:'GOOGLE_ADS_INVALID_RESPONSE',GOOGLE_REPORT_TOO_LARGE:'GOOGLE_ADS_INVALID_RESPONSE',GOOGLE_INCOMPLETE_DAY:'INVALID_REPORT_SOURCE'};
    const code=mapping[error?.code] || (safeCodes.includes(error?.code) ? error.code : 'REPORT_SYNC_FAILED');
    const suffix=hasReport ? '上次成功日报仍保留。' : '本次尚未生成日报。';
    return {code,message:(code==='GOOGLE_ADS_NOT_CONFIGURED' ? '尚未配置 Google Ads 只读数据来源。' : code==='GOOGLE_ADS_AUTH_FAILED' ? 'Google Ads 授权已失效，请在 Google 完成重新登录授权后再更新日报。' : code==='GOOGLE_ADS_ACCESS_DENIED' ? 'Google Ads 读取权限需要核对。' : '这次未能取得完整 Google Ads 数据，请稍后重试。')+suffix};
  }
  async function sync(member,id,{reportDate,initial=false,automatic=false}={}) {
    const roles=initial ? ['admin'] : ['admin','editor'];
    currentActor(member,roles);
    requireSource(member);
    ensure(validAccount(id),400,'INVALID_REPORT_ACCOUNT','请输入 10 位 Google Ads 子账户编号。');
    const key=member.team_id+':'+id;ensure(!locks.has(key),409,'REPORT_SYNC_RUNNING','这个账户正在同步，请等待本次结果，勿重复点击。');locks.add(key);
    let row=accountRow(member.team_id,id), attemptDate,attemptAt,attemptCount;
    try {
      ensure(initial || row,404,'REPORT_ACCOUNT_NOT_FOUND','没有找到本团队已接入的广告账户。');
      if(!row) accountCapacity(member.team_id);
      const zone=row?.time_zone || 'UTC';
      // Before metadata is known, UTC yesterday can still be today's partial
      // date in a western account. UTC today minus two is complete globally.
      // Re-read the actual account-yesterday range after resolving its timezone.
      const probeDate=row ? reportDate : offset(localParts(clock(),'UTC').date,-2), range=dateRange(zone,probeDate);
      attemptDate=localParts(clock(),zone).date;
      attemptAt=stamp();attemptCount=row?.attempt_date===attemptDate ? row.attempt_count+1 : 1;
      currentActor(member,roles);
      let data=await reader.readAccount(id,{startDate:range.startDate,endDate:range.endDate});
      currentActor(member,roles);
      data=validateData(data,id,range.startDate,range.endDate);
      const actualRange=dateRange(data.account.timeZone,reportDate);
      if(actualRange.endDate!==range.endDate) {
        currentActor(member,roles);
        const reread=await reader.readAccount(id,{startDate:actualRange.startDate,endDate:actualRange.endDate});
        currentActor(member,roles);
        data=validateData(reread,id,actualRange.startDate,actualRange.endDate);
      }
      if(row) ensure(row.currency===data.account.currency && row.time_zone===data.account.timeZone,409,'REPORT_ACCOUNT_CHANGED','账户币种或时区发生变化，需要重新核对接入，未混合旧口径。');
      const fetchedAt=stamp(), existing=db.prepare('SELECT * FROM app_reporting_report WHERE team_id=? AND account_id=? AND report_date=?').get(member.team_id,id,actualRange.reportDate);
      const queryWindow={startDate:actualRange.startDate,endDate:actualRange.endDate};
      function prepared(day,previous) {
        const reportId=previous?.id || randomUUID(), document=buildDocument(data,day,fetchedAt,member.team_id,reportId,previous ? previous.revision+1 : 1,null,queryWindow);
        const from=offset(day,-7), scoped={...data,daily:data.daily.filter(r=>r.date>=from && r.date<=day),conversionDaily:data.conversionDaily.filter(r=>r.date>=from && r.date<=day),associations:document.campaigns.map(c=>({id:c.id,associations:c.associations}))};
        const sourceHash=createHash('sha256').update(JSON.stringify(scoped)).digest('hex'), same=previous?.source_hash===sourceHash;
        if(same) document.revision=previous.revision;
        return {reportId,document,sourceHash,same};
      }
      const latest=prepared(actualRange.reportDate,existing), refreshed=[latest,...db.prepare('SELECT * FROM app_reporting_report WHERE team_id=? AND account_id=? AND report_date>=? AND report_date<?').all(member.team_id,id,offset(actualRange.reportDate,-7),actualRange.reportDate).map(previous=>prepared(previous.report_date,previous))];
      store.transaction(()=>{
        currentActor(member,roles);
        requireSource(member);
        if(!row) {accountCapacity(member.team_id);db.prepare('INSERT INTO app_reporting_account(team_id,account_id,name,currency,time_zone,created_by,created_at,last_attempt_at,attempt_date,attempt_count) VALUES(?,?,?,?,?,?,?,?,?,?)').run(member.team_id,id,data.account.name,data.account.currency,data.account.timeZone,member.user_id,fetchedAt,fetchedAt,localParts(clock(),data.account.timeZone).date,1);}
        for(const {reportId,document,sourceHash,same} of refreshed) {
          db.prepare('INSERT INTO app_reporting_report VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(team_id,account_id,report_date) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,source_hash=excluded.source_hash,fetched_at=excluded.fetched_at').run(reportId,member.team_id,id,document.reportDate,document.revision,JSON.stringify(document),sourceHash,fetchedAt);
          if(!same) db.prepare('INSERT INTO app_reporting_report_version VALUES(?,?,?,?)').run(reportId,document.revision,JSON.stringify(document),fetchedAt);
        }
        db.prepare('UPDATE app_reporting_account SET name=?,last_success_at=?,last_report_date=?,last_attempt_at=?,attempt_date=?,attempt_count=?,last_error_json=NULL,next_retry_at=NULL WHERE team_id=? AND account_id=?').run(data.account.name,fetchedAt,actualRange.reportDate,attemptAt,localParts(clock(),data.account.timeZone).date,attemptCount,member.team_id,id);
        audit(member,initial ? 'reporting.account_connected' : 'reporting.synced',{accountId:id,reportId:latest.reportId,reportDate:actualRange.reportDate,refreshedReportCount:refreshed.length,automatic});
      });
      return {account:publicAccount(accountRow(member.team_id,id)),report:publicDetail(latest.document)};
    } catch(error) {
      // Permissions may change while the read is in flight. Do not commit even
      // attempt/error bookkeeping under an identity that has since been revoked.
      currentActor(member,roles);
      if(error instanceof AppError && ['MEMBER_DISABLED','FORBIDDEN','REPORT_SOURCE_NOT_ASSIGNED'].includes(error.code)) throw error;
      if(error instanceof AppError && ['INVALID_REPORT_DATE','REPORT_ACCOUNT_NOT_FOUND','REPORT_ACCOUNT_LIMIT'].includes(error.code)) throw error;
      if(row && attemptAt) {
        const failure=sanitized(error,Boolean(row.last_success_at)), minutes=attemptCount>=3 ? 24*60 : attemptCount>=2 ? 30 : 5;
        store.transaction(()=>{
          currentActor(member,roles);requireSource(member);
          db.prepare('UPDATE app_reporting_account SET last_attempt_at=?,attempt_date=?,attempt_count=?,last_error_json=?,next_retry_at=? WHERE team_id=? AND account_id=?').run(attemptAt,attemptDate,attemptCount,JSON.stringify(failure),new Date(clock()+minutes*60000).toISOString(),member.team_id,id);
        });
      }
      if(error instanceof AppError && error.code==='REPORT_ACCOUNT_CHANGED') throw error;
      const safe=sanitized(error,Boolean(row?.last_success_at));throw new AppError(502,safe.code,safe.message);
    } finally {locks.delete(key);}
  }
  async function handle(req,res,url,member,{body,json,requireEditor,requireAdmin}) {
    const path=url.pathname;
    if(path==='/api/reporting' && req.method==='GET') {json(res,200,{connection:sourceStatus(member),accounts:db.prepare('SELECT * FROM app_reporting_account WHERE team_id=? ORDER BY created_at DESC LIMIT 20').all(member.team_id).map(publicAccount),reports:db.prepare('SELECT * FROM (SELECT r.*,ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY report_date DESC,fetched_at DESC) AS account_rank FROM app_reporting_report r WHERE team_id=?) WHERE account_rank<=30 ORDER BY report_date DESC,fetched_at DESC LIMIT 600').all(member.team_id).map(summary),schedule:{mode:'server_online',description:'服务运行且到达账户时区设定时间后生成昨日完整日报；停机后启动会补查。'}});return true;}
    if(path==='/api/reporting/accounts' && req.method==='POST') {requireAdmin(member);const input=fields(await body(req),['accountId']);currentActor(member,['admin']);ensure(validAccount(input.accountId),400,'INVALID_REPORT_ACCOUNT','请输入 10 位 Google Ads 子账户编号。');ensure(!accountRow(member.team_id,input.accountId),409,'REPORT_ACCOUNT_EXISTS','这个团队已接入该账户，请使用同步。');json(res,201,await sync(member,input.accountId,{initial:true}));return true;}
    if(path==='/api/reporting/sync' && req.method==='POST') {requireEditor(member);const input=fields(await body(req),['accountId','reportDate']);currentActor(member,['admin','editor']);knownAccount(member,input.accountId);json(res,200,await sync(member,input.accountId,{reportDate:input.reportDate}));return true;}
    const account=path.match(/^\/api\/reporting\/accounts\/(\d{10})$/);
    if(account && req.method==='PATCH') {
      requireAdmin(member);const input=fields(await body(req),['dailyEnabled','localTime']);currentActor(member,['admin']);
      ensure(Object.keys(input).length && (input.dailyEnabled===undefined || typeof input.dailyEnabled==='boolean') && (input.localTime===undefined || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.localTime)),400,'INVALID_REPORT_SCHEDULE','请填写是否每日同步以及有效的小时和分钟。');
      store.transaction(()=>{currentActor(member,['admin']);const row=knownAccount(member,account[1]);db.prepare('UPDATE app_reporting_account SET daily_enabled=?,local_time=? WHERE team_id=? AND account_id=?').run(input.dailyEnabled===undefined ? row.daily_enabled : Number(input.dailyEnabled),input.localTime || row.local_time,member.team_id,account[1]);audit(member,'reporting.schedule_updated',{accountId:account[1],dailyEnabled:input.dailyEnabled,localTime:input.localTime});});
      json(res,200,{account:publicAccount(accountRow(member.team_id,account[1]))});return true;
    }
    const report=path.match(/^\/api\/reporting\/reports\/([a-zA-Z0-9-]+)$/);
    if(report && req.method==='GET') {const row=db.prepare('SELECT * FROM app_reporting_report WHERE team_id=? AND id=?').get(member.team_id,report[1]);ensure(row,404,'REPORT_NOT_FOUND','没有找到本团队的这份日报。');json(res,200,publicDetail(filterDetail(JSON.parse(row.document_json),url.searchParams.get('campaignId'))));return true;}
    return false;
  }
  async function tick() {
    const results=[];
    for(const row of db.prepare('SELECT * FROM app_reporting_account WHERE daily_enabled=1').all()) {
      if(row.team_id!==sourceOwner()) continue;
      const local=localParts(clock(),row.time_zone), yesterday=offset(local.date,-1);
      if(local.time<row.local_time || (row.last_report_date===yesterday && row.last_success_at && localParts(Date.parse(row.last_success_at),row.time_zone).date===local.date) || (row.next_retry_at && Date.parse(row.next_retry_at)>clock()) || (row.attempt_date===local.date && row.attempt_count>=3) || locks.has(row.team_id+':'+row.account_id)) continue;
      // A disabled/removed member's credential must not keep scheduling reads.
      const active=db.prepare("SELECT user_id FROM app_member WHERE team_id=? AND user_id=? AND status='active' AND role IN ('admin','editor')").get(row.team_id,row.created_by);
      if(!active) continue;
      try {const result=await sync({team_id:row.team_id,user_id:row.created_by},row.account_id,{automatic:true});results.push({accountId:row.account_id,status:'succeeded',reportId:result.report.id});} catch(error) {results.push({accountId:row.account_id,status:'failed',code:error.code || 'REPORT_SYNC_FAILED'});}
    }
    return results;
  }
  return {handle,tick,close(){},sync};
}
