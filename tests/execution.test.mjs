// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID,createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, ok, error, proposal, setupResources, CONTENT, CONFIG, freshBrief} from './phase34-fixture.mjs';

// Real HTTP/authentication/temporary SQLite; all platform IDs, observations and
// PNGs below are synthetic protocol fixtures. No ad platform is opened or edited.
const HEALTH = {version:'synthetic-browser-test',codex:{available:true,authenticated:true,version:'synthetic-codex'}};
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEioAAAAASUVORK5CYII=';
const ACCOUNT = '1234567890';
const URL = 'https://ads.google.com/aw/campaigns';
const target = change => ({platform:'Google',accountId:ACCOUNT,accountName:'Synthetic account',accountCurrency:'USD',accountTimeZone:'America/Los_Angeles',accountUrl:URL,campaignName:'Synthetic reviewed campaign',groupName:'Synthetic group',campaignType:'search',budgetLevel:'campaign',dailyBudget:60,bidStrategy:'maximize_clicks',bidValue:null,conversionEventId:'synthetic-registration',conversionEventName:'Synthetic registration',pixelId:'',identityId:'',instagramAccountId:'',creativeMode:'text',locationIds:['United States'],languageCodes:['English'],placements:['google_search'],audienceBindings:[],keywordMatchType:'phrase',...change});
const objects = (change = {}) => [{level:'campaign',id:'synthetic-campaign',parentId:'',status:'paused',url:URL},{level:'adGroup',id:'synthetic-group',parentId:'synthetic-campaign',status:'paused',url:URL},{level:'ad',id:'synthetic-ad',parentId:'synthetic-group',status:'paused',url:URL}].map(o=>({...o,...change[o.level]}));
const workflowPath = item => `/api/proposals/${item.id}/workflow`;
const configPath = item => `/api/proposals/${item.id}/execution/config`;
const buildPath = item => `/api/proposals/${item.id}/builds`;
const jobPath = (job, action) => `/api/runner/browser/jobs/${job.id}/${action}`;
const runner = (f,device,path,body={}) => f.request(path,{method:'POST',headers:{Authorization:`Bearer ${device.token}`},body});
async function pairing(f,actor=f.admin) {
  const pairing=ok(await f.request('/api/connectors/pairing',{method:'POST',actor,body:{}}),201).pairing;
  const device=ok(await f.request('/api/connectors/exchange',{method:'POST',body:{code:pairing.code,deviceName:'Synthetic browser executor'}}),201);
  ok(await runner(f,device,'/api/runner/heartbeat',HEALTH));
  ok(await f.request(`/api/connectors/${device.connectorId}/confirm`,{method:'POST',actor,body:{}}));
  return device;
}
async function current(f,item,actor=f.admin) {return ok(await f.request(workflowPath(item),{actor}));}
async function review(f,state,action,actor=f.admin) {return ok(await f.request(`/api/proposals/${state.item.id}/review`,{method:'POST',actor,body:{expectedRevision:state.item.revision,action,note:'Synthetic human review'}}));}
async function prepared(f,{actor=f.admin,brief={},configuration=target(),approve=true,content=CONTENT}={}) {
  const resources=await setupResources(f,actor),item=await proposal(f,actor,brief);
  const targets=Array.isArray(configuration)?configuration:[configuration];
  if(targets.some(t=>t.platform!=='Google')) {
    const bytes=Buffer.from('000000186674797069736F6D0000020069736F6D69736F32','hex');
    resources.material=ok(await f.request(`/api/materials/${resources.material.id}/file?expectedRevision=${resources.material.revision}`,{method:'PUT',actor,rawBody:bytes,headers:{'Content-Type':'application/octet-stream','X-File-Name':'synthetic-fixture.mp4'}})).item;
    resources.selection.materials=[{id:resources.material.id,revision:resources.material.revision}];
  }
  let state=ok(await f.request(workflowPath(item),{method:'PATCH',actor,body:{expectedRevision:item.revision,selection:resources.selection,content}}));
  if(!ok(await f.request('/api/tracking-config',{actor})).item.configured) ok(await f.request('/api/tracking-config',{method:'PUT',actor:f.admin,body:CONFIG}));
  state=ok(await f.request(configPath(item),{method:'POST',actor,body:{expectedRevision:state.item.revision,targets}}));
  state=ok(await f.request(`/api/proposals/${item.id}/tracking`,{method:'POST',actor,body:{expectedRevision:state.item.revision}}));
  if(approve){state=await review(f,state,'submit',actor);state=await review(f,state,'approve',actor);}
  return {...state,resources};
}
async function enqueue(f,state,device,actor=f.admin) {return ok(await f.request(buildPath(state.item),{method:'POST',actor,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),201);}
async function details(f,build,actor=f.admin) {return ok(await f.request(`/api/builds/${build.id}`,{actor}));}
async function claim(f,device,build) {return ok(await runner(f,device,'/api/runner/browser/claim',{buildId:build.id})).job;}
async function evidence(f,device,job,stage,platform='Google') {const url=job.snapshot.configuration.targets.find(t=>t.platform===platform).accountUrl;return ok(await runner(f,device,jobPath(job,'evidence'),{leaseToken:job.leaseToken,platform,stage,mime:'image/png',base64:PNG,url,caption:`Synthetic ${stage} test image; no real ad account observed.`}),201).evidence.id;}
function observation(change={}) {return {accountId:ACCOUNT,currency:'USD',timeZone:'America/Los_Angeles',campaignType:'search',parentCampaignId:'',canPublishPaused:true,pausedScopes:['campaign'],url:URL,...change};}
async function preflight(f,device,job,{change={},stage='before_publish',existing,platform='Google'}={}) {
  const configured=job.snapshot.configuration.targets.find(t=>t.platform===platform);
  const ids=[await evidence(f,device,job,'preflight',platform),await evidence(f,device,job,stage,platform)];
  return runner(f,device,jobPath(job,'preflight'),{leaseToken:job.leaseToken,platform,observation:observation({accountId:configured.accountId,currency:configured.accountCurrency,timeZone:configured.accountTimeZone,campaignType:configured.campaignType,url:configured.accountUrl,...change,...(existing?{objects:existing}:{})}),evidenceIds:ids});
}
async function intent(f,device,job,action='publish_paused',platform='Google') {return ok(await runner(f,device,jobPath(job,'intent'),{leaseToken:job.leaseToken,platform,action}));}
async function paused(f,device,job,{adObjects=objects(),change={},platform='Google'}={}) {
  ok(await preflight(f,device,job,{change,platform}));
  const ticket=await intent(f,device,job,'publish_paused',platform),proof=await evidence(f,device,job,'after_publish',platform);
  const payload={leaseToken:job.leaseToken,platform,intentToken:ticket.intentToken,outcome:'paused_verified',objects:adObjects,evidenceIds:[proof],message:'Synthetic paused result; not a real advertisement.'};
  return {response:await runner(f,device,jobPath(job,'result'),payload),payload};
}

test('browser configuration is part of human review; strict schema and changed configuration invalidate approval', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f);
  const approvedRevision=state.item.revision;
  for(const forged of [{verified:true},{canPublishPaused:true},{paused:true},{accountUrl:'https://ads.google.com.example.com/'}]) error(await f.request(configPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:approvedRevision,targets:[target(forged)]}}),400);
  error(await f.request(configPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:approvedRevision-1,targets:[target()]}}),409);
  const saved=ok(await f.request(configPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:approvedRevision,targets:[target({bidStrategy:'manual_cpc',bidValue:2})]}}));
  assert.equal(saved.workflow.review.status,'draft');
  assert.equal(saved.item.revision,approvedRevision+1);
  error(await f.request(buildPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:saved.item.revision,connectorId:device.connectorId}}),[400,409]);
  error(await f.request(`/api/proposals/${state.item.id}/review`,{method:'POST',headers:{Authorization:`Bearer ${device.token}`},body:{expectedRevision:saved.item.revision,action:'approve',note:''}}),401,'runner bearer cannot approve human review');
  const versions=ok(await f.request(`/api/proposals/${state.item.id}/versions`,{actor:f.admin})).items;
  assert.equal(versions.find(v=>v.revision===approvedRevision).workflow.review.status,'approved');
});

