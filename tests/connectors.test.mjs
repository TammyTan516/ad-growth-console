// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {request as httpRequest} from 'node:http';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture, ok, error, proposal, setupResources, CONTENT, freshBrief} from './phase34-fixture.mjs';

// Real HTTP/auth/SQLite tests. The runner is represented only at its authenticated
// protocol boundary; these scenarios never start Codex or read its credentials.
const HEALTH = {version: 'test-connector-1', codex: {available: true, authenticated: true, version: 'synthetic-codex'}};
const jobPath = item => `/api/proposals/${item.id}/generation/jobs`;
async function runner(f, device, route, body = {}, extra = {}) {
  return f.request(route, {method: 'POST', headers: {Authorization: `Bearer ${device.token}`, ...extra.headers}, body, ...(extra.origin !== undefined ? {origin: extra.origin} : {})});
}
async function pairing(f, actor = f.admin, {name = 'Synthetic personal computer', confirm = true, heartbeat = true} = {}) {
  const issued = ok(await f.request('/api/connectors/pairing', {method: 'POST', actor, body: {}}), 201);
  assert.equal(typeof issued.pairing.code, 'string');
  assert.ok(issued.pairing.expiresAt);
  const device = ok(await f.request('/api/connectors/exchange', {method: 'POST', body: {code: issued.pairing.code, deviceName: name}}), 201);
  assert.ok(device.connectorId && device.token);
  if (heartbeat) ok(await runner(f, device, '/api/runner/heartbeat', HEALTH));
  if (confirm) ok(await f.request(`/api/connectors/${device.connectorId}/confirm`, {method: 'POST', actor, body: {}}));
  return {...device, pairing: issued.pairing};
}
async function readyProposal(f, actor = f.admin) {
  const resources = await setupResources(f, actor), item = await proposal(f, actor);
  const state = ok(await f.request(`/api/proposals/${item.id}/workflow`, {method: 'PATCH', actor, body: {expectedRevision: item.revision, selection: resources.selection, content: CONTENT}}));
  return {...state, resources};
}
async function enqueue(f, state, device, actor = f.admin) {
  const response = await f.request(jobPath(state.item), {method: 'POST', actor, body: {expectedRevision: state.item.revision, connectorId: device.connectorId}});
  assert.ok([200,201].includes(response.status), `enqueue HTTP ${response.status}: ${response.data?.error?.message || ''}`);
  const result = response.data;
  assert.ok(result.job?.id && result.item?.id && result.workflow);
  assert.equal(result.job.status, 'queued');
  assert.equal(result.workflow.review.status, 'draft');
  assert.equal(result.workflow.contentBasis, null, 'starting a fresh generation requires a fresh review');
  return result;
}
async function claim(f, device) { return ok(await runner(f, device, '/api/runner/claim')).job; }
async function result(f, device, job, content = CONTENT) {
  return runner(f, device, `/api/runner/jobs/${job.id}/result`, {leaseToken: job.leaseToken, result: content});
}
async function jobs(f, item, actor = f.admin) { return ok(await f.request(jobPath(item), {actor})).items; }
async function current(f, item, actor = f.admin) { return ok(await f.request(`/api/proposals/${item.id}/workflow`, {actor})); }
function noSecret(value, ...secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), 'protocol secret must not appear in public metadata');
}

