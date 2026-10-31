// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createReporting} from '../server/reporting.mjs';
import {AppError} from '../server/errors.mjs';

const ACCOUNT='1234567890', DATE='2026-10-26';
const admin={team_id:'team1',user_id:'admin1',role:'admin'},editor={team_id:'team1',user_id:'editor1',role:'editor'},viewer={team_id:'team1',user_id:'viewer1',role:'viewer'},outside={team_id:'team2',user_id:'admin2',role:'admin'};
const shift=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
function sample(accountId,{endDate}) {
  return {account:{id:accountId,name:'Synthetic Google Account',currency:'CNY',timeZone:'Asia/Shanghai'},campaigns:[{id:'111',name:'Synthetic text plan',status:'ENABLED',channelType:'SEARCH',startDate:'2026-01-01'},{id:'222',name:'Synthetic image plan',status:'ENABLED',channelType:'SEARCH',startDate:'2026-01-01'},{id:'333',name:'Synthetic paused acceptance',status:'PAUSED',channelType:'SEARCH',startDate:shift(endDate,2)}],daily:[{date:endDate,campaignId:'111',impressions:100,clicks:10,costMicros:'10000001',conversions:1.5,conversionValue:30.5},{date:endDate,campaignId:'222',impressions:300,clicks:10,costMicros:'20000002',conversions:0.5,conversionValue:10.5},{date:shift(endDate,-1),campaignId:'111',impressions:50,clicks:5,costMicros:'5000000',conversions:1,conversionValue:20},{date:shift(endDate,-1),campaignId:'222',impressions:150,clicks:5,costMicros:'10000000',conversions:0.5,conversionValue:10}],conversionDaily:[{date:endDate,campaignId:'111',conversionActionId:'5001',conversionActionName:'Synthetic signup',category:'SIGNUP',conversions:1.5,conversionValue:30.5},{date:endDate,campaignId:'222',conversionActionId:'5002',conversionActionName:'Synthetic purchase',category:'PURCHASE',conversions:0.5,conversionValue:10.5}]};
}
function fixture(t,{sourceTeamId}={}) {
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE user(id TEXT PRIMARY KEY);CREATE TABLE app_team(id TEXT PRIMARY KEY,created_at TEXT);CREATE TABLE app_member(user_id TEXT PRIMARY KEY,team_id TEXT,role TEXT,status TEXT);INSERT INTO app_team VALUES('team1','2026-01-01'),('team2','2026-01-02');INSERT INTO user VALUES('admin1'),('editor1'),('viewer1'),('admin2');INSERT INTO app_member VALUES('admin1','team1','admin','active'),('editor1','team1','editor','active'),('viewer1','team1','viewer','active'),('admin2','team2','admin','active');`);
  const audits=[],calls=[];let now=Date.parse('2026-10-27T06:00:00Z'),data=sample,failure=null,pending=null,bodyPending=null;
  const store={db,transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}},audit(...a){audits.push(a);}};
  const reader={status(){return {configured:true,mode:'read_only',accountIds:[ACCOUNT,'1111111111']};},async readAccount(accountId,range){calls.push({accountId,...range});if(pending) await pending;if(failure) throw failure;return data(accountId,range);}};
  const reporting=createReporting({store,reader,clock:()=>now,sourceTeamId});
  t.after(()=>db.close());
  async function request(path,method='GET',input,member=admin) {
    let response;
    const helpers={body:async()=>{if(bodyPending) await bodyPending;return input;},json(_res,status,body){response={status,body};},requireEditor(m){if(!['admin','editor'].includes(m.role)) throw new AppError(403,'FORBIDDEN','read only');},requireAdmin(m){if(m.role!=='admin') throw new AppError(403,'FORBIDDEN','admin only');}};
    try{const handled=await reporting.handle({method},{},new URL(path,'http://127.0.0.1'),member,helpers);return response || {handled};}catch(error){return {status:error.status,body:{error:{code:error.code,message:error.message}}};}
  }
  return {db,calls,audits,reporting,request,setNow(v){now=Date.parse(v);},setData(v){data=v;},setFailure(v){failure=v;},block(v){pending=v;},blockBody(v){bodyPending=v;}};
}
async function connect(f) {const r=await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT});assert.equal(r.status,201,JSON.stringify(r));return r.body;}

test('provider row ordering alone cannot revise a saved report or mutate the input batch',async t=>{
  const f=fixture(t),first=(await connect(f)).report;
  let batch,before;
  f.setData((id,range)=>{
    batch=sample(id,range);batch.campaigns.reverse();batch.daily.reverse();batch.conversionDaily.reverse();
    before=JSON.stringify(batch);return batch;
  });
  const repeat=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});
  assert.equal(repeat.status,200);assert.equal(repeat.body.report.id,first.id);assert.equal(repeat.body.report.revision,first.revision);
  assert.deepEqual(repeat.body.report.totals,first.totals);assert.deepEqual(repeat.body.report.trend,first.trend);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report_version').get().n,1);
  assert.equal(JSON.stringify(batch),before,'normalization must not reorder the reader-owned input');
});
test('attributed results without traffic trigger attribution review rather than a missing-delivery diagnosis',async t=>{
  for(const [conversions,conversionValue] of [[1.5,10],[-0.5,-5],[0,10]]) {
    const f=fixture(t);f.setData((id,range)=>({
      account:{id,name:'Synthetic attributed account',currency:'CNY',timeZone:'Asia/Shanghai'},
      campaigns:[{id:'111',name:'Synthetic paused campaign',status:'PAUSED',channelType:'SEARCH'}],
      daily:[{date:range.endDate,campaignId:'111',impressions:0,clicks:0,costMicros:'0',conversions,conversionValue}],
      conversionDaily:[{date:range.endDate,campaignId:'111',conversionActionId:'5001',conversionActionName:'Synthetic signup',category:'SIGNUP',conversions,conversionValue}],
    }));
    const {report}=await connect(f);
    assert.equal(report.totals.conversions,conversions);assert.equal(report.totals.conversionValue,conversionValue);
    assert.ok(report.summary.some(v=>v.includes('未记录展示、点击或费用')&&v.includes('不能直接解释为当日新增注册或首订')));
    assert.ok(report.recommendations.some(v=>v.id==='attribution-review'&&v.detail.includes('原因尚未验证')));
    assert.ok(!report.recommendations.some(v=>v.id==='no-delivery'));
    assert.ok(report.recommendations.every(v=>v.requiresReview));
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='app_build'").get(),undefined);
  }
});
test('real-data snapshot uses exact micros, weighted rates, fractional platform conversions, and complete-day provenance',async t=>{
  const f=fixture(t),{account,report}=await connect(f);
  assert.deepEqual(f.calls,[{accountId:ACCOUNT,startDate:'2026-10-11',endDate:'2026-10-25'},{accountId:ACCOUNT,startDate:'2026-10-12',endDate:DATE}]);
  assert.equal(account.dailyEnabled,true);assert.equal(account.localTime,'10:00');assert.equal(account.lastReportDate,DATE);
  assert.equal(report.totals.costMicros,'30000003');assert.equal(report.totals.cost,30.000003);
  assert.equal(report.totals.impressions,400);assert.equal(report.totals.clicks,20);assert.equal(report.totals.ctr,0.05);
  assert.equal(report.totals.conversions,2);assert.equal(report.campaigns[0].totals.conversions,1.5);
  assert.equal(report.totals.cpc,30.000003/20);assert.equal(report.totals.cpa,30.000003/2);
  assert.equal(report.comparison.date,'2026-10-25');assert.equal(report.comparison.totals.cost,15);assert.equal(report.comparison.changes.impressions.relative,1);
  assert.equal(report.trend.length,8);assert.equal(report.source.observedThrough,DATE);assert.equal(report.source.mode,'read_only');
  assert.equal(report.conversionActions.length,2);assert.equal(report.conversionActions[0].category,'SIGNUP');assert.equal(report.conversionActions[1].category,'PURCHASE');
  assert.ok(report.limitations.some(v=>v.includes('不等于网站注册人数或首订人数')));assert.ok(report.source.summaryMethod.includes('非 Codex'));
  assert.ok(!Object.keys(report).some(k=>k.startsWith('_')));assert.ok(f.audits.length);
});
test('campaign filter recomputes totals, trend, action scope and prior-day comparisons without leaking other campaigns',async t=>{
  const f=fixture(t),{report}=await connect(f),filtered=await f.request(`/api/reporting/reports/${report.id}?campaignId=111`);
  assert.equal(filtered.status,200);assert.equal(filtered.body.campaigns.length,1);assert.equal(filtered.body.totals.costMicros,'10000001');assert.equal(filtered.body.totals.conversions,1.5);
  assert.equal(filtered.body.comparison.totals.cost,5);assert.equal(filtered.body.trend.at(-1).clicks,10);assert.equal(filtered.body.conversionActions.length,1);
  assert.equal(filtered.body.scope.campaignId,'111');assert.ok(!JSON.stringify(filtered.body).includes('Synthetic image plan'));
  assert.equal((await f.request(`/api/reporting/reports/${report.id}?campaignId=999`)).status,404);
});
test('all reports and accounts are team scoped; viewer can read but only editor/admin can sync or schedule',async t=>{
  const f=fixture(t),{report}=await connect(f);
  assert.equal((await f.request('/api/reporting', 'GET',undefined,viewer)).body.accounts.length,1);
  assert.equal((await f.request('/api/reporting','GET',undefined,outside)).body.accounts.length,0);
  assert.equal((await f.request('/api/reporting','GET',undefined,outside)).body.connection.configured,false);
  assert.ok(!JSON.stringify((await f.request('/api/reporting')).body.connection).includes(ACCOUNT));
  const calls=f.calls.length;
  assert.equal((await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT},outside)).status,403);
  assert.equal(f.calls.length,calls,'unassigned team cannot use shared private source');
  assert.equal((await f.request(`/api/reporting/reports/${report.id}`,'GET',undefined,outside)).status,404);
  assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT},outside)).status,404);
  assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT},viewer)).status,403);
  assert.equal((await f.request('/api/reporting/accounts','POST',{accountId:'1111111111'},editor)).status,403);
  assert.equal((await f.request(`/api/reporting/accounts/${ACCOUNT}`,'PATCH',{dailyEnabled:false},editor)).status,403);
  assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT},editor)).status,200);
});
test('source failure and malformed partial results preserve last good report; errors never reflect tokens',async t=>{
  const f=fixture(t),{report}=await connect(f),stored=f.db.prepare('SELECT document_json FROM app_reporting_report').get().document_json;
  f.setFailure(Object.assign(new Error('Authorization Bearer SECRETDO-NOT-EXPOSE'),{code:'GOOGLE_ADS_AUTH_FAILED'}));
  const bad=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});assert.equal(bad.status,502);assert.equal(bad.body.error.code,'GOOGLE_ADS_AUTH_FAILED');assert.ok(!JSON.stringify(bad).includes('SECRET'));
  assert.equal(f.db.prepare('SELECT document_json FROM app_reporting_report').get().document_json,stored);
  const base=(await f.request('/api/reporting')).body;assert.equal(base.accounts[0].lastError.code,'GOOGLE_ADS_AUTH_FAILED');assert.equal(base.reports[0].id,report.id);
  f.setFailure(null);f.setData((id,r)=>({...sample(id,r),conversionDaily:undefined}));
  assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT})).status,502);assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report').get().n,1);
});
test('date validation rejects incomplete or excessive history before reading and does not disturb schedule',async t=>{
  const f=fixture(t);await connect(f);const before=f.calls.length;
  for(const reportDate of ['2026-10-27','2026-10-28','2026-09-20','2026-02-30','yesterday']) assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT,reportDate})).status,400);
  assert.equal(f.calls.length,before);assert.equal((await f.request('/api/reporting')).body.accounts[0].lastError,null);
  assert.equal((await f.request('/api/reporting/accounts','POST',{})).status,400);
  assert.equal((await f.request(`/api/reporting/accounts/${ACCOUNT}`,'PATCH',{localTime:'25:00'})).status,400);
});
test('zero records are genuine measured zero after complete reads; paused acceptance gets no performance or auto-enable recommendation',async t=>{
  const f=fixture(t);f.setData((id,r)=>({...sample(id,r),campaigns:[{id:'333',name:'Synthetic paused acceptance',status:'PAUSED',channelType:'SEARCH',startDate:shift(r.endDate,2)}],daily:[],conversionDaily:[]}));
  const {report}=await connect(f);assert.equal(report.totals.cost,0);assert.equal(report.totals.conversions,0);assert.equal(report.totals.ctr,null);assert.equal(report.totals.cpc,null);assert.equal(report.totals.cpa,null);
  assert.ok(report.summary.some(v=>v.includes('不能据此判断素材效果')));assert.ok(report.recommendations[0].detail.includes('保留暂停状态'));assert.ok(report.recommendations.every(v=>v.requiresReview));
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='app_build'").get(),undefined);
});
test('same-day sync is idempotent, backfill changes create a revision, snapshots use frozen build identity and filter preserves it',async t=>{
  const f=fixture(t);
  f.db.exec(`CREATE TABLE app_build(id TEXT,team_id TEXT,proposal_id TEXT,proposal_revision INTEGER,snapshot_json TEXT);CREATE TABLE app_execution_object(build_id TEXT,team_id TEXT,platform TEXT,account_id TEXT,level TEXT,object_id TEXT);`);
  f.db.prepare('INSERT INTO app_build VALUES(?,?,?,?,?)').run('build1','team1','proposal1',7,JSON.stringify({title:'Frozen reviewed name'}));
  f.db.prepare('INSERT INTO app_execution_object VALUES(?,?,?,?,?,?)').run('build1','team1','Google',ACCOUNT,'campaign','111');
  const {report}=await connect(f),repeat=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});assert.equal(repeat.body.report.id,report.id);assert.equal(repeat.body.report.revision,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report_version').get().n,1);
  f.db.prepare('UPDATE app_build SET snapshot_json=?').run(JSON.stringify({title:'Changed current record'}));
  const filtered=(await f.request(`/api/reporting/reports/${report.id}?campaignId=111`)).body;assert.equal(filtered.campaigns[0].associations[0].title,'Frozen reviewed name');assert.equal(filtered.campaigns[0].associations[0].proposalRevision,7);
  f.setData((id,r)=>{const data=sample(id,r);data.daily[0].conversions=2;data.conversionDaily[0].conversions=2;return data;});
  const revised=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});assert.equal(revised.body.report.id,report.id);assert.equal(revised.body.report.revision,2);assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report_version').get().n,2);
});
test('scheduler catches missed days once, honors account-local time and disabled schedules, and persists bounded retry backoff',async t=>{
  const f=fixture(t);await connect(f);assert.deepEqual(await f.reporting.tick(),[]);
  f.setNow('2026-10-28T01:00:00Z');assert.deepEqual(await f.reporting.tick(),[]);
  f.setNow('2026-10-28T02:01:00Z');let result=await f.reporting.tick();assert.equal(result[0].status,'succeeded');assert.equal((await f.request('/api/reporting')).body.accounts[0].lastReportDate,'2026-10-27');assert.deepEqual(await f.reporting.tick(),[]);
  await f.request(`/api/reporting/accounts/${ACCOUNT}`,'PATCH',{dailyEnabled:false});f.setNow('2026-10-29T02:01:00Z');assert.deepEqual(await f.reporting.tick(),[]);
  await f.request(`/api/reporting/accounts/${ACCOUNT}`,'PATCH',{dailyEnabled:true});f.setFailure(new Error('synthetic temporary failure'));result=await f.reporting.tick();assert.equal(result[0].status,'failed');const failedCalls=f.calls.length;assert.deepEqual(await f.reporting.tick(),[]);assert.equal(f.calls.length,failedCalls);
  f.setNow('2026-10-29T02:07:00Z');await f.reporting.tick();f.setNow('2026-10-29T02:38:00Z');await f.reporting.tick();f.setNow('2026-10-29T23:00:00Z');assert.deepEqual(await f.reporting.tick(),[]);
  f.setNow('2026-10-30T02:01:00Z');f.setFailure(null);f.db.prepare("UPDATE app_member SET status='disabled' WHERE user_id='admin1'").run();assert.deepEqual(await f.reporting.tick(),[]);
});
test('concurrent syncs cannot overlap or overwrite one another',async t=>{
  const f=fixture(t);await connect(f);let release;f.block(new Promise(resolve=>release=resolve));const first=f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});
  const second=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});assert.equal(second.status,409);assert.equal(second.body.error.code,'REPORT_SYNC_RUNNING');release();assert.equal((await first).status,200);
});
test('duplicate source rows and over-precision totals fail instead of double counting',async t=>{
  const f=fixture(t);f.setData((id,r)=>{const v=sample(id,r);v.daily.push({...v.daily[0]});return v;});assert.equal((await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT})).status,502);
  f.setData((id,r)=>{const v=sample(id,r);v.daily[0].costMicros='999999999999999999999';return v;});assert.equal((await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT})).status,502);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report').get().n,0);
});
test('fifteen-day query refreshes saved prior seven reports atomically with conversion backfill and preserves their IDs',async t=>{
  const f=fixture(t);
  const history={campaigns:[{id:'111',name:'Synthetic stable campaign',status:'PAUSED',channelType:'SEARCH',startDate:'2026-01-01'}],daily:[{date:DATE,campaignId:'111',impressions:200,clicks:20,costMicros:'20000000',conversions:1,conversionValue:20},{date:'2026-10-25',campaignId:'111',impressions:100,clicks:10,costMicros:'10000000',conversions:1.25,conversionValue:12.5}],conversionDaily:[{date:DATE,campaignId:'111',conversionActionId:'5001',conversionActionName:'Synthetic signup',category:'SIGNUP',conversions:1,conversionValue:20},{date:'2026-10-25',campaignId:'111',conversionActionId:'5001',conversionActionName:'Synthetic signup',category:'SIGNUP',conversions:1.25,conversionValue:12.5}]};
  f.setData((id,range)=>({account:{id,name:'Synthetic stable account',currency:'CNY',timeZone:'Asia/Shanghai'},campaigns:history.campaigns,daily:history.daily.filter(r=>r.date>=range.startDate && r.date<=range.endDate),conversionDaily:history.conversionDaily.filter(r=>r.date>=range.startDate && r.date<=range.endDate)}));
  const latest=(await connect(f)).report, older=(await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT,reportDate:'2026-10-25'})).body.report;
  assert.equal(older.totals.conversions,1.25);
  history.daily[1].conversions=2.5;history.conversionDaily[1].conversions=2.5;
  f.setNow('2026-10-27T07:00:00Z');const refreshed=(await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT})).body.report;
  const oldNow=(await f.request(`/api/reporting/reports/${older.id}`)).body;
  assert.equal(refreshed.id,latest.id);assert.equal(oldNow.id,older.id);assert.equal(oldNow.revision,2);assert.equal(oldNow.totals.conversions,2.5);assert.equal(oldNow.trend.at(-1).conversions,2.5);assert.equal(oldNow.source.observedThrough,'2026-10-25');assert.equal(oldNow.source.queriedThrough,DATE);assert.equal(oldNow.source.queryWindow.startDate,'2026-10-12');assert.equal(oldNow.source.window.startDate,'2026-10-18');
  assert.equal(refreshed.comparison.totals.conversions,2.5);
  const saved=f.db.prepare('SELECT id,document_json FROM app_reporting_report ORDER BY id').all();
  const versionCount=f.db.prepare('SELECT count(*) AS n FROM app_reporting_report_version').get().n;
  f.db.exec("CREATE TRIGGER synthetic_atomic_failure BEFORE UPDATE ON app_reporting_report WHEN OLD.report_date='2026-10-25' BEGIN SELECT RAISE(ABORT,'synthetic old-report save failure'); END;");
  history.daily[0].conversions=5;history.conversionDaily[0].conversions=5;
  assert.equal((await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT})).status,502);
  assert.deepEqual(f.db.prepare('SELECT id,document_json FROM app_reporting_report ORDER BY id').all(),saved,'all current and historical snapshots survive atomic failure unchanged');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report_version').get().n,versionCount);
});
test('explicit source team overrides first team and prevents unauthorized reads, scheduling and credential discovery',async t=>{
  const f=fixture(t,{sourceTeamId:'team2'});
  const a=await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT});assert.equal(a.status,403);assert.equal(f.calls.length,0);
  const allowed=await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT},outside);assert.equal(allowed.status,201);
  const first=(await f.request('/api/reporting')).body;assert.equal(first.connection.configured,false);assert.ok(!JSON.stringify(first).includes(ACCOUNT));
  const allowedStatus=(await f.request('/api/reporting','GET',undefined,outside)).body.connection;assert.equal(allowedStatus.configured,true);assert.equal(allowedStatus.accountIds,undefined);
  f.db.prepare('INSERT INTO app_reporting_account(team_id,account_id,name,currency,time_zone,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run('team1','1111111111','Synthetic legacy unauthorized','CNY','Asia/Shanghai','admin1','2026-01-01');
  f.setNow('2026-10-28T06:00:00Z');const count=f.calls.length;const result=await f.reporting.tick();assert.equal(result.length,1);assert.equal(result[0].accountId,ACCOUNT);assert.equal(f.calls.length,count+1,'legacy unassigned-team schedules cannot use installation credential');
});
test('initial connection probes a globally complete date before resolving a western account timezone',async t=>{
  const f=fixture(t);f.setNow('2026-10-27T00:30:00Z');
  f.setData((id,range)=>{
    if(range.endDate>='2026-10-26') throw Object.assign(new Error('synthetic incomplete Los Angeles day'),{code:'GOOGLE_INCOMPLETE_DAY'});
    const data=sample(id,range);data.account.timeZone='America/Los_Angeles';return data;
  });
  const {account,report}=await connect(f);
  assert.equal(account.timeZone,'America/Los_Angeles');assert.equal(report.reportDate,'2026-10-25');
  assert.deepEqual(f.calls,[{accountId:ACCOUNT,startDate:'2026-10-11',endDate:'2026-10-25'}]);
});
test('revocation during a delayed read rejects result and all local bookkeeping without replacing last successful data',async t=>{
  for(const update of ["status='disabled'","role='viewer'"]) {
    const f=fixture(t);await connect(f);
    const before=f.db.prepare('SELECT * FROM app_reporting_account').get(),snapshot=f.db.prepare('SELECT document_json FROM app_reporting_report').get().document_json,auditCount=f.audits.length;
    let release;f.block(new Promise(resolve=>release=resolve));f.setNow('2026-10-27T07:00:00Z');
    const pending=f.request('/api/reporting/sync','POST',{accountId:ACCOUNT},editor);
    await Promise.resolve();await Promise.resolve();
    f.db.exec(`UPDATE app_member SET ${update} WHERE user_id='editor1'`);
    release();const result=await pending;assert.equal(result.status,403);assert.ok(['MEMBER_DISABLED','FORBIDDEN'].includes(result.body.error.code));
    assert.deepEqual(f.db.prepare('SELECT * FROM app_reporting_account').get(),before,'revoked in-flight read cannot save lastAttempt, lastError, or success metadata');
    assert.equal(f.db.prepare('SELECT document_json FROM app_reporting_report').get().document_json,snapshot);assert.equal(f.audits.length,auditCount);
  }
});
test('admin revoked during first metadata probe cannot trigger the second read or bind an account',async t=>{
  const f=fixture(t);let release;f.block(new Promise(resolve=>release=resolve));
  const pending=f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT});await Promise.resolve();await Promise.resolve();
  assert.equal(f.calls.length,1);f.db.exec("UPDATE app_member SET role='editor' WHERE user_id='admin1'");release();
  const result=await pending;assert.equal(result.status,403);assert.equal(f.calls.length,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_account').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM app_reporting_report').get().n,0);assert.equal(f.audits.length,0);
});
test('slow request bodies recheck current role before reading a source or saving schedule changes',async t=>{
  const f=fixture(t);let release;f.blockBody(new Promise(resolve=>release=resolve));
  const pending=f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT});
  f.db.exec("UPDATE app_member SET role='editor' WHERE user_id='admin1'");release();assert.equal((await pending).status,403);assert.equal(f.calls.length,0);
  f.db.exec("UPDATE app_member SET role='admin' WHERE user_id='admin1'");f.blockBody(null);await connect(f);
  const before=f.db.prepare('SELECT * FROM app_reporting_account').get();
  let finish;f.blockBody(new Promise(resolve=>finish=resolve));const schedule=f.request(`/api/reporting/accounts/${ACCOUNT}`,'PATCH',{dailyEnabled:false});
  f.db.exec("UPDATE app_member SET role='editor' WHERE user_id='admin1'");finish();assert.equal((await schedule).status,403);assert.deepEqual(f.db.prepare('SELECT * FROM app_reporting_account').get(),before);
});
test('expired authorization gives actionable sanitized feedback and never claims a nonexistent successful report',async t=>{
  const f=fixture(t);f.setFailure(Object.assign(new Error('synthetic invalid_grant SECRET'),{code:'GOOGLE_AUTH_REQUIRED'}));
  const initial=await f.request('/api/reporting/accounts','POST',{accountId:ACCOUNT});assert.equal(initial.status,502);assert.equal(initial.body.error.code,'GOOGLE_ADS_AUTH_FAILED');assert.ok(initial.body.error.message.includes('授权已失效'));assert.ok(initial.body.error.message.includes('本次尚未生成日报'));assert.ok(!initial.body.error.message.includes('上次成功日报'));assert.ok(!JSON.stringify(initial).includes('SECRET'));
  f.setFailure(null);await connect(f);f.setFailure(Object.assign(new Error('synthetic invalid_grant'),{code:'GOOGLE_AUTH_REQUIRED'}));
  const again=await f.request('/api/reporting/sync','POST',{accountId:ACCOUNT});assert.equal(again.status,502);assert.ok(again.body.error.message.includes('上次成功日报仍保留'));
});
test('report list retains up to thirty dates for each account instead of cutting off valid history at thirty team-wide rows',async t=>{
  const f=fixture(t),first=await connect(f),second=await f.request('/api/reporting/accounts','POST',{accountId:'1111111111'});assert.equal(second.status,201);
  for(const base of [first.report,second.body.report]) for(let i=1;i<16;i++) {
    const document={...base,id:`history-${base.accountId}-${i}`,reportDate:shift(DATE,-i)};
    f.db.prepare('INSERT INTO app_reporting_report VALUES(?,?,?,?,?,?,?,?)').run(document.id,'team1',base.accountId,document.reportDate,1,JSON.stringify(document),'synthetic-hash',base.fetchedAt);
  }
  const result=(await f.request('/api/reporting')).body;
  assert.equal(result.reports.length,32);for(const id of [ACCOUNT,'1111111111']) {
    assert.equal(result.reports.filter(r=>r.accountId===id).length,16);
    assert.ok(result.reports.some(r=>r.accountId===id && r.reportDate==='2026-10-11'));
  }
  const old=(await f.request('/api/reporting/reports/history-1111111111-15')).body;assert.equal(old.reportDate,'2026-10-11');assert.equal(old.accountId,'1111111111');
});
test('account binding stays bounded before reading a new source and therefore limits summary payloads to six hundred',async t=>{
  const f=fixture(t);await connect(f);
  for(let i=0;i<19;i++) f.db.prepare('INSERT INTO app_reporting_account(team_id,account_id,name,currency,time_zone,created_by,created_at) VALUES(?,?,?,?,?,?,?)').run('team1',String(i).padStart(10,'0'),'Synthetic bounded account','CNY','Asia/Shanghai','admin1','2026-01-01');
  const calls=f.calls.length,result=await f.request('/api/reporting/accounts','POST',{accountId:'9999999999'});
  assert.equal(result.status,400);assert.equal(result.body.error.code,'REPORT_ACCOUNT_LIMIT');assert.equal(f.calls.length,calls);
});