test('enqueue rejects stale dependencies and another owner device; audit failure leaves no executable orphan', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f);
  const editor=await f.invitedMember(f.admin,'browser-editor@example.com'),viewer=await f.invitedMember(f.admin,'browser-viewer@example.com','viewer');
  error(await f.request(buildPath(state.item),{method:'POST',actor:editor,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),[403,404,409]);
  error(await f.request(buildPath(state.item),{method:'POST',actor:viewer,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),403);
  const before=await current(f,state.item);
  f.app.db.exec("CREATE TRIGGER phase6_abort_enqueue BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic browser enqueue rollback'); END;");
  error(await f.request(buildPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),500);
  f.app.db.exec('DROP TRIGGER phase6_abort_enqueue');
  assert.deepEqual(await current(f,state.item),before);
  assert.deepEqual(ok(await f.request(`/api/proposals/${state.item.id}/execution`,{actor:f.admin})).builds,[]);
  ok(await f.request(`/api/landings/${state.resources.landing.id}`,{method:'PATCH',actor:f.admin,body:{expectedRevision:state.resources.landing.revision,name:'Synthetic changed page'}}));
  error(await f.request(buildPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),[400,409]);
  const g=await fixture(t),secondDevice=await pairing(g),second=await prepared(g);
  ok(await g.request('/api/tracking-config',{method:'PUT',actor:g.admin,body:{...CONFIG,expectedRevision:1,name:'Synthetic changed tracking rule'}}));
  error(await g.request(buildPath(second.item),{method:'POST',actor:g.admin,body:{expectedRevision:second.item.revision,connectorId:secondDevice.connectorId}}),[400,409]);
});