test('pairing is owner-bound, expires, is single-use and requires the signed-in owner to confirm the device', {timeout:90000}, async t => {
  let tick = Date.now();
  const f = await fixture(t, {connectorClock: () => tick});
  const editor = await f.invitedMember(f.admin, 'editor@example.com');
  const viewer = await f.invitedMember(f.admin, 'viewer@example.com', 'viewer');
  error(await f.request('/api/connectors/pairing', {method:'POST', body:{}}), 401);
  error(await f.request('/api/connectors/pairing', {method:'POST', actor:viewer, body:{}}), 403);
  const device = await pairing(f, editor, {confirm:false, heartbeat:false});
  error(await runner(f, device, '/api/runner/claim'), 403, 'pending devices cannot claim');
  error(await f.request(`/api/connectors/${device.connectorId}/confirm`, {method:'POST', actor:f.admin, body:{}}), [403,404], 'admin cannot confirm another user private Codex');
  error(await f.request('/api/connectors/exchange', {method:'POST', body:{code:device.pairing.code,deviceName:'Second machine'}}), [409,410], 'code cannot be consumed twice');
  ok(await runner(f, device, '/api/runner/heartbeat', HEALTH));
  ok(await f.request(`/api/connectors/${device.connectorId}/confirm`, {method:'POST', actor:editor, body:{}}));
  const mine = ok(await f.request('/api/connectors', {actor:editor}));
  assert.ok(mine.items.some(d => d.id === device.connectorId && d.status === 'active'));
  noSecret(mine, device.token, device.pairing.code);
  assert.equal(ok(await f.request('/api/connectors', {actor:f.admin})).items.length, 0, 'personal devices are not a shared team credential list');
  const tables = f.app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'app_connector%' OR name LIKE 'app_generation%')").all();
  const stored = tables.map(({name}) => f.app.db.prepare(`SELECT * FROM ${name}`).all());
  noSecret(stored, device.token, device.pairing.code, device.pairing.code.replace(/-/g,''));
  const expired = ok(await f.request('/api/connectors/pairing', {method:'POST', actor:editor, body:{}}), 201).pairing;
  tick += 6 * 60_000;
  error(await f.request('/api/connectors/exchange', {method:'POST', body:{code:expired.code,deviceName:'Late machine'}}), [409,410], 'expired pairing cannot create a device');
  error(await f.request('/api/connectors/exchange', {method:'POST', body:{code:'obviously-invalid-code',deviceName:'Unknown machine'}}), [400,403,410]);
});

test('runner credentials are narrowly scoped and membership/role/revocation is enforced for existing tokens', {timeout:90000}, async t => {
  const f = await fixture(t), editor = await f.invitedMember(f.admin, 'editor@example.com');
  const device = await pairing(f, editor);
  const outbound = await fetch(f.baseURL + '/api/runner/heartbeat', {method:'POST', headers:{Authorization:`Bearer ${device.token}`,'Content-Type':'application/json'},body:JSON.stringify(HEALTH),signal:AbortSignal.timeout(15000)});
  assert.equal(outbound.status,200,'native connector requests work without browser cookies or Origin');
  await outbound.arrayBuffer();
  error(await f.request('/api/resources', {headers:{Authorization:`Bearer ${device.token}`}}), 401, 'device bearer is not a browser/team session');
  error(await f.request('/api/runner/claim', {method:'POST', actor:editor, body:{}}), [401,403], 'browser cookie is not a device credential');
  error(await runner(f, device, '/api/runner/claim', {}, {origin:'https://example.com'}), 403, 'cross-site bearer request rejected');
  const alien = await f.outsider();
  error(await f.request(`/api/connectors/${device.connectorId}/revoke`, {method:'POST', actor:alien, body:{}}), [403,404]);
  ok(await f.request(`/api/members/${editor.me.user.id}`, {method:'PATCH', actor:f.admin, body:{role:'viewer'}}));
  error(await runner(f, device, '/api/runner/heartbeat', HEALTH), 403, 'role downgrade invalidates runner writes immediately');
  ok(await f.request(`/api/members/${editor.me.user.id}`, {method:'PATCH', actor:f.admin, body:{role:'editor'}}));
  ok(await runner(f, device, '/api/runner/heartbeat', HEALTH));
  ok(await f.request(`/api/members/${editor.me.user.id}`, {method:'PATCH', actor:f.admin, body:{status:'disabled'}}));
  error(await runner(f, device, '/api/runner/claim'), 403, 'disabled member cannot continue using a token');
  ok(await f.request(`/api/members/${editor.me.user.id}`, {method:'PATCH', actor:f.admin, body:{status:'active'}}));
  ok(await f.request(`/api/connectors/${device.connectorId}/revoke`, {method:'POST', actor:editor, body:{}}));
  error(await runner(f, device, '/api/runner/heartbeat', HEALTH), [401,403,410], 'revoked token is unusable');
});

