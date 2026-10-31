// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, stat, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {writePrivate, readPrivate} from '../runner/client.mjs';
import {createBrowserBridge, createBrowserTransport, parseBrowserArgs, runBrowserCommand, validatePlatformUrl, MAX_EVIDENCE_BYTES} from '../runner/browser-client.mjs';

const TOKEN = 'a'.repeat(48), LEASE = 'b'.repeat(48), INTENT = 'c'.repeat(48), ORIGIN = 'http://127.0.0.1:9999';
const BUILD = 'build-example', JOB = 'browser-example';
const future = () => new Date(Date.now() + 300000).toISOString();
const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const url = 'https://ads.google.com/aw/campaigns?campaignId=123';
const target = {platform: 'Google', status: 'queued'};
const object = {level: 'campaign', id: '123', parentId: '', status: 'paused', url};
const observation = {accountId: '123-456-7890', currency: 'USD', timeZone: 'America/Los_Angeles', campaignType: 'search', parentCampaignId: '', canPublishPaused: true, pausedScopes: ['campaign', 'adGroup', 'ad'], url};
const job = () => ({id: JOB, kind: 'create_paused', leaseToken: LEASE, expiresAt: future(), targets: [target], snapshot: {title: 'Synthetic reviewed advertising plan'}, objects: []});
async function fixture(t, handler = () => ({})) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-client-test-')); t.after(() => rm(dir, {force: true, recursive: true}));
  await writePrivate(dir, 'connector.json', {schemaVersion: 1, server: ORIGIN, connectorId: 'connector-example', token: TOKEN, owner: {id: 'owner-example'}, team: {id: 'team-example'}});
  const calls = [];
  const fetchImpl = async (endpoint, options) => {
    const body = JSON.parse(options.body); const call = {endpoint, options, body}; calls.push(call);
    const response = await handler(call, calls);
    return response instanceof Response ? response : Response.json(response);
  };
  return {dir, calls, fetchImpl, bridge: await createBrowserBridge({stateDir: dir, fetchImpl})};
}
const claimFirst = handler => call => call.endpoint.endsWith('/claim') ? {job: job()} : handler(call);
async function saved(f) {return readPrivate(join(f.dir, 'browser-jobs'), BUILD + '.json');}
function noSecrets(value) {const serialized = JSON.stringify(value); for (const key of [TOKEN, LEASE, INTENT]) assert.ok(!serialized.includes(key));}

test('browser bridge reads only the paired app credential and privately persists claimed leases', async t => {
  const f = await fixture(t, () => ({job: {...job(), snapshot: {title: 'Synthetic', accessToken: TOKEN}, unexpected: 'ignored'}}));
  const result = await f.bridge.claim(BUILD); noSecrets(result);
  assert.equal(result.id, JOB); assert.deepEqual(result.targets, [target]); assert.equal(result.snapshot.title, 'Synthetic');
  assert.ok(!Object.hasOwn(result, 'leaseToken')); assert.ok(!Object.hasOwn(result.snapshot, 'accessToken')); assert.ok(!Object.hasOwn(result, 'unexpected'));
  const privateState = await saved(f); assert.equal(privateState.leaseToken, LEASE); assert.equal(privateState.connectorId, 'connector-example');
  const call = f.calls[0]; assert.equal(call.endpoint, ORIGIN + '/api/runner/browser/claim'); assert.deepEqual(call.body, {buildId: BUILD});
  assert.equal(call.options.headers.Authorization, 'Bearer ' + TOKEN); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.redirect, 'manual');
  assert.ok(!Object.keys(call.options.headers).some(k => /cookie/i.test(k)));
  if (process.platform !== 'win32') assert.equal((await stat(join(f.dir, 'browser-jobs', BUILD + '.json'))).mode & 0o777, 0o600);
  await assert.rejects(createBrowserBridge({stateDir: f.dir, server: 'https://another.example', fetchImpl: f.fetchImpl}), e => e.code === 'SERVER_MISMATCH');
});