test('browser claims are atomic, device-bound and persisted with scoped credentials', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),other=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device);
  error(await runner(f,other,'/api/runner/browser/claim',{buildId:queued.item.id}),[403,404]);
  error(await f.request('/api/runner/browser/claim',{method:'POST',actor:f.admin,body:{buildId:queued.item.id}}),[401,403]);
  const races=await Promise.all([runner(f,device,'/api/runner/browser/claim',{buildId:queued.item.id}),runner(f,device,'/api/runner/browser/claim',{buildId:queued.item.id})]);
  const wins=races.filter(r=>r.status===200&&r.data.job);assert.equal(wins.length,1,'one job can have only one live lease');
  const job=wins[0].data.job;assert.ok(job.leaseToken&&job.snapshot&&job.targets);
  error(await runner(f,device,jobPath(job,'heartbeat'),{leaseToken:'wrong-lease-token'}),[400,403,409]);
  const record=await details(f,queued.item);
  assert.ok(!JSON.stringify(record).includes(job.leaseToken));assert.ok(!JSON.stringify(record).includes(device.token));
  await f.restart();
  assert.equal((await details(f,queued.item)).item.id,queued.item.id);
  ok(await runner(f,device,jobPath(job,'heartbeat'),{leaseToken:job.leaseToken}));
});

test('paused creation needs fresh proof and publish intent; hierarchical results are idempotent and survive restart', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  error(await runner(f,device,jobPath(job,'evidence'),{leaseToken:job.leaseToken,platform:'Google',stage:'after_publish',mime:'image/png',base64:PNG,url:URL,caption:'Synthetic screenshot supplied before any publication intent'}),409,'a pre-submission screenshot cannot count as an after-publish observation');
  error(await runner(f,device,jobPath(job,'intent'),{leaseToken:job.leaseToken,platform:'Google',action:'publish_paused'}),[400,409]);
  error(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',outcome:'paused_verified',objects:objects(),evidenceIds:[],message:''}),[400,403,409]);
  error(await preflight(f,device,job,{change:{accountId:'9999999999'}}),[400,409]);
  ok(await preflight(f,device,job));
  const ticket=await intent(f,device,job),proof=await evidence(f,device,job,'after_publish');
  const payload={leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'paused_verified',objects:objects(),evidenceIds:[proof],message:'Synthetic protocol verification only.'};
  f.app.db.exec("CREATE TRIGGER phase6_abort_result BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic browser result rollback'); END;");
  error(await runner(f,device,jobPath(job,'result'),payload),500);
  f.app.db.exec('DROP TRIGGER phase6_abort_result');
  assert.equal((await details(f,queued.item)).objects.length,0,'objects cannot commit separately from their audit');
  ok(await runner(f,device,jobPath(job,'result'),payload));
  const committed=await details(f,queued.item);assert.equal(committed.objects.length,3);
  const events=committed.events.length;
  ok(await runner(f,device,jobPath(job,'result'),payload));
  assert.equal((await details(f,queued.item)).events.length,events,'same result replay is idempotent');
  error(await runner(f,device,jobPath(job,'result'),{...payload,objects:objects({ad:{id:'different-ad'}})}),409);
  const reconcileProof=await evidence(f,device,job,'reconcile');
  const replacements=objects().map(o=>({...o,id:'replacement-'+o.id,parentId:o.parentId?'replacement-'+o.parentId:''}));
  error(await runner(f,device,jobPath(job,'reconcile'),{leaseToken:job.leaseToken,platform:'Google',resolution:'found_paused',objects:replacements,evidenceIds:[reconcileProof]}),400,'reconciliation cannot replace already known object IDs with a different valid hierarchy');
  assert.deepEqual((await details(f,queued.item)).objects,committed.objects);
  await f.restart();assert.deepEqual((await details(f,queued.item)).objects,committed.objects);
  assert.equal((await current(f,state.item)).workflow.review.status,'approved','creating paused objects never implies enabling them');
});