test('one personal connector claims a job once and exact result retries do not overwrite or duplicate versions', {timeout:90000}, async t => {
  const f = await fixture(t), device = await pairing(f), state = await readyProposal(f);
  const enqueued = await enqueue(f, state, device);
  const secondary = await pairing(f,f.admin,{name:'Synthetic second personal computer'});
  assert.equal(await claim(f,secondary),null,'another device cannot steal a job assigned to this device');
  error(await f.request(jobPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:enqueued.item.revision,connectorId:secondary.connectorId}}),409,'one proposal cannot queue competing generation jobs');
  const attempts = await Promise.all([runner(f,device,'/api/runner/claim'),runner(f,device,'/api/runner/claim')]);
  for (const response of attempts) assert.ok([200,409].includes(response.status), 'concurrent claim remains a controlled result');
  const claims = attempts.filter(r => r.status === 200 && r.data.job);
  assert.equal(claims.length,1,'concurrent polling must produce a single leased claim');
  const job = claims[0].data.job;
  assert.equal(job.id,enqueued.job.id);
  assert.ok(job.leaseToken && job.prompt && job.schema);
  assert.ok(!job.prompt.includes('SYNTHETIC-CREATOR-CODE'));
  const summaries = await jobs(f,state.item);
  noSecret(summaries,device.token,job.leaseToken);
  assert.ok(!JSON.stringify(summaries).includes(job.prompt),'job summaries do not expose the private generation prompt');
  error(await runner(f,device,`/api/runner/jobs/${job.id}/result`,{leaseToken:'not-the-lease',result:CONTENT}),[400,403,409]);
  const before = await current(f,state.item);
  const committed = ok(await result(f,device,job));
  assert.equal(committed.status || committed.job?.status,'succeeded');
  const after = await current(f,state.item);
  assert.equal(after.item.revision,before.item.revision+1);
  assert.deepEqual(after.workflow.content,CONTENT);
  assert.equal(after.workflow.review.status,'draft','Codex can fill copy but cannot approve it');
  assert.equal(after.workflow.contentOrigin,'codex_connector');
  const history = ok(await f.request(`/api/proposals/${state.item.id}/versions`,{actor:f.admin})).items;
  ok(await result(f,device,job));
  assert.equal((await current(f,state.item)).item.revision,after.item.revision);
  assert.equal(ok(await f.request(`/api/proposals/${state.item.id}/versions`,{actor:f.admin})).items.length,history.length);
  error(await result(f,device,job,{...CONTENT,strategy:'A different replay payload'}),409,'same job cannot be replayed with different content');
  assert.equal((await claim(f,device)),null,'successful job cannot run again');
});