test('transport allows only exact browser task routes, refuses redirects, bounds errors and sends no cookies', async () => {
  const calls = [];
  const transport = createBrowserTransport(ORIGIN, TOKEN, {fetchImpl: async (...args) => {calls.push(args); return new Response('', {status: 302, headers: {Location: 'https://another.example'}});}});
  for (const path of ['/api/runner/claim', '/api/runner/browser/jobs/../intent', '/api/runner/browser/jobs/x/intent?x=1', '//another.example/api/runner/browser/claim', '/api/runner/browser/jobs/x/delete']) await assert.rejects(transport(path), e => e.code === 'INVALID_ROUTE');
  assert.equal(calls.length, 0);
  await assert.rejects(transport('/api/runner/browser/claim'), e => e.code === 'REDIRECT_BLOCKED'); assert.equal(calls.length, 1);
  const failure = createBrowserTransport(ORIGIN, TOKEN, {fetchImpl: async () => Response.json({error: {code: 'NO_ACCESS', message: TOKEN}}, {status: 403})});
  await assert.rejects(failure('/api/runner/browser/claim'), e => e.code === 'NO_ACCESS' && e.status === 403 && !e.message.includes(TOKEN));
  assert.throws(() => createBrowserTransport('http://workspace.example', TOKEN));
});

test('evidence accepts explicit bounded PNG/JPEG files and only the selected provider URL', async t => {
  const f = await fixture(t, claimFirst(() => ({id: 'evidence-example', evidence: {id: 'evidence-example', platform: 'Google', stage: 'preflight'}, filePath: '/private/ignored', leaseToken: LEASE})));
  await f.bridge.claim(BUILD); const file = join(f.dir, 'screenshot.png'); await writeFile(file, png);
  const result = await f.bridge.evidence(BUILD, {platform: 'Google', stage: 'preflight', file, url, note: 'Synthetic screenshot'}); noSecrets(result);
  assert.equal(result.id, 'evidence-example'); assert.ok(!Object.hasOwn(result, 'filePath'));
  assert.deepEqual(f.calls.at(-1).body, {leaseToken: LEASE, platform: 'Google', stage: 'preflight', mime: 'image/png', base64: png.toString('base64'), url, caption: 'Synthetic screenshot'});
  const requests = f.calls.length;
  for (const bad of [{platform: 'Meta'}, {url: 'https://evil.example'}, {url: 'https://ads.google.com.evil.example'}, {stage: 'anything'}, {file: 'relative.png'}]) await assert.rejects(f.bridge.evidence(BUILD, {platform: 'Google', stage: 'preflight', file, url, ...bad}));
  await writeFile(file, 'This is not an image'); await assert.rejects(f.bridge.evidence(BUILD, {platform: 'Google', stage: 'preflight', file, url}), e => e.code === 'INVALID_IMAGE');
  await writeFile(file, Buffer.alloc(MAX_EVIDENCE_BYTES + 1)); await assert.rejects(f.bridge.evidence(BUILD, {platform: 'Google', stage: 'preflight', file, url}), e => e.code === 'INVALID_FILE');
  assert.equal(f.calls.length, requests);
  assert.equal(validatePlatformUrl('https://business.facebook.com/adsmanager', 'Meta'), 'https://business.facebook.com/adsmanager');
  for (const value of ['https://ads.google.com:9443/x', 'http://ads.google.com', 'https://' + 'user:pass@' + 'ads.google.com', 'https://facebook.com', 'https://ads.google.com/?access_token=synthetic', 'https://ads.google.com/#access_token=synthetic']) assert.throws(() => validatePlatformUrl(value, 'Google'));
});

test('preflight validates account observations before transport and does not accept credentials in JSON input', async t => {
  const f = await fixture(t, claimFirst(() => ({status: 'ready', platform: 'Google'}))); await f.bridge.claim(BUILD);
  assert.equal((await f.bridge.preflight(BUILD, 'Google', {observation, evidenceIds: ['evidence-example']})).status, 'ready');
  assert.deepEqual(f.calls.at(-1).body, {leaseToken: LEASE, platform: 'Google', observation: {...observation, accountId: '1234567890'}, evidenceIds: ['evidence-example']});
  const requests = f.calls.length;
  for (const input of [{observation, evidenceIds: [], leaseToken: 'injected'}, {observation: {...observation, canPublishPaused: 'yes'}, evidenceIds: []}, {observation: {...observation, pausedScopes: ['campaign', 'campaign']}, evidenceIds: []}, {observation: {...observation, url: 'https://ads.tiktok.com'}, evidenceIds: []}]) await assert.rejects(f.bridge.preflight(BUILD, 'Google', input));
  assert.equal(f.calls.length, requests);
});