test('publication uncertainty cannot silently retry and requires reconciliation evidence before recovery', {timeout:90000}, async t=>{
  let tick=Date.now();const f=await fixture(t,{executionClock:()=>tick,connectorClock:()=>tick}),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job));await intent(f,device,job);
  tick+=6*60_000;
  const record=await details(f,queued.item);
  assert.ok(['unknown','needs_attention'].includes(record.item.status),'expired possible publication must remain uncertain');
  error(await f.request(`/api/builds/${queued.item.id}/retry`,{method:'POST',actor:f.admin,body:{expectedRevision:state.item.revision}}),409);
  const recovered=await claim(f,device,queued.item);
  assert.ok(recovered,'unknown results can be claimed for read-only reconciliation');
  error(await runner(f,device,jobPath(recovered,'reconcile'),{leaseToken:recovered.leaseToken,platform:'Google',resolution:'found_paused',objects:objects(),evidenceIds:[]}),[400,409]);
  const proof=await evidence(f,device,recovered,'reconcile');
  ok(await runner(f,device,jobPath(recovered,'reconcile'),{leaseToken:recovered.leaseToken,platform:'Google',resolution:'found_paused',objects:objects(),evidenceIds:[proof]}));
  assert.equal((await details(f,queued.item)).objects.length,3);
});

test('enabling is a separately confirmed scoped job; stale plans and replayed previews cannot enable', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok((await paused(f,device,job)).response);
  const preview=ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}})).preview;
  assert.ok(preview.id&&preview.objects.length&&preview.budgets&&preview.targetAccounts);
  error(await runner(f,device,`/api/builds/${queued.item.id}/enable`,{previewId:preview.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}),401);
  error(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:preview.id,confirmation:'yes'}}),400);
  const enabled=ok(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:preview.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}}),201);
  assert.ok(enabled.item.id);assert.equal((await details(f,queued.item)).objects.length,3,'confirming queues work without claiming real delivery');
  error(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:preview.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}}),409);
  const enableJob=await claim(f,device,enabled.item);
  assert.equal(enableJob.kind,'enable');
  ok(await preflight(f,device,enableJob,{stage:'before_enable',existing:objects()}));
  const enableTicket=await intent(f,device,enableJob,'enable'),enableProof=await evidence(f,device,enableJob,'after_enable');
  const enabledObjects=objects({campaign:{status:'enabled'},adGroup:{status:'enabled'},ad:{status:'enabled'}});
  const enablePayload={leaseToken:enableJob.leaseToken,platform:'Google',intentToken:enableTicket.intentToken,outcome:'enabled_verified',objects:enabledObjects,evidenceIds:[enableProof],message:'Synthetic configured switches; no live delivery measured.'};
  error(await runner(f,device,jobPath(enableJob,'result'),{...enablePayload,objects:enabledObjects.map(o=>o.level==='ad'?{...o,id:'new-unconfirmed-ad'}:o)}),400);
  error(await runner(f,device,jobPath(enableJob,'result'),{...enablePayload,objects:enabledObjects.map(o=>o.level==='ad'?{...o,status:'paused'}:o)}),400);
  ok(await runner(f,device,jobPath(enableJob,'result'),enablePayload));
  assert.equal((await details(f,enabled.item)).item.status,'enabled_verified');
  assert.ok((await details(f,queued.item)).objects.every(o=>o.status==='enabled'));
  const changed=ok(await f.request(`/api/proposals/${state.item.id}`,{method:'PATCH',actor:f.admin,body:{expectedRevision:state.item.revision,title:'Synthetic post-approval edit'}}));
  assert.ok(changed.item.revision>state.item.revision);
  error(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}}),[400,409]);
});