test('shared proposals cannot use another member connector and cancelled or obsolete generation results never replace saved copy', {timeout:90000}, async t => {
  const f = await fixture(t), device = await pairing(f), state = await readyProposal(f);
  const editor = await f.invitedMember(f.admin,'editor@example.com'), ownDevice = await pairing(f,editor);
  error(await f.request(jobPath(state.item),{method:'POST',actor:editor,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),[403,404]);
  const enqueued = await enqueue(f,state,device), job = await claim(f,device);
  error(await f.request(`/api/generation-jobs/${job.id}/cancel`,{method:'POST',actor:editor,body:{}}),[403,404]);
  error(await runner(f,ownDevice,`/api/runner/jobs/${job.id}/result`,{leaseToken:job.leaseToken,result:CONTENT}),[403,404]);
  ok(await f.request(`/api/generation-jobs/${job.id}/cancel`,{method:'POST',actor:f.admin,body:{}}));
  error(await result(f,device,job),[409,410]);
  const cancelled = await current(f,state.item);
  assert.deepEqual(cancelled.workflow.content,CONTENT,'cancelled generation does not erase existing text');
  const next = await enqueue(f,cancelled,device), nextJob = await claim(f,device);
  const updated = ok(await f.request(`/api/proposals/${state.item.id}`,{method:'PATCH',actor:editor,body:{expectedRevision:next.item.revision,brief:freshBrief({audienceDirection:'A newer saved direction'})}})).item;
  const staleReply = await result(f,device,nextJob,{...CONTENT,strategy:'Old in-flight output'});
  assert.ok([200,409,410].includes(staleReply.status));
  assert.equal((await current(f,state.item)).item.revision,updated.revision);
  assert.deepEqual((await current(f,state.item)).workflow.content,CONTENT);
  assert.equal((await jobs(f,state.item)).find(j => j.id===nextJob.id).status,'stale');
});

test('resource changes make in-flight generation stale, invalid output cannot bypass review, and audit failure rolls back auto-fill', {timeout:90000}, async t => {
  const f = await fixture(t), device = await pairing(f), state = await readyProposal(f);
  const beforeQueue = await current(f,state.item);
  f.app.db.exec("CREATE TRIGGER phase5_abort_queue BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic enqueue rollback'); END;");
  error(await f.request(jobPath(state.item),{method:'POST',actor:f.admin,body:{expectedRevision:state.item.revision,connectorId:device.connectorId}}),500);
  f.app.db.exec('DROP TRIGGER phase5_abort_queue');
  assert.deepEqual(await current(f,state.item),beforeQueue,'a failed enqueue must not strand a generation request');
  assert.deepEqual(await jobs(f,state.item),[],'a failed enqueue must not create a runnable orphan job');
  const enqueued = await enqueue(f,state,device), job = await claim(f,device);
  error(await result(f,device,job,{...CONTENT,review:{status:'approved'}}),400,'result schema does not accept a forged review');
  const before = await current(f,state.item);
  f.app.db.exec("CREATE TRIGGER phase5_abort_audit BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic audit rollback'); END;");
  error(await result(f,device,job),500);
  f.app.db.exec('DROP TRIGGER phase5_abort_audit');
  assert.deepEqual(await current(f,state.item),before,'no content or revision committed without its audit');
  ok(await result(f,device,job));
  const fresh = await current(f,state.item), another = await enqueue(f,fresh,device), anotherJob = await claim(f,device);
  ok(await f.request(`/api/landings/${state.resources.landing.id}`,{method:'PATCH',actor:f.admin,body:{expectedRevision:state.resources.landing.revision,name:'Changed page after generation started'}}));
  const stale = await result(f,device,anotherJob,{...CONTENT,strategy:'Generated with old page metadata'});
  assert.ok([200,409,410].includes(stale.status));
  assert.equal((await current(f,state.item)).item.revision,another.item.revision);
  assert.deepEqual((await current(f,state.item)).workflow.content,CONTENT);
  assert.equal((await jobs(f,state.item)).find(j=>j.id===anotherJob.id).status,'stale');
});

test('leases survive restart, expire without silent reruns and sanitized failures remain inspectable', {timeout:90000}, async t => {
  let tick=Date.now();
  const f=await fixture(t,{connectorClock:()=>tick}),device=await pairing(f),state=await readyProposal(f);
  const enqueued=await enqueue(f,state,device),job=await claim(f,device);
  error(await runner(f,device,`/api/runner/jobs/${job.id}/heartbeat`,{leaseToken:'incorrect-lease'}),[400,403,409]);
  tick+=45_000;
  ok(await runner(f,device,'/api/runner/heartbeat',HEALTH));
  ok(await runner(f,device,`/api/runner/jobs/${job.id}/heartbeat`,{leaseToken:job.leaseToken}));
  tick+=30_000;
  assert.equal((await jobs(f,state.item)).find(j=>j.id===job.id).status,'running','renewed lease remains live beyond its original expiry');
  await f.restart();
  assert.equal((await jobs(f,state.item)).find(j=>j.id===job.id).status,'running');
  tick+=2*60_000;
  ok(await runner(f,device,'/api/runner/heartbeat',HEALTH));
  const reclaimed=await claim(f,device);
  assert.equal(reclaimed,null,'expired lease must require explicit user retry, not spend Codex usage twice');
  assert.equal((await jobs(f,state.item)).find(j=>j.id===job.id).status,'needs_attention');
  error(await result(f,device,job),[409,410]);
  const retry=await enqueue(f,await current(f,state.item),device),retryJob=await claim(f,device);
  assert.notEqual(retry.job.id,enqueued.job.id);
  const failure=ok(await runner(f,device,`/api/runner/jobs/${retryJob.id}/failure`,{leaseToken:retryJob.leaseToken,code:'CODEX_FAILED',message:'sensitive stderr fake-token must not be stored'}));
  assert.equal(failure.status||failure.job?.status,'failed');
  const summary=(await jobs(f,state.item)).find(j=>j.id===retryJob.id);
  assert.equal(summary.status,'failed');
  assert.ok(!JSON.stringify(summary).includes('sensitive stderr'));
  assert.ok(!JSON.stringify(summary).includes('fake-token'));
  assert.deepEqual((await current(f,state.item)).workflow.content,CONTENT);
});

async function pausedRunnerResult(f,device,job) {
  const payload=Buffer.from(JSON.stringify({leaseToken:job.leaseToken,result:{...CONTENT,strategy:'A delayed in-flight generated result'}}));
  const split=Math.floor(payload.length/2),marker=randomUUID();
  let incoming;
  const seen=new Promise(resolve=>{
    const observe=req=>{if(req.headers['x-integration-slow-request']===marker){incoming=req;f.app.server.off('request',observe);resolve();}};
    f.app.server.on('request',observe);
  });
  let request;
  const response=new Promise((resolve,reject)=>{
    request=httpRequest(f.baseURL+`/api/runner/jobs/${job.id}/result`,{method:'POST',headers:{Authorization:`Bearer ${device.token}`,'Content-Type':'application/json','Content-Length':payload.length,'X-Integration-Slow-Request':marker,Connection:'close'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}resolve({status:res.statusCode,data});});res.on('error',reject);
    });
    request.on('error',reject);
  });
  response.catch(()=>{});request.flushHeaders();request.write(payload.subarray(0,split));
  try {
    await Promise.race([seen,delay(3000).then(()=>{throw Error('paused runner did not reach server');})]);
    const deadline=Date.now()+3000;
    while(incoming.listenerCount('readable')===0&&incoming.readableFlowing!==true){assert.ok(Date.now()<deadline,'runner authorized and awaits incomplete body');await delay(5);}
    return {finish(){request.end(payload.subarray(split));return response;},abort(){request.destroy();}};
  }catch(e){request.destroy();throw e;}
}