test('intent tokens stay private, result uses the saved scoped intent and unknown outcome requires reconciliation', async t => {
  const f = await fixture(t, claimFirst(call => call.endpoint.endsWith('/intent') ? {intentToken: INTENT, expiresAt: future(), instructions: 'Create paused only', scope: {accountId: '123-456-7890'}, extraToken: TOKEN} : {status: 'recorded', outcome: call.body.outcome, resolution: call.body.resolution, objects: call.body.objects}));
  await f.bridge.claim(BUILD);
  await assert.rejects(f.bridge.result(BUILD, 'Google', {outcome: 'paused_verified', objects: [object], evidenceIds: [], message: ''}), e => e.code === 'NO_BROWSER_INTENT');
  const intent = await f.bridge.intent(BUILD, 'Google', 'publish_paused'); noSecrets(intent); assert.equal(intent.action, 'publish_paused'); assert.equal((await saved(f)).intents.Google.token, INTENT);
  await assert.rejects(f.bridge.result(BUILD, 'Google', {outcome: 'enabled_verified', objects: [{...object, status: 'enabled'}], evidenceIds: [], message: ''}), e => e.code === 'WRONG_BROWSER_INTENT');
  const input = {outcome: 'unknown', objects: [], evidenceIds: ['evidence-example'], message: 'Submit response was lost'};
  await f.bridge.result(BUILD, 'Google', input); assert.equal(f.calls.at(-1).body.intentToken, INTENT);
  await assert.rejects(f.bridge.intent(BUILD, 'Google', 'publish_paused'), e => e.code === 'RECONCILE_REQUIRED');
  await f.bridge.reconcile(BUILD, 'Google', {resolution: 'still_unknown', objects: [], evidenceIds: ['evidence-example']});
  await assert.rejects(f.bridge.intent(BUILD, 'Google', 'publish_paused'), e => e.code === 'RECONCILE_REQUIRED');
  await f.bridge.reconcile(BUILD, 'Google', {resolution: 'not_found', objects: [], evidenceIds: ['evidence-example']});
  const after = await saved(f); assert.equal(after.intents.Google, undefined); await f.bridge.intent(BUILD, 'Google', 'publish_paused');
});

test('lost result response preserves exact report for retry and blocks a changed report or new publish', async t => {
  let lose = true;
  const f = await fixture(t, claimFirst(call => {if (call.endpoint.endsWith('/intent')) return {intentToken: INTENT, expiresAt: future()}; if (call.endpoint.endsWith('/result') && lose) {lose = false; throw new Error('synthetic private network detail');} return {status: 'paused_verified'};}));
  await f.bridge.claim(BUILD); await f.bridge.intent(BUILD, 'Google', 'publish_paused');
  const result = {outcome: 'paused_verified', objects: [object], evidenceIds: ['evidence-example'], message: ''};
  await assert.rejects(f.bridge.result(BUILD, 'Google', result), e => e.code === 'NETWORK_ERROR' && !e.message.includes('private network'));
  assert.equal((await saved(f)).pendingReports.Google.outcome, 'paused_verified');
  await assert.rejects(f.bridge.intent(BUILD, 'Google', 'publish_paused'), e => e.code === 'RECONCILE_REQUIRED');
  await assert.rejects(f.bridge.result(BUILD, 'Google', {...result, outcome: 'unknown'}), e => e.code === 'PENDING_RESULT_CHANGED');
  await f.bridge.result(BUILD, 'Google', result); assert.equal((await saved(f)).pendingReports.Google, undefined);
  const reports = f.calls.filter(c => c.endpoint.endsWith('/result')); assert.equal(reports.length, 2); assert.deepEqual(reports[0].body, reports[1].body);
});