test('adding an ad group binds the existing campaign and refuses claiming its parent as a new owned object', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),parent='synthetic-parent';
  const state=await prepared(f,{brief:{operation:'new_group',parentCampaign:{platform:'Google',accountId:ACCOUNT,campaignId:parent,name:'Synthetic existing parent'}},configuration:target({budgetLevel:'inherit_campaign'})});
  const queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job,{change:{parentCampaignId:parent,pausedScopes:['adGroup']}}));
  const ticket=await intent(f,device,job),proof=await evidence(f,device,job,'after_publish');
  const childObjects=objects().filter(o=>o.level!=='campaign').map(o=>o.level==='adGroup'?{...o,parentId:parent}:o);
  const payload={leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'paused_verified',objects:[...childObjects,{level:'campaign',id:parent,parentId:'',status:'paused',url:URL}],evidenceIds:[proof],message:'Synthetic group result'};
  error(await runner(f,device,jobPath(job,'result'),payload),[400,409]);
  error(await runner(f,device,jobPath(job,'result'),{...payload,objects:childObjects.map(o=>o.level==='adGroup'?{...o,parentId:'wrong-parent'}:o)}),[400,409]);
  ok(await runner(f,device,jobPath(job,'result'),{...payload,objects:childObjects}));
  const persisted=(await details(f,queued.item)).objects;
  assert.equal(persisted.length,2);assert.ok(persisted.every(o=>o.level!=='campaign'),'existing parent never becomes this job owned scope');
});

test('a late paused result preserves created object evidence after a plan edit but cannot enable the outdated version', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job));const ticket=await intent(f,device,job);
  ok(await f.request(`/api/proposals/${state.item.id}`,{method:'PATCH',actor:f.admin,body:{expectedRevision:state.item.revision,brief:freshBrief({audienceDirection:'A newer synthetic audience direction'})}}));
  const proof=await evidence(f,device,job,'after_publish');
  ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'paused_verified',objects:objects(),evidenceIds:[proof],message:'Synthetic result already created before the plan changed.'}));
  assert.equal((await details(f,queued.item)).objects.length,3,'a newer plan must not discard evidence of externally created objects');
  error(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}}),[400,409]);
});

test('cancelled leases cannot resurrect a build and blocked preflight requires an explicit human retry', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  const proof=[await evidence(f,device,job,'preflight'),await evidence(f,device,job,'before_publish')];
  ok(await f.request(`/api/builds/${queued.item.id}/cancel`,{method:'POST',actor:f.admin,body:{}}));
  error(await runner(f,device,jobPath(job,'preflight'),{leaseToken:job.leaseToken,platform:'Google',observation:observation(),evidenceIds:proof}),409);
  error(await runner(f,device,jobPath(job,'intent'),{leaseToken:job.leaseToken,platform:'Google',action:'publish_paused'}),409);
  error(await runner(f,device,jobPath(job,'heartbeat'),{leaseToken:job.leaseToken}),409);
  assert.equal((await details(f,queued.item)).item.status,'cancelled');
  const g=await fixture(t),secondDevice=await pairing(g),secondState=await prepared(g),secondQueued=await enqueue(g,secondState,secondDevice),secondJob=await claim(g,secondDevice,secondQueued.item);
  ok(await preflight(g,secondDevice,secondJob,{change:{canPublishPaused:false}}));
  assert.equal((await details(g,secondQueued.item)).item.status,'blocked');
  error(await preflight(g,secondDevice,secondJob),409,'runner cannot bypass blocked status by resending a different preflight');
  ok(await g.request(`/api/builds/${secondQueued.item.id}/retry`,{method:'POST',actor:g.admin,body:{expectedRevision:secondState.item.revision}}));
  const retried=await claim(g,secondDevice,secondQueued.item);
  assert.notEqual(retried.leaseToken,secondJob.leaseToken);
  ok(await preflight(g,secondDevice,retried));await intent(g,secondDevice,retried);
});