test('revoking membership or the device while result bytes are in flight cannot preserve old write access', {timeout:90000}, async t=>{
  const f=await fixture(t),editor=await f.invitedMember(f.admin,'slow-connector@example.com'),device=await pairing(f,editor),state=await readyProposal(f,editor);
  const enqueued=await enqueue(f,state,device,editor),job=await claim(f,device),before=await current(f,state.item);
  const slow=await pausedRunnerResult(f,device,job);
  try {
    ok(await f.request(`/api/members/${editor.me.user.id}`,{method:'PATCH',actor:f.admin,body:{status:'disabled'}}));
    error(await slow.finish(),403,'membership is rechecked after receiving the body');
  }finally{slow.abort();}
  assert.deepEqual(await current(f,state.item),before);
  ok(await f.request(`/api/members/${editor.me.user.id}`,{method:'PATCH',actor:f.admin,body:{status:'active'}}));
  const second=await pausedRunnerResult(f,device,job);
  try {
    ok(await f.request(`/api/connectors/${device.connectorId}/revoke`,{method:'POST',actor:editor,body:{}}));
    error(await second.finish(),[401,403],'revoked bearer is rechecked after receiving the body');
  }finally{second.abort();}
  assert.deepEqual(await current(f,state.item),before,'neither delayed result was allowed to create a new proposal version');
  assert.equal((await jobs(f,state.item)).find(j=>j.id===enqueued.job.id).status,'cancelled');
});
