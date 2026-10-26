// Local state/event audit only. No browser, network, real files, or account calls.
const fs=require('fs'),vm=require('vm'),path=require('path');
const original=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
const assert=(ok,message)=>{if(!ok)throw Error(message);};
function setup(savedState){
 const events={},windowEvents={},saveCalls=[];
 const status={textContent:'',hidden:true,dataset:{},setAttribute(){}};
 const root={innerHTML:'',addEventListener(type,fn,capture=false){(events[type]??=[]).push({fn,capture});},querySelectorAll(){return [];},querySelector(q){return q==='[data-save-status]'?status:null;}};
 const context={document:{getElementById:()=>root},window:{addEventListener(type,fn){windowEvents[type]=fn;},demoHost:{...(savedState?{widgetState:{privateContent:{version:1,state:savedState}}}:{}),setWidgetState(payload){saveCalls.push(payload);return Promise.resolve();}}},URL,TextEncoder};
 vm.createContext(context);
 const source=original.replace(/\nv2InitConsole\(s\);\nrender\(\);/,`\nv2InitConsole(s);render=()=>checkRevision();globalThis.audit={get state(){return s},fingerprint,generationFingerprint,approved,localErrors,assetErrors,v2R,v2Page,v2Freeze,v2Legacy,v2TrackingReady,v2TrackingConfirm,v2Rows,v2OwnTask,capturePlan,findPlan,persist,checkRevision,campaignRows,detailOptions:v2DetailOptions};`);
 assert(source!==original,'audit injection point missing');vm.runInContext(source,context);
 async function dispatch(type,target){let stopped=false;const event={target,stopImmediatePropagation(){stopped=true;}};for(const {fn} of (events[type]||[]).slice().sort((a,b)=>Number(b.capture)-Number(a.capture))){if(stopped)break;await fn(event);}}
 return {a:context.audit,status,saveCalls,
  async click(action,more={}){await dispatch('click',{closest:()=>({dataset:{action,...more}})});},
  async change(dataset,value,extra={}){const el={dataset,value,tagName:'SELECT',type:'select-one',hasAttribute(name){return Object.entries(dataset).some(([key])=>'data-'+key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())===name);},...extra};await dispatch('change',el);},
  async input(dataset,value){await dispatch('input',{dataset,value,hasAttribute(){return false;}});},
  emitState(state){windowEvents['demo:set_state']({detail:{globals:{widgetState:{privateContent:{version:1,writer:'audit-other',state}}}}});}
 };
}
async function configure(x,platforms=['Google']){
 for(const p of ['Google','Meta','TikTok'])await x.change({platform:p},undefined,{checked:platforms.includes(p)});
 await x.change({v2lp:'mode'},'library',{type:'radio'});
 await x.change({v2lp:'page'},'image');
 for(const p of platforms)if(p!=='Google')await x.change({v2lp:'detail',v2platform:p},x.a.detailOptions[p][0]);
 await x.click('asset-prepare');await x.click('generate');assert(x.a.state.generated,'generation failed: '+x.a.state.toast);
 await x.change({v2lp:'checked'},undefined,{type:'checkbox',checked:true});await x.click('v2lp-confirm');assert(x.a.v2TrackingReady(),'tracking not ready: '+x.a.state.toast);
 await x.click('approve-plan');assert(x.a.approved(),'review failed: '+x.a.state.toast);
}
async function claimAndBuild(x,scenario='complete'){
 await x.click('v2-submit-build');await x.click('v2-claim-build');await x.click('sim-ready');assert(x.a.state.ready,'preflight failed: '+x.a.state.toast);
 await x.change({v2Field:'v2Scenario'},scenario);await x.click('v2-run-build');
}
const tests=[];function test(name,fn){tests.push({name,fn});}
test('single platform: generation, UTM, review, owner, complete build and ID backfill',async()=>{
 const x=setup();await configure(x);const signature=x.a.fingerprint(),records=x.a.v2Rows().length;await x.click('v2lp-confirm');assert(x.a.v2Rows().length===records,'duplicate confirm duplicated records');await claimAndBuild(x);
 const s=x.a.state;assert(s.execution==='recovered'&&Object.keys(s.runObjects).join()==='Google','single-platform result mismatch');assert(x.a.v2OwnTask()&&x.a.fingerprint()===signature,'task identity changed');assert(x.a.v2Rows()[0].platformIds.adId===s.runObjects.Google.adId,'tracking platform ID not backfilled');assert(s.runSnapshot.plan.assetManifest.length===2&&s.runSnapshot.plan.tracking.ready,'complete audit snapshot missing');
});
test('blank campaign uses the selected default landing page without a manual page change',async()=>{
 const x=setup();await x.click('blank-plan');await x.input({field:'activity'},'Demo launch');await x.input({field:'audience'},'Users exploring a creative product');await x.change({platform:'Google'},undefined,{checked:true});await x.click('asset-select',{assetKey:'SUP-001@1'});await x.click('asset-prepare');await x.click('generate');assert(x.a.state.generated,'blank campaign generation failed');await x.change({v2lp:'checked'},undefined,{type:'checkbox',checked:true});await x.click('v2lp-confirm');await x.click('approve-plan');assert(x.a.approved(),'default landing did not reach review: '+x.a.state.toast);await claimAndBuild(x);assert(x.a.state.runObjects.Google,'blank campaign did not build');
});
test('task owner: another member cannot claim or execute an owned task',async()=>{
 const x=setup();await configure(x);await x.click('v2-submit-build');await x.click('v2-claim-build');const s=x.a.state;await x.change({demoUser:''},'同事');await x.change({assetMachine:''},'colleague-main');await x.click('asset-prepare');await x.click('v2-claim-build');assert(s.v2BuildTask.owner==='Alex','owner overwritten');await x.click('v2-run-build');assert(s.execution==='idle'&&!Object.keys(s.runObjects).length,'non-owner built objects');assert(x.a.approved(),'user switch lost reviewed content');
});
test('partial retry preserves successful objects and task owner',async()=>{
 const x=setup();await configure(x,['Google','Meta']);await claimAndBuild(x,'partial');const s=x.a.state,first=s.runObjects.Google.adId,task=s.v2BuildTask.id;assert(s.execution==='partial'&&!s.runObjects.Meta,'partial result wrong');await x.click('retry');assert(s.execution==='recovered'&&s.runObjects.Google.adId===first&&s.runObjects.Meta&&s.v2BuildTask.id===task,'retry duplicated/lost successful object');
});
test('non-owner cannot refresh preflight and retry another owner failed item through handlers',async()=>{
 const x=setup();await configure(x,['Google','Meta']);await claimAndBuild(x,'partial');const s=x.a.state;await x.change({demoUser:''},'同事');await x.change({assetMachine:''},'colleague-main');await x.click('asset-prepare');await x.click('sim-ready');await x.click('retry');assert(s.execution==='partial'&&!s.runObjects.Meta&&s.v2BuildTask.owner==='Alex','non-owner handler created failed item for '+s.runExecutors.Meta+' while task owner remains '+s.v2BuildTask.owner);
});
test('unknown blocks changes and duplicate build, then original owner resolves same content',async()=>{
 const x=setup();await configure(x);await claimAndBuild(x,'unknown');const s=x.a.state,fp=x.a.fingerprint(),task=s.v2BuildTask.id;assert(s.execution==='unknown','unknown branch missing');await x.click('blank-plan');await x.click('asset-select',{assetKey:'SUP-001@2'});await x.click('v2-run-build');assert(s.execution==='unknown'&&x.a.fingerprint()===fp&&s.v2BuildTask.id===task,'unknown allowed mutation/rebuild');await x.click('v2-resolve-unknown');assert(s.execution==='recovered'&&s.runObjects.Google&&s.v2BuildTask.id===task,'unknown resolution failed');
});
test('landing library refresh preserves reviewed selection and tracking',async()=>{
 const x=setup();await configure(x);const fp=x.a.fingerprint(),page=JSON.stringify(x.a.v2Page('Google')),code=x.a.v2Rows()[0].code;await x.click('v2lp-refresh');await x.click('v2lp-claim');await x.click('v2lp-complete');assert(x.a.approved()&&x.a.fingerprint()===fp&&JSON.stringify(x.a.v2Page('Google'))===page&&x.a.v2Rows()[0].code===code,'library refresh changed reviewed selection');
});
test('draft opening restores exact landing configuration; iteration restores historical page',async()=>{
 const x=setup();await configure(x);const s=x.a.state;await x.click('v2-save-draft');const id=s.v2DraftId;await x.change({v2lp:'page'},'home');await x.click('v2-open-draft',{draftId:id});assert(x.a.v2Page('Google').id==='image'&&!x.a.approved(),'draft page did not restore');
 await x.click('generate');await x.change({v2lp:'checked'},undefined,{type:'checkbox',checked:true});await x.click('v2lp-confirm');await x.click('approve-plan');await claimAndBuild(x);const version=s.version,old=JSON.stringify(s.runSnapshot.plan);await x.click('enable');await x.click('v2-sim-enabled');await x.click('v2-sim-delivery');await x.click('simulate-day');assert(s.simulatedReports['V'+version]?.metrics.Google,'daily simulation requires enabled/running state');await x.change({v2lp:'page'},'home');await x.change({reportField:'reportKey'},'run-'+version);await x.change({reportField:'iterationPlatform'},'Google');await x.change({reportField:'iterationAction'},'new-group');await x.change({iterationAck:''},undefined,{type:'checkbox',checked:true});await x.click('iterate');assert(s.iteration&&x.a.v2Page('Google').id==='image'&&s.picked.includes('SUP-001@1'),'iteration changed frozen inputs');assert(JSON.stringify(s.runHistory.find(h=>h.version===version).snapshot.plan)===old,'historical snapshot mutated');
});
test('old saved state and incoming old state migrate without inventing review snapshots',async()=>{
 const plan={picked:['supplier'],outputs:{Google:{title:'LEGACY'}}};const old={picked:['supplier'],platforms:['Google'],execution:'recovered',version:5,runIds:{Google:'OLD-AD'},runObjects:{Google:{campaignId:'OLD-CAM'}},runSnapshot:{plan}};const x=setup(old);assert(x.a.state.execution==='idle'&&!x.a.approved(),'old result treated as current reviewed');const history=x.a.state.runHistory.find(h=>h.version===5);assert(history.legacyAssets&&!history.snapshot.plan.assetManifest&&history.snapshot.plan.picked[0]==='supplier','migration fabricated old material snapshot');const y=setup();y.emitState({...old,version:7});assert(y.a.state.picked[0]==='SUP-001@1'&&y.a.state.runHistory.some(h=>h.version===7&&h.legacyAssets),'incoming old schema not migrated');
});
test('capacity warning leaves every full record intact and avoids save call',async()=>{
 const x=setup();await configure(x);await claimAndBuild(x);const s=x.a.state,plan=JSON.stringify(s.runSnapshot.plan),before=x.saveCalls.length;s.auditPadding='界'.repeat(20000);await x.a.persist();assert(x.saveCalls.length===before&&x.status.textContent.includes('本次未保存')&&x.status.textContent.includes('上次成功保存'),'oversize not visibly blocked');assert(s.execution==='recovered'&&JSON.stringify(s.runSnapshot.plan)===plan,'capacity handling changed execution/audit');delete s.auditPadding;
});
(async()=>{let failures=0;for(const item of tests){try{await item.fn();console.log('PASS '+item.name);}catch(error){failures++;console.log('FAIL '+item.name+': '+error.message);}}console.log(`${tests.length-failures}/${tests.length} scenarios passed; no full state output.`);process.exitCode=failures?1:0;})();