test('staged paused checkpoints use private intents, verify acknowledgement and allow a fresh next-stage intent', async t => {
  const f = await fixture(t, claimFirst(call => call.endpoint.endsWith('/intent') ? {intentToken: INTENT, expiresAt: future()} : {status:'running', checkpoint:{platform:call.body.platform,status:'paused_partial',objects:call.body.objects,completed:false}, unexpectedToken:INTENT}));
  await f.bridge.claim(BUILD);
  const input={objects:[object],evidenceIds:['evidence-example']};
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',input),e=>e.code==='NO_BROWSER_INTENT');
  await f.bridge.intent(BUILD,'Google','publish_paused');
  const before=f.calls.length;
  for(const bad of [{...input,intentToken:INTENT},{objects:[],evidenceIds:['evidence-example']},{objects:[{...object,status:'enabled'}],evidenceIds:['evidence-example']},{objects:[object],evidenceIds:[]}]) await assert.rejects(f.bridge.checkpoint(BUILD,'Google',bad));
  assert.equal(f.calls.length,before);
  const result=await f.bridge.checkpoint(BUILD,'Google',input);noSecrets(result);
  assert.deepEqual(result.checkpoint.objects,[object]);assert.equal(result.checkpoint.completed,false);
  assert.deepEqual(f.calls.at(-1).body,{leaseToken:LEASE,platform:'Google',intentToken:INTENT,...input});
  assert.equal((await saved(f)).intents.Google,undefined);assert.equal((await saved(f)).pendingCheckpoints.Google,undefined);
  await f.bridge.intent(BUILD,'Google','publish_paused');assert.ok(f.calls.at(-1).endpoint.endsWith('/intent'));
});

test('a lost checkpoint receipt retains exact objects and blocks another creation until replay is acknowledged', async t=>{
  let lose=true;
  const f=await fixture(t,claimFirst(call=>{
    if(call.endpoint.endsWith('/intent'))return{intentToken:INTENT,expiresAt:future()};
    if(call.endpoint.endsWith('/checkpoint')&&lose){lose=false;throw Error('Synthetic checkpoint response lost');}
    return{checkpoint:{platform:call.body.platform,status:'paused_partial',objects:call.body.objects,completed:false}};
  }));
  await f.bridge.claim(BUILD);await f.bridge.intent(BUILD,'Google','publish_paused');
  const input={objects:[object],evidenceIds:['evidence-example']};
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',input),e=>e.code==='NETWORK_ERROR');
  assert.deepEqual((await saved(f)).pendingCheckpoints.Google.objects,[object]);
  await assert.rejects(f.bridge.intent(BUILD,'Google','publish_paused'),e=>e.code==='RECONCILE_REQUIRED');
  await assert.rejects(f.bridge.preflight(BUILD,'Google',{observation,evidenceIds:['evidence-example']}),e=>e.code==='CHECKPOINT_PENDING');
  await assert.rejects(f.bridge.result(BUILD,'Google',{outcome:'unknown',objects:[],evidenceIds:[],message:''}),e=>e.code==='CHECKPOINT_PENDING');
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',{...input,objects:[{...object,id:'different-campaign'}]}),e=>e.code==='PENDING_CHECKPOINT_CHANGED');
  await f.bridge.checkpoint(BUILD,'Google',input);
  const attempts=f.calls.filter(c=>c.endpoint.endsWith('/checkpoint'));assert.equal(attempts.length,2);assert.deepEqual(attempts[0].body,attempts[1].body);
  assert.equal((await saved(f)).pendingCheckpoints.Google,undefined);assert.equal((await saved(f)).intents.Google,undefined);
});

test('invalid checkpoint acknowledgement cannot release an intent or drop the durable receipt', async t=>{
  const f=await fixture(t,claimFirst(call=>call.endpoint.endsWith('/intent')?{intentToken:INTENT,expiresAt:future()}:{status:'running'}));
  await f.bridge.claim(BUILD);await f.bridge.intent(BUILD,'Google','publish_paused');
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',{objects:[object],evidenceIds:['evidence-example']}),e=>e.code==='INVALID_CHECKPOINT_ACK');
  assert.equal((await saved(f)).intents.Google.token,INTENT);assert.ok((await saved(f)).pendingCheckpoints.Google);
  await assert.rejects(f.bridge.intent(BUILD,'Google','publish_paused'),e=>e.code==='RECONCILE_REQUIRED');
});

