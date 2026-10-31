// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, ok, error} from './phase34-fixture.mjs';
import {AppError} from '../server/errors.mjs';

const ACCOUNT = '1234567890';
const NOW = Date.parse('2030-02-10T06:00:00Z');
function reader() {
  let fail = false, calls = 0;
  return {
    status: () => ({configured:true,readOnly:true,accountIds:[ACCOUNT],apiVersion:'v25'}),
    get calls() {return calls;},
    set fail(value) {fail=value;},
    async readAccount(id,{startDate,endDate}) {
      calls++;
      if(fail) throw new AppError(409,'GOOGLE_AUTH_REQUIRED','PRIVATE_AUTH_RESPONSE_MUST_NOT_LEAK');
      assert.equal(id,ACCOUNT);
      const daily = [
        {date:'2030-02-09',campaignId:'111',impressions:1000,clicks:40,costMicros:'25000000',conversions:2.5,conversionValue:80},
        {date:'2030-02-08',campaignId:'111',impressions:500,clicks:20,costMicros:'10000000',conversions:2,conversionValue:50},
      ].filter(r=>r.date>=startDate&&r.date<=endDate);
      return {
        account:{id,name:'Synthetic reporting account',currency:'CNY',timeZone:'Asia/Shanghai'},
        campaigns:[{id:'111',name:'Synthetic running campaign',status:'ENABLED',channelType:'SEARCH',startDate:'2030-01-01'},{id:'222',name:'Synthetic paused acceptance',status:'PAUSED',channelType:'SEARCH',startDate:'2030-02-11'}],
        daily,
        conversionDaily:daily.map(r=>({date:r.date,campaignId:r.campaignId,conversionActionId:'333',conversionActionName:'Synthetic signup',category:'SIGNUP',conversions:r.conversions,conversionValue:r.conversionValue})),
      };
    },
  };
}

test('reporting HTTP verifies team roles, persisted real-shaped data, scoped metrics and no advertising side effects', {timeout:90000}, async t=>{
  const source=reader();
  const f=await fixture(t,{reportingReader:source,reportingClock:()=>NOW,reportingScheduler:false});
  error(await f.request('/api/reporting'),401);
  assert.equal(source.calls,0);
  const viewer=await f.invitedMember(f.admin,'report-viewer@example.com','viewer');
  const outsider=await f.outsider();
  error(await f.request('/api/reporting/accounts',{method:'POST',actor:viewer,body:{accountId:ACCOUNT}}),403);
  error(await f.request('/api/reporting/accounts',{method:'POST',actor:outsider,body:{accountId:ACCOUNT}}),403);
  assert.equal(source.calls,0,'unauthorized teams must not read the deployment credential');
  const hidden=ok(await f.request('/api/reporting',{actor:outsider}));
  assert.ok(!JSON.stringify(hidden).includes(ACCOUNT),'unbound account allowlist is not shared across teams');
  const before=f.app.db.prepare('SELECT id,status,targets_json FROM app_build').all();
  const connected=ok(await f.request('/api/reporting/accounts',{method:'POST',actor:f.admin,body:{accountId:ACCOUNT}}),201);
  assert.equal(connected.account.id,ACCOUNT);
  assert.equal(connected.report.reportDate,'2030-02-09');
  assert.equal(connected.report.totals.cost,25);
  assert.equal(connected.report.totals.conversions,2.5,'platform attribution stays fractional');
  assert.equal(connected.report.totals.cpa,10);
  assert.equal(connected.report.totals.ctr,0.04);
  assert.equal(connected.report.comparison.totals.cost,10);
  const id=connected.report.id;
  error(await f.request(`/api/reporting/reports/${id}`,{actor:outsider}),404);
  const scoped=ok(await f.request(`/api/reporting/reports/${id}?campaignId=222`,{actor:viewer}));
  assert.equal(scoped.totals.cost,0);
  assert.equal(scoped.totals.ctr,null);
  assert.ok(scoped.summary.some(s=>s.includes('不能据此判断素材效果')));
  assert.ok(scoped.recommendations.some(r=>r.detail.includes('保留暂停状态')));
  assert.equal(scoped.conversionActions.length,0);
  error(await f.request('/api/reporting/sync',{method:'POST',actor:viewer,body:{accountId:ACCOUNT}}),403);
  error(await f.request('/api/reporting/sync',{method:'POST',actor:f.admin,origin:'https://example.com',body:{accountId:ACCOUNT}}),403);
  error(await f.request('/api/reporting/sync',{method:'POST',actor:f.admin,body:{accountId:ACCOUNT,reportDate:'2030-02-10'}}),400);
  const synced=ok(await f.request('/api/reporting/sync',{method:'POST',actor:f.admin,body:{accountId:ACCOUNT}}));
  assert.equal(synced.report.id,id);
  assert.equal(synced.report.revision,connected.report.revision,'identical source does not create another report version');
  await f.restart();
  const calls=source.calls;
  const restored=ok(await f.request(`/api/reporting/reports/${id}`,{actor:viewer}));
  assert.equal(restored.totals.cost,25);
  assert.equal(source.calls,calls,'read-back is a saved snapshot, not an implicit external refresh');
  assert.deepEqual(f.app.db.prepare('SELECT id,status,targets_json FROM app_build').all(),before,'report actions cannot create enable jobs or change existing ad execution state');
});

test('reporting HTTP retains the last successful snapshot when Google authorization fails', {timeout:60000}, async t=>{
  const source=reader();
  const f=await fixture(t,{reportingReader:source,reportingClock:()=>NOW,reportingScheduler:false});
  const initial=ok(await f.request('/api/reporting/accounts',{method:'POST',actor:f.admin,body:{accountId:ACCOUNT}}),201);
  source.fail=true;
  const failed=await f.request('/api/reporting/sync',{method:'POST',actor:f.admin,body:{accountId:ACCOUNT}});
  error(failed,[409,502]);
  assert.ok(!failed.text.includes('PRIVATE_AUTH_RESPONSE_MUST_NOT_LEAK'));
  const saved=ok(await f.request(`/api/reporting/reports/${initial.report.id}`,{actor:f.admin}));
  assert.equal(saved.totals.cost,25);
  assert.equal(saved.revision,initial.report.revision);
  const status=ok(await f.request('/api/reporting',{actor:f.admin}));
  assert.ok(status.accounts[0].lastError);
  assert.ok(!JSON.stringify(status).includes('PRIVATE_AUTH_RESPONSE_MUST_NOT_LEAK'));
});