test('reconciling an interrupted enable preserves object IDs and updates the source state in both observed outcomes', {timeout:90000}, async t=>{
  for(const resolution of ['found_paused','found_enabled']) {
    const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),createJob=await claim(f,device,queued.item);
    ok((await paused(f,device,createJob)).response);
    const preview=ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}})).preview;
    const enabled=ok(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:preview.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}}),201),job=await claim(f,device,enabled.item);
    error(await runner(f,device,jobPath(job,'evidence'),{leaseToken:job.leaseToken,platform:'Google',stage:'after_enable',mime:'image/png',base64:PNG,url:URL,caption:'Synthetic image before enable intent'}),409);
    ok(await preflight(f,device,job,{stage:'before_enable',existing:objects()}));const ticket=await intent(f,device,job,'enable');
    ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'unknown',objects:[],evidenceIds:[],message:'Synthetic interrupted enable; outcome is unknown.'}));
    const proof=await evidence(f,device,job,'reconcile'),observed=resolution==='found_enabled'?objects({campaign:{status:'enabled'},adGroup:{status:'enabled'},ad:{status:'enabled'}}):objects();
    error(await runner(f,device,jobPath(job,'reconcile'),{leaseToken:job.leaseToken,platform:'Google',resolution:'not_found',objects:[],evidenceIds:[proof]}),409,'an enable job cannot discard its previously known objects');
    ok(await runner(f,device,jobPath(job,'reconcile'),{leaseToken:job.leaseToken,platform:'Google',resolution,objects:observed,evidenceIds:[proof]}));
    const source=await details(f,queued.item),child=await details(f,enabled.item);
    assert.deepEqual(source.objects.map(o=>o.id),objects().map(o=>o.id));
    assert.deepEqual(child.objects.map(o=>o.id),objects().map(o=>o.id));
    if(resolution==='found_enabled') {assert.equal(child.item.status,'enabled_verified');assert.equal(source.item.status,'enabled_verified');assert.ok(source.objects.every(o=>o.status==='enabled'));}
    else {assert.equal(child.item.status,'failed');assert.equal(source.item.status,'paused_verified');assert.ok(source.objects.every(o=>o.status==='paused'));ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}}));error(await f.request(`/api/builds/${enabled.item.id}/retry`,{method:'POST',actor:f.admin,body:{expectedRevision:state.item.revision}}),409,'new enable needs a fresh confirmation');}
  }
});

test('partial enable recovery previews only still-paused platforms and never re-enables a successful platform', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),metaURL='https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=9876543210';
  const meta=target({platform:'Meta',accountId:'9876543210',accountName:'Synthetic Meta account',accountUrl:metaURL,campaignType:'sales',budgetLevel:'ad_group',bidStrategy:'lowest_cost',creativeMode:'file',pixelId:'synthetic-pixel',identityId:'synthetic-page',placements:['facebook_feed'],keywordMatchType:''});
  const copy={...CONTENT,platforms:[...CONTENT.platforms,{platform:'Meta',headlines:['Synthetic headline'],descriptions:[],primaryTexts:['Synthetic website registration message'],keywords:[],negativeKeywords:[],callToAction:'Sign up'}]};
  const state=await prepared(f,{brief:{platforms:['Google','Meta'],budgets:{Google:60,Meta:60}},configuration:[target(),meta],content:copy}),queued=await enqueue(f,state,device),createJob=await claim(f,device,queued.item);
  const material=createJob.snapshot.selectionSnapshot.materials[0];
  const download=await runner(f,device,jobPath(createJob,'material'),{leaseToken:createJob.leaseToken,materialId:material.id,materialRevision:material.revision});
  assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),material.file.mime);
  assert.equal(download.bytes.length,material.file.size);assert.equal(createHash('sha256').update(download.bytes).digest('hex'),material.file.sha256);
  error(await runner(f,device,jobPath(createJob,'material'),{leaseToken:createJob.leaseToken,materialId:material.id,materialRevision:material.revision+1}),403);
  const metaObjects=objects().map(o=>({...o,id:'meta-'+o.id,parentId:o.parentId?'meta-'+o.parentId:'',url:metaURL}));
  ok((await paused(f,device,createJob)).response);ok((await paused(f,device,createJob,{platform:'Meta',adObjects:metaObjects})).response);
  const preview=ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}})).preview;
  const enabled=ok(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:preview.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}}),201),job=await claim(f,device,enabled.item);
  ok(await preflight(f,device,job,{stage:'before_enable',existing:objects()}));const ticket=await intent(f,device,job,'enable'),proof=await evidence(f,device,job,'after_enable');
  ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'enabled_verified',objects:objects({campaign:{status:'enabled'},adGroup:{status:'enabled'},ad:{status:'enabled'}}),evidenceIds:[proof],message:'Synthetic Google enabled state.'}));
  ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Meta',outcome:'failed_before_publish',objects:[],evidenceIds:[],message:'Synthetic Meta failure before enable intent.'}));
  assert.equal((await details(f,enabled.item)).item.status,'failed');
  const again=ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}})).preview;
  assert.deepEqual(again.targetAccounts.map(a=>a.platform),['Meta']);assert.deepEqual(again.budgets.map(a=>a.platform),['Meta']);assert.ok(again.objects.every(o=>o.platform==='Meta'));
  const remaining=ok(await f.request(`/api/builds/${queued.item.id}/enable`,{method:'POST',actor:f.admin,body:{previewId:again.id,confirmation:'ENABLE_REVIEWED_OBJECTS'}}),201);
  assert.deepEqual(remaining.item.targets.map(a=>a.platform),['Meta']);
  const cancelled=ok(await f.request(`/api/builds/${remaining.item.id}/cancel`,{method:'POST',actor:f.admin,body:{}}));
  assert.equal(cancelled.item.status,'cancelled','cancelled enable jobs remain cancelled instead of being labelled failed');
  ok(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}}));
});