test('a checkpoint outbox survives reclaim and replays with the new lease without discarding known objects', async t=>{
  let claims=0,lose=true;const renewedLease='d'.repeat(48);
  const f=await fixture(t,call=>{
    if(call.endpoint.endsWith('/claim'))return{job:{...job(),leaseToken:++claims===1?LEASE:renewedLease}};
    if(call.endpoint.endsWith('/intent'))return{intentToken:INTENT,expiresAt:future()};
    if(call.endpoint.endsWith('/checkpoint')&&lose){lose=false;throw Error('Synthetic response lost');}
    return{checkpoint:{platform:call.body.platform,status:'paused_partial',objects:call.body.objects,completed:false}};
  });
  await f.bridge.claim(BUILD);await f.bridge.intent(BUILD,'Google','publish_paused');
  const input={objects:[object],evidenceIds:['evidence-example']};
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',input));
  await f.bridge.claim(BUILD);
  assert.deepEqual((await saved(f)).pendingCheckpoints.Google.objects,[object]);
  await assert.rejects(f.bridge.intent(BUILD,'Google','publish_paused'),e=>e.code==='RECONCILE_REQUIRED');
  await f.bridge.checkpoint(BUILD,'Google',input);
  const attempts=f.calls.filter(c=>c.endpoint.endsWith('/checkpoint'));
  assert.equal(attempts[0].body.leaseToken,LEASE);assert.equal(attempts[1].body.leaseToken,renewedLease);
  assert.equal(attempts[1].body.intentToken,INTENT);assert.deepEqual(attempts[0].body.objects,attempts[1].body.objects);
  assert.equal((await saved(f)).pendingCheckpoints.Google,undefined);
});

test('reconciliation retains an uncertain checkpoint until the server confirms paused objects',async t=>{
  const f=await fixture(t,claimFirst(call=>{
    if(call.endpoint.endsWith('/intent'))return{intentToken:INTENT,expiresAt:future()};
    if(call.endpoint.endsWith('/checkpoint'))throw Error('Synthetic lost checkpoint');
    if(call.endpoint.endsWith('/reconcile'))return{status:call.body.resolution==='still_unknown'?'unknown':'running',item:{targets:[{platform:'Google',status:call.body.resolution==='still_unknown'?'unknown':'claimed'}]}};
    return{};
  }));
  await f.bridge.claim(BUILD);await f.bridge.intent(BUILD,'Google','publish_paused');
  await assert.rejects(f.bridge.checkpoint(BUILD,'Google',{objects:[object],evidenceIds:['evidence-example']}));
  await f.bridge.reconcile(BUILD,'Google',{resolution:'still_unknown',objects:[],evidenceIds:['fresh-proof']});
  assert.ok((await saved(f)).pendingCheckpoints.Google);
  await f.bridge.reconcile(BUILD,'Google',{resolution:'found_paused',objects:[object],evidenceIds:['fresh-proof']});
  assert.equal((await saved(f)).pendingCheckpoints.Google,undefined);assert.equal((await saved(f)).intents.Google,undefined);
  await f.bridge.intent(BUILD,'Google','publish_paused');
});

test('checkpoint CLI uses only the dedicated route and cannot apply to an enable task', async t=>{
  const f=await fixture(t,claimFirst(call=>call.endpoint.endsWith('/intent')?{intentToken:INTENT,expiresAt:future()}:{checkpoint:{platform:call.body.platform,status:'paused_partial',objects:call.body.objects,completed:false}}));
  await f.bridge.claim(BUILD);await f.bridge.intent(BUILD,'Google','publish_paused');
  const file=join(f.dir,'checkpoint.json');await writeFile(file,JSON.stringify({objects:[object],evidenceIds:['evidence-example']}));
  const result=await runBrowserCommand(['checkpoint','--build',BUILD,'--platform','Google','--file',file,'--state-dir',f.dir],{fetchImpl:f.fetchImpl});
  noSecrets(result);assert.ok(f.calls.at(-1).endpoint.endsWith('/checkpoint'));
  assert.throws(()=>parseBrowserArgs(['checkpoint','--build',BUILD,'--platform','Google']));
  const enabled=await fixture(t,()=>({job:{...job(),kind:'enable'}}));await enabled.bridge.claim(BUILD);
  const requests=enabled.calls.length;await assert.rejects(enabled.bridge.checkpoint(BUILD,'Google',{objects:[object],evidenceIds:['evidence-example']}),e=>e.code==='CHECKPOINT_SCOPE_MISMATCH');
  assert.equal(enabled.calls.length,requests);
});

