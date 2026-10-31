// SPDX-License-Identifier: MIT
// Actual reporting controller with synthetic HTTP responses; never reads Ads.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../workspace/app.js',import.meta.url),'utf8');
const account = {id:'1234567890',name:'Synthetic account',currency:'CNY',timeZone:'Asia/Shanghai',dailyEnabled:true,localTime:'10:00',lastSuccessAt:'2026-10-27T04:00:00Z'};
const totals = {cost:24,impressions:100,clicks:10,ctr:.1,cpc:2.4,conversions:2.5,cpa:9.6,conversionValue:0};
const campaign = {id:'111',name:'Synthetic paused test',status:'PAUSED',startDate:'2026-10-28',totals,associations:[{buildId:'build-1',proposalRevision:2,title:'Frozen proposal'}]};
const report = {id:'report-1',accountId:account.id,reportDate:'2026-10-26',fetchedAt:account.lastSuccessAt,account,currency:'CNY',timeZone:'Asia/Shanghai',totals,campaigns:[campaign],scope:{campaignId:null},summary:['已读取真实来源。'],recommendations:[{title:'继续核对数据',detail:'暂停验收计划不评价投放效率。'}],conversionActions:[{id:'conversion-1',name:'Synthetic signup',category:'SIGNUP',conversions:2.5,conversionValue:0}],trend:[{date:'2026-10-26',...totals}],source:{provider:'Google Ads',mode:'read_only',observedThrough:'2026-10-26',fetchedAt:account.lastSuccessAt,window:{startDate:'2026-10-19',endDate:'2026-10-26'}},limitations:['转化可能回补。']};
const list = () => ({connection:{configured:true},accounts:[account],reports:[{id:report.id,accountId:account.id,reportDate:report.reportDate}]});
const reply = (value,status=200) => ({ok:status<400,status,json:async()=>value});
function harness(replies=[]) {
  const calls=[], listeners={}, root={innerHTML:'',addEventListener(name,fn){(listeners[name] ||= []).push(fn);},querySelector(){return null;},querySelectorAll(){return [];}};
  const context={URL,URLSearchParams,Date,Intl,setInterval(){},location:{hash:'',origin:'https://example.com'},
    document:{getElementById(){return root;},body:{setAttribute(){}},hidden:false},window:{addEventListener(){}},
    fetch:async(path,options)=>{calls.push({path,method:options.method,body:options.body ? JSON.parse(options.body) : undefined});const r=replies.shift();if(r instanceof Error)throw r;if(!r)throw Error('Unexpected request');return r;}};
  vm.runInNewContext(source.replace('void start();','globalThis.ui={state,reportingView,loadReporting,loadReportingDetail,syncReporting,clearResourceState,reportingKey};'),context);
  const ui=context.ui;
  Object.assign(ui.state,{loading:false,view:'reporting',me:{user:{id:'synthetic-user',name:'Synthetic user'},team:{id:'synthetic-team'},role:'admin',permissions:{canEdit:true,canManage:true}}});
  return {ui,calls,listeners,root,replies};
}
function loaded(h,detail=report) {
  Object.assign(h.ui.state.reporting,{data:list(),accountId:account.id,reportDate:report.reportDate,campaignId:'',detail,detailKey:[account.id,report.reportDate,''].join(':'),campaignOptions:[campaign]});
}
test('configuration never looks like a successful data connection and empty dates show unknown',()=>{
  const h=harness();h.ui.state.reporting.data={connection:{configured:true},accounts:[],reports:[]};
  const html=h.ui.reportingView();
  assert.ok(html.includes('已配置，只读读取'));assert.ok(html.includes('暂无数据时不会显示示例数字'));
  assert.ok(!html.includes('class="report-metric-value"'));assert.ok(!html.includes('已连接'));
});
test('actual metrics preserve fractional conversions and no-denominator display; paused data gets no enable action',()=>{
  const h=harness();loaded(h,{...report,totals:{...totals,cost:0,clicks:0,conversions:0,ctr:null,cpc:null,cpa:null},campaigns:[{...campaign,totals:{...totals,cost:0,clicks:0,conversions:0,cpa:null}}]});
  const html=h.ui.reportingView();
  assert.ok(html.includes('已暂停'));assert.ok(html.includes('所选日期尚未投放'));
  assert.ok(html.includes('Google Ads 归因转化，可含小数'));assert.ok(html.includes('2.5'));
  assert.ok(html.includes('0 CNY'));assert.ok(!html.includes('data-execution-action="confirm-enable"'));
  assert.ok(html.includes('根据已同步数据和固定规则生成'));assert.ok(!html.includes('Codex 已生成日报'));
});
test('read-only members can view reports without account, sync or schedule write controls',()=>{
  const h=harness();loaded(h);h.ui.state.me.permissions={canEdit:false,canManage:false};
  const html=h.ui.reportingView();assert.ok(!html.includes('id="report-account-form"'));assert.ok(!html.includes('id="report-schedule-form"'));
  assert.ok(!html.includes('data-reporting-action="sync"'));assert.ok(html.includes('Synthetic paused test'));
});
test('loading reports never replaces unsaved proposal input',async()=>{
  const h=harness([reply(list()),reply(report)]);const editor={id:'draft-1',title:'Unsaved input',dirty:true,workflowDirty:true};h.ui.state.editor=editor;
  await h.ui.loadReporting();assert.equal(h.ui.state.editor,editor);assert.equal(editor.title,'Unsaved input');
  assert.deepEqual(h.calls.map(c=>c.method),['GET','GET']);assert.equal(h.ui.state.reporting.detail.id,report.id);
});
test('campaign filtering uses a fresh server report and retains the account-wide selector options',async()=>{
  const filtered={...report,scope:{campaignId:'111',name:campaign.name},totals:{...totals,cost:3}};
  const h=harness([reply(filtered)]);loaded(h);h.ui.state.reporting.campaignId='111';
  await h.ui.loadReportingDetail(report.id);
  assert.equal(h.calls[0].path,'/api/reporting/reports/report-1?campaignId=111');
  assert.equal(h.ui.state.reporting.detail.totals.cost,3);assert.equal(h.ui.state.reporting.campaignOptions.length,1);
  assert.ok(h.ui.reportingView().includes('单个计划：Synthetic paused test'));
});
test('failed source read cannot replace the last successful report with zero or mark a save successful',async()=>{
  const h=harness([reply({error:{code:'SOURCE_FAILED',message:'来源暂时无法读取'}},502),reply(list()),reply(report)]);loaded(h);
  await assert.rejects(h.ui.syncReporting());
  assert.equal(h.ui.state.reporting.detail.totals.cost,24);assert.ok(h.ui.state.reporting.error.includes('来源暂时无法读取'));
  assert.ok(h.ui.reportingView().includes('保留最近成功读取的数据'));assert.ok(!h.ui.state.message.includes('日报已保存'));
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
});
test('provider text is escaped and identity reset removes all report data',()=>{
  const h=harness();loaded(h,{...report,summary:['<script>alert(1)</script>'],campaigns:[{...campaign,name:'<img src=x onerror=alert(1)>'}]});
  const html=h.ui.reportingView();assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));
  h.ui.clearResourceState();assert.equal(h.ui.state.reporting.detail,null);assert.equal(h.ui.state.reporting.data,null);
});
test('trend period and actual backfill query period stay distinct, with safe configuration errors',()=>{
  const h=harness();loaded(h,{...report,source:{...report.source,queryWindow:{startDate:'2026-10-12',endDate:'2026-10-26'},queriedThrough:'2026-10-26'}});
  h.ui.state.reporting.data.connection={configured:false,error:{message:'请核对只读授权 <error>'}};
  const html=h.ui.reportingView();
  assert.ok(html.includes('本日报趋势覆盖 2026-10-19 至 2026-10-26'));
  assert.ok(html.includes('本次实际读取 2026-10-12 至 2026-10-26'));
  assert.ok(!html.includes('本次读取截至 2026-10-26'),'the query cutoff is not repeated');
  assert.ok(html.includes('请核对只读授权 &lt;error&gt;'));
});