test('staged paused creation preserves prefix IDs, requires fresh checkpoints and completes only with the full hierarchy', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job));let ticket=await intent(f,device,job);
  let proof=await evidence(f,device,job,'after_publish');
  const first={leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,objects:objects().slice(0,1),evidenceIds:[proof]};
  const saved=ok(await runner(f,device,jobPath(job,'checkpoint'),first));
  assert.equal(saved.checkpoint.status,'paused_partial');assert.equal(saved.checkpoint.completed,false);assert.equal(saved.objects.length,1);assert.equal(saved.item.status,'running');
  error(await f.request(`/api/builds/${queued.item.id}/enable-preview`,{method:'POST',actor:f.admin,body:{}}),409);
  const eventCount=saved.events.length;
  assert.equal(ok(await runner(f,device,jobPath(job,'checkpoint'),first)).events.length,eventCount,'checkpoint response replay does not create another event or object');
  error(await runner(f,device,jobPath(job,'checkpoint'),{...first,objects:objects({campaign:{id:'replacement'}}).slice(0,1)}),409);
  error(await intentResponse(f,device,job),409,'checkpoint consumes the old intent and preflight');
  const missingProof=await evidence(f,device,job,'preflight');
  error(await runner(f,device,jobPath(job,'preflight'),{leaseToken:job.leaseToken,platform:'Google',observation:observation(),evidenceIds:[missingProof]}),[400,409],'known paused objects must be observed before another submit');
  const newPreflight=await evidence(f,device,job,'preflight');
  ok(await runner(f,device,jobPath(job,'preflight'),{leaseToken:job.leaseToken,platform:'Google',observation:observation({objects:objects().slice(0,1)}),evidenceIds:[newPreflight]}));
  error(await intentResponse(f,device,job),400,'before-publish screenshot from the previous stage cannot be reused');
  await evidence(f,device,job,'before_publish');ticket=await intent(f,device,job);proof=await evidence(f,device,job,'after_publish');
  const second={leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,objects:objects().slice(0,2),evidenceIds:[proof]};
  ok(await runner(f,device,jobPath(job,'checkpoint'),second));
  await f.restart();assert.equal((await details(f,queued.item)).objects.length,2,'partial remote objects survive restart');
  error(await preflight(f,device,job,{existing:objects({campaign:{id:'other'},adGroup:{parentId:'other'}}).slice(0,2)}),400);
  ok(await preflight(f,device,job,{existing:objects().slice(0,2)}));ticket=await intent(f,device,job);proof=await evidence(f,device,job,'after_publish');
  const result=ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,outcome:'paused_verified',objects:objects(),evidenceIds:[proof],message:'Synthetic staged completion.'}));
  assert.equal(result.item.status,'paused_verified');assert.equal(result.objects.length,3);
  assert.deepEqual(result.objects.map(o=>o.id),objects().map(o=>o.id));
});
async function intentResponse(f,device,job) {return runner(f,device,jobPath(job,'intent'),{leaseToken:job.leaseToken,platform:'Google',action:'publish_paused'});}