test('heartbeat renews a lease, expired leases and another connector state cannot mutate remotely', async t => {
  const extended = new Date(Date.now() + 600000).toISOString();
  const f = await fixture(t, claimFirst(() => ({expiresAt: extended, status: 'running'}))); await f.bridge.claim(BUILD);
  const renewal = await f.bridge.heartbeat(BUILD); assert.equal(renewal.expiresAt, extended); assert.equal((await saved(f)).expiresAt, extended);
  const state = await saved(f); state.expiresAt = new Date(0).toISOString(); await writePrivate(join(f.dir, 'browser-jobs'), BUILD + '.json', state);
  const requests = f.calls.length; await assert.rejects(f.bridge.heartbeat(BUILD), e => e.code === 'BROWSER_LEASE_EXPIRED'); assert.equal(f.calls.length, requests);
  state.expiresAt = future(); state.connectorId = 'other-connector'; await writePrivate(join(f.dir, 'browser-jobs'), BUILD + '.json', state);
  await assert.rejects(f.bridge.heartbeat(BUILD), e => e.code === 'NO_BROWSER_LEASE'); assert.equal(f.calls.length, requests);
});

test('CLI requires specific command arguments, bounds JSON files and never accepts arbitrary routes or tokens', async t => {
  for (const args of [['execute', '--build', BUILD], ['intent', '--build', BUILD], ['claim', '--build', '../x'], ['claim', '--build', BUILD, '--token', TOKEN], ['claim', '--build', BUILD, '--platform', 'Google'], ['claim', '--build', BUILD, '--build', BUILD]]) assert.throws(() => parseBrowserArgs(args));
  assert.equal(parseBrowserArgs([]).command, 'help');
  const f = await fixture(t, claimFirst(() => ({status: 'ready'}))); await f.bridge.claim(BUILD);
  const file = join(f.dir, 'input.json'); await writeFile(file, JSON.stringify({observation, evidenceIds: ['evidence-example']}));
  const result = await runBrowserCommand(['preflight', '--build', BUILD, '--platform', 'Google', '--file', file, '--state-dir', f.dir], {fetchImpl: f.fetchImpl}); assert.equal(result.status, 'ready');
  await writeFile(file, JSON.stringify({observation, evidenceIds: [], intentToken: INTENT}));
  await assert.rejects(runBrowserCommand(['preflight', '--build', BUILD, '--platform', 'Google', '--file', file, '--state-dir', f.dir], {fetchImpl: f.fetchImpl}), e => e.code === 'INVALID_INPUT');
  assert.ok((await runBrowserCommand(['help'])).includes('桌面 Codex'));
});


test('enable preflight requires observed existing objects and forbids a create intent', async t => {
  const f = await fixture(t, call => call.endpoint.endsWith('/claim') ? {job: {...job(), kind: 'enable', objects: [object]}} : {status: 'ready'});
  await f.bridge.claim(BUILD);
  await assert.rejects(f.bridge.preflight(BUILD, 'Google', {observation, evidenceIds: ['evidence-example']}), e => e.code === 'ENABLE_OBJECTS_REQUIRED');
  const observed = {...observation, objects: [object]};
  await f.bridge.preflight(BUILD, 'Google', {observation: observed, evidenceIds: ['evidence-example']}); assert.deepEqual(f.calls.at(-1).body.observation.objects, [object]);
  await assert.rejects(f.bridge.intent(BUILD, 'Google', 'publish_paused'), e => e.code === 'WRONG_BROWSER_ACTION');
});

