// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createGoogleImport} from '../runner/google-import.mjs';

function snapshot(change) {
  const s = {schemaVersion:1,proposalId:'synthetic-proposal',proposalRevision:7,review:{status:'approved'},desiredState:'paused',brief:{operation:'new_campaign',platforms:['Google'],timeZone:'Asia/Shanghai',startAt:'2030-02-03T09:00',budgets:{Google:10}},configuration:{targets:[{platform:'Google',accountId:'123-456-7890',accountTimeZone:'Asia/Shanghai',campaignType:'search',creativeMode:'text',keywordMatchType:'phrase',placements:['google_search'],dailyBudget:10,budgetLevel:'campaign',bidStrategy:'maximize_clicks',bidValue:null,languageCodes:['English'],locationIds:['United States'],conversionEventName:'Synthetic registration',conversionEventId:'synthetic-registration',audienceBindings:[]}]},effectiveNames:{Google:{campaign:'Synthetic campaign [AGC-12345678]',adGroup:'Synthetic group [AGC-12345678]',ad:'Synthetic Ad 01'}},adSpecifications:[{platform:'Google',headlines:['Create Synthetic Models','Synthetic Tool','Explore Synthetic Creation'],descriptions:['Use the synthetic tool for a fictional creative workflow.','Synthetic copy for tests only. No real campaign exists.'],keywords:['synthetic creator','synthetic model tool'],negativeKeywords:['synthetic jobs'],landingUrl:'https://example.com/?tracking_code=synthetic-id&utm_source=Google#start',trackingId:'synthetic-id',materialId:'synthetic-material'}],tracking:[{id:'synthetic-id',platform:'Google',materialId:'synthetic-material',url:'https://example.com/?tracking_code=synthetic-id&utm_source=Google#start'}]};
  if (change) change(s);
  s.fingerprint=createHash('sha256').update(JSON.stringify(s)).digest('hex');
  return s;
}
const campaign={platform:'Google',accountId:'1234567890',level:'campaign',id:'111111',parentId:'',status:'paused'};
const group={platform:'Google',accountId:'1234567890',level:'adGroup',id:'222222',parentId:'111111',status:'paused'};
const ad={platform:'Google',accountId:'1234567890',level:'ad',id:'333333',parentId:'222222',status:'paused'};
const generate=(s,stage,objects=[])=>createGoogleImport({snapshot:s,stage,objects,euPoliticalAds:false});
const rejects=(fn,code)=>assert.throws(fn,e=>e.code===code);
function rows(csv) {
  return csv.replace(/^\uFEFF/,'').trimEnd().split('\r\n').map(row=>row.slice(1,-1).split('","').map(v=>v.replaceAll('""','"')));
}
test('campaign upload is one paused Search entity with frozen budget, date, network and targeting',()=>{
  const s=snapshot(), before=JSON.stringify(s), result=generate(s,'campaign'), values=rows(result.csv);
  assert.equal(result.rowCount,1);assert.equal(result.paused,true);
  const item=Object.fromEntries(values[0].map((key,i)=>[key,values[1][i]]));
  assert.deepEqual(item,{Action:'Add','Campaign status':'Paused','Customer ID':'1234567890',Campaign:s.effectiveNames.Google.campaign,'Campaign type':'Search',Networks:'Google search',Budget:'10','Budget type':'Daily','Bid strategy type':'Maximize clicks','Campaign start date':'2030-02-03',Language:'English',Location:'United States','EU political ads':'No'});
  assert.equal(JSON.stringify(s),before);assert.ok(result.manualChecks.some(v=>v.includes('转化目标')));assert.ok(!result.headers.includes('Campaign end date'));
  assert.ok(result.headers.includes('Language'),'retain the current provider template field');
  assert.ok(result.manualChecks.some(v=>v.includes('2026 年 9 月')&&v.includes('按广告语言自动匹配')&&v.includes('预览成功不代表锁定语言人群')));
  assert.ok(result.manualChecks.some(v=>v.includes('账户级')&&v.includes('继承素材的文案和落地链接')&&v.includes('不得为本次测试修改账户全局素材')));
});
test('new campaigns require an explicit nonpolitical declaration; missing or political input never silently emits No',()=>{
  const s=snapshot();
  for(const value of [undefined,null,true,'No',0]) rejects(()=>createGoogleImport({snapshot:s,stage:'campaign',euPoliticalAds:value}),'EU_POLITICAL_DECLARATION_REQUIRED');
  const result=createGoogleImport({snapshot:s,stage:'campaign',euPoliticalAds:false}),values=rows(result.csv);
  assert.equal(values[0].at(-1),'EU political ads');assert.equal(values[1].at(-1),'No');
  assert.equal(createGoogleImport({snapshot:s,stage:'adGroup',objects:[campaign]}).rowCount,1,'descendants do not invent a new campaign declaration');
});
test('each descendant uses observed numeric parents and explicit paused status, with exact frozen URL',()=>{
  const s=snapshot(), groupFile=generate(s,'adGroup',[campaign]), adFile=generate(s,'ad',[campaign,group]), words=generate(s,'keywords',[campaign,group,ad]);
  assert.equal(rows(groupFile.csv)[1][2],campaign.id);assert.equal(rows(groupFile.csv)[1].at(-1),'Paused');
  assert.equal(groupFile.headers.at(-1),'Ad group status');assert.ok(!groupFile.headers.includes('Status'));
  const rsa=Object.fromEntries(rows(adFile.csv)[0].map((key,i)=>[key,rows(adFile.csv)[1][i]]));
  assert.equal(rsa['Ad group ID'],group.id);assert.equal(rsa['Ad status'],'Paused');assert.equal(rsa['Description 1'],s.adSpecifications[0].descriptions[0]);assert.equal(rsa['Description 2'],s.adSpecifications[0].descriptions[1]);assert.ok(!('Description' in rsa));assert.equal(rsa['Final URL'],s.adSpecifications[0].landingUrl);
  assert.equal(rsa['Campaign ID'],campaign.id);assert.equal(rsa.Campaign,s.effectiveNames.Google.campaign);assert.equal(rsa['Ad group'],s.effectiveNames.Google.adGroup);
  assert.ok(words.headers.includes('Type'));assert.ok(!words.headers.includes('Match Type'));
  assert.equal(words.rowCount,2);assert.ok(rows(words.csv).slice(1).every(r=>r[1]==='Paused'&&r.at(-1)==='Phrase match'));
  assert.ok(words.manualChecks.some(v=>v.includes('否定关键词未写入')));
});
test('tampered, unreviewed, enabled or unsupported snapshots never produce a file',()=>{
  const s=snapshot();s.configuration.targets[0].dailyBudget=100;
  rejects(()=>generate(s,'campaign'),'SNAPSHOT_MISMATCH');
  for (const modify of [s=>s.review.status='draft',s=>s.desiredState='enabled']) rejects(()=>generate(snapshot(modify),'campaign'),'REVIEW_REQUIRED');
  rejects(()=>generate(snapshot(s=>s.configuration.targets[0].campaignType='performance_max'),'campaign'),'UNSUPPORTED_FORMAT');
  rejects(()=>generate(snapshot(s=>s.configuration.targets[0].dailyBudget=20),'campaign'),'BUDGET_MISMATCH');
  rejects(()=>generate(snapshot(s=>s.configuration.targets[0].placements.push('search_partners')),'campaign'),'UNSUPPORTED_FORMAT');
});
test('known parents cannot be cross-account, enabled, malformed, out of hierarchy or recreated',()=>{
  const s=snapshot();
  rejects(()=>generate(s,'adGroup'),'PARENT_REQUIRED');
  rejects(()=>generate(s,'adGroup',[{...campaign,status:'enabled'}]),'PARENT_NOT_PAUSED');
  rejects(()=>generate(s,'ad',[{...campaign,accountId:'9999999999'},group]),'ACCOUNT_MISMATCH');
  rejects(()=>generate(s,'ad',[campaign,{...group,parentId:'99999'}]),'PARENT_SCOPE_MISMATCH');
  rejects(()=>generate(s,'adGroup',[{...campaign,id:'guessed-name'}]),'INVALID_REMOTE_ID');
  rejects(()=>generate(s,'campaign',[campaign]),'ALREADY_CREATED');
  rejects(()=>generate(s,'adGroup',[campaign,group]),'PARENT_REQUIRED');
  rejects(()=>generate(s,'ad',[campaign,group,ad]),'ALREADY_CREATED');
});
test('new-group imports bind the frozen existing campaign and never emit parent edits',()=>{
  const s=snapshot(s=>{s.brief.operation='new_group';s.brief.parentCampaign={platform:'Google',accountId:'1234567890',campaignId:'999999',name:'Original parent'};s.configuration.targets[0].budgetLevel='inherit_campaign';s.effectiveNames.Google.campaign='Original parent';});
  const result=generate(s,'adGroup');
  assert.equal(rows(result.csv)[1][2],'999999');assert.ok(!result.headers.includes('Budget'));
  rejects(()=>generate(s,'campaign'),'ALREADY_CREATED');
  rejects(()=>generate(s,'adGroup',[campaign]),'PARENT_SCOPE_MISMATCH');
  rejects(()=>generate(s,'ad',[{...group,parentId:'111111'}]),'PARENT_SCOPE_MISMATCH');
  assert.equal(generate(s,'ad',[{...group,parentId:'999999'}]).rowCount,1);
});
test('formula-like content, unsafe URLs and overwritten tracking fail instead of escaping into different ad text',()=>{
  for (const value of ['=HYPERLINK("https://example.com")',' +1','\tformula','@account','-command']) rejects(()=>generate(snapshot(s=>s.effectiveNames.Google.campaign=value),'campaign'),/[\t]/.test(value)?'INVALID_LITERAL':'FORMULA_REJECTED');
  rejects(()=>generate(snapshot(s=>s.adSpecifications[0].landingUrl='https://example.com/changed'),'ad',[campaign,group]),'TRACKING_MISMATCH');
  const unsafe=snapshot(s=>{const url=new URL('https://example.com/');url.username='synthetic';url.password='synthetic';s.adSpecifications[0].landingUrl=url.href;s.tracking[0].url=s.adSpecifications[0].landingUrl;});
  rejects(()=>generate(unsafe,'ad',[campaign,group]),'INVALID_URL');
  const quoted=snapshot(s=>s.effectiveNames.Google.campaign='Synthetic "quoted", campaign');
  assert.ok(generate(quoted,'campaign').csv.includes('Synthetic ""quoted"", campaign'));
});
test('RSA limits and keyword matching stay exact, with manual CPC confined to reviewed amount',()=>{
  rejects(()=>generate(snapshot(s=>s.adSpecifications[0].headlines[0]='a'.repeat(31)),'ad',[campaign,group]),'INVALID_COPY');
  rejects(()=>generate(snapshot(s=>s.adSpecifications[0].headlines[0]='字'.repeat(16)),'ad',[campaign,group]),'INVALID_COPY');
  rejects(()=>generate(snapshot(s=>s.adSpecifications[0].keywords=['"synthetic creator"']),'keywords',[campaign,group]),'INVALID_KEYWORDS');
  const s=snapshot(s=>{s.configuration.targets[0].bidStrategy='manual_cpc';s.configuration.targets[0].bidValue=0.5;s.configuration.targets[0].keywordMatchType='exact';});
  const result=generate(s,'keywords',[campaign,group]);
  assert.equal(result.headers.at(-1),'Default max. CPC');assert.ok(rows(result.csv).slice(1).every(r=>r.at(-1)==='0.5'&&r.at(-2)==='Exact match'));
});
test('campaign dates cannot silently reinterpret time zones or impossible dates',()=>{
  rejects(()=>generate(snapshot(s=>s.brief.timeZone='America/Los_Angeles'),'campaign'),'TIME_ZONE_MISMATCH');
  rejects(()=>generate(snapshot(s=>s.brief.startAt='2030-02-30T09:00'),'campaign'),'INVALID_START_DATE');
  rejects(()=>generate(snapshot(s=>s.brief.startAt='2030-02-03T25:00'),'campaign'),'INVALID_START_DATE');
});