test('unknown staged submission must reconcile existing prefix objects before it can continue', {timeout:90000}, async t=>{
  let tick=Date.now();const f=await fixture(t,{executionClock:()=>tick,connectorClock:()=>tick}),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job));const ticket=await intent(f,device,job),proof=await evidence(f,device,job,'after_publish');
  ok(await runner(f,device,jobPath(job,'checkpoint'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,objects:objects().slice(0,1),evidenceIds:[proof]}));
  ok(await preflight(f,device,job,{existing:objects().slice(0,1)}));const second=await intent(f,device,job);
  ok(await runner(f,device,jobPath(job,'result'),{leaseToken:job.leaseToken,platform:'Google',intentToken:second.intentToken,outcome:'unknown',objects:[],evidenceIds:[],message:'Synthetic lost staged response.'}));
  error(await preflight(f,device,job,{existing:objects().slice(0,1)}),409);
  error(await intentResponse(f,device,job),409);
  const recoveryProof=await evidence(f,device,job,'reconcile');
  error(await runner(f,device,jobPath(job,'reconcile'),{leaseToken:job.leaseToken,platform:'Google',resolution:'not_found',objects:[],evidenceIds:[recoveryProof]}),409,'known paused campaign cannot be discarded');
  const restored=ok(await runner(f,device,jobPath(job,'reconcile'),{leaseToken:job.leaseToken,platform:'Google',resolution:'found_paused',objects:objects().slice(0,2),evidenceIds:[recoveryProof]}));
  assert.equal(restored.item.status,'running');assert.equal(restored.objects.length,2);
  ok(await preflight(f,device,job,{existing:objects().slice(0,2)}));await intent(f,device,job);
});

test('staged facts survive later edits but a changed plan cannot authorize the next external submit', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  ok(await preflight(f,device,job));const ticket=await intent(f,device,job),proof=await evidence(f,device,job,'after_publish');
  ok(await f.request(`/api/proposals/${state.item.id}`,{method:'PATCH',actor:f.admin,body:{expectedRevision:state.item.revision,brief:freshBrief({audienceDirection:'Changed synthetic direction'})}}));
  const result=ok(await runner(f,device,jobPath(job,'checkpoint'),{leaseToken:job.leaseToken,platform:'Google',intentToken:ticket.intentToken,objects:objects().slice(0,1),evidenceIds:[proof]}));
  assert.equal(result.objects.length,1);
  error(await preflight(f,device,job,{existing:objects().slice(0,1)}),[400,409]);
  error(await intentResponse(f,device,job),[400,409]);
});

async function pausedRequest(f,device,path,payload) {
  const bytes=Buffer.from(JSON.stringify(payload)),split=Math.floor(bytes.length/2),marker=randomUUID();let incoming,req;
  const seen=new Promise(resolve=>{const observe=r=>{if(r.headers['x-slow-execution-test']===marker){incoming=r;f.app.server.off('request',observe);resolve();}};f.app.server.on('request',observe);});
  const response=new Promise((resolve,reject)=>{req=httpRequest(f.baseURL+path,{method:'POST',headers:{Authorization:`Bearer ${device.token}`,'Content-Type':'application/json','Content-Length':bytes.length,'X-Slow-Execution-Test':marker,Connection:'close'}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{let data;try{data=JSON.parse(Buffer.concat(chunks));}catch{}resolve({status:res.statusCode,data});});res.on('error',reject);});req.on('error',reject);});
  response.catch(()=>{});req.flushHeaders();req.write(bytes.subarray(0,split));
  try {await Promise.race([seen,delay(3000).then(()=>{throw Error('slow browser request never reached server');})]);const until=Date.now()+3000;while(incoming.listenerCount('readable')===0&&incoming.readableFlowing!==true){assert.ok(Date.now()<until);await delay(5);}return {finish(){req.end(bytes.subarray(split));return response;},abort(){req.destroy();}};}catch(e){req.destroy();throw e;}
}
test('revoking a connector while evidence bytes are in flight prevents the old bearer from committing', {timeout:90000}, async t=>{
  const f=await fixture(t),device=await pairing(f),state=await prepared(f),queued=await enqueue(f,state,device),job=await claim(f,device,queued.item);
  const before=await details(f,queued.item);
  const slow=await pausedRequest(f,device,jobPath(job,'evidence'),{leaseToken:job.leaseToken,platform:'Google',stage:'preflight',mime:'image/png',base64:PNG,url:URL,caption:'Synthetic delayed evidence'});
  try {ok(await f.request(`/api/connectors/${device.connectorId}/revoke`,{method:'POST',actor:f.admin,body:{}}));error(await slow.finish(),[401,403],'bearer rechecked after entire body received');}finally{slow.abort();}
  const after=await details(f,queued.item);assert.equal(after.objects.length,before.objects.length);assert.ok(!after.evidence.some(e=>e.caption==='Synthetic delayed evidence'));
});