test('material download verifies reviewed version, MIME, exact size and SHA256 before exposing a private cache path', async t => {
  const sha256 = createHash('sha256').update(png).digest('hex'), file = {name: 'synthetic.png', size: png.length, mime: 'image/png', sha256};
  const material = {id: 'material-example', revision: 3, kind: 'material', file};
  const f = await fixture(t, call => call.endpoint.endsWith('/claim') ? {job: {...job(), snapshot: {selectionSnapshot: {materials: [material]}}}} : new Response(png, {headers: {'Content-Type': 'image/png', 'Content-Length': String(png.length)}}));
  await f.bridge.claim(BUILD);
  await assert.rejects(f.bridge.material(BUILD, material.id, 2), e => e.code === 'MATERIAL_NOT_IN_TASK');
  await assert.rejects(f.bridge.material(BUILD, '../other', 3), e => e.code === 'INVALID_ID');
  const downloaded = await f.bridge.material(BUILD, material.id, 3); noSecrets(downloaded);
  assert.equal(downloaded.cached, false); assert.equal(downloaded.sha256, sha256); assert.equal(downloaded.file, join(f.dir, 'browser-assets', sha256 + '.png')); assert.deepEqual(await readFile(downloaded.file), png);
  assert.deepEqual(f.calls.at(-1).body, {leaseToken: LEASE, materialId: material.id, materialRevision: 3}); assert.ok(f.calls.at(-1).endpoint.endsWith('/material'));
  const requests = f.calls.length, cached = await f.bridge.material(BUILD, material.id, 3); assert.equal(cached.cached, true); assert.equal(f.calls.length, requests);
  if (process.platform !== 'win32') {assert.equal((await stat(downloaded.file)).mode & 0o777, 0o600); assert.equal((await stat(join(f.dir, 'browser-assets'))).mode & 0o777, 0o700);}
  await writeFile(downloaded.file, Buffer.alloc(png.length));
  assert.equal((await f.bridge.material(BUILD, material.id, 3)).cached, false); assert.equal(f.calls.length, requests + 1);
});

test('invalid material bytes, MIME and redirects never expose a cache path or persist a partial file', async t => {
  const sha256 = createHash('sha256').update(png).digest('hex'), material = {id: 'material-example', revision: 1, file: {size: png.length, mime: 'image/png', sha256}};
  for (const response of [() => new Response(Buffer.alloc(png.length), {headers: {'Content-Type': 'image/png'}}), () => new Response(png, {headers: {'Content-Type': 'video/mp4'}}), () => new Response(png, {headers: {'Content-Type': 'image/png', 'Content-Length': '999'}}), () => new Response('', {status: 307, headers: {Location: 'https://other.example'}})]) {
    const f = await fixture(t, call => call.endpoint.endsWith('/claim') ? {job: {...job(), snapshot: {selectionSnapshot: {materials: [material]}}}} : response());
    await f.bridge.claim(BUILD); await assert.rejects(f.bridge.material(BUILD, material.id, 1), e => ['MATERIAL_MISMATCH', 'REDIRECT_BLOCKED'].includes(e.code));
    assert.deepEqual(await readdir(join(f.dir, 'browser-assets')), []);
  }
});


test('explicit lock recovery never clears a live process and does not call the advertising task API', async t => {
  const f = await fixture(t, () => ({job: job()})); await f.bridge.claim(BUILD);
  const lockDir = join(f.dir, 'browser-jobs', 'locks', BUILD), record = {pid: process.pid, token: 'synthetic-lock-token-12345'};
  await writePrivate(lockDir, 'runner.lock', record);
  const count = f.calls.length;
  await assert.rejects(f.bridge.claim(BUILD), e => e.code === 'BROWSER_COMMAND_BUSY');
  await assert.rejects(f.bridge.unlock(BUILD), e => e.code === 'RUNNER_ALREADY_RUNNING');
  await writePrivate(lockDir, 'runner.lock', {...record, pid: 2147483647});
  await assert.rejects(f.bridge.claim(BUILD), e => e.code === 'BROWSER_COMMAND_STALE');
  assert.deepEqual(await f.bridge.unlock(BUILD), {id: BUILD, cleared: true}); assert.equal(f.calls.length, count);
});
