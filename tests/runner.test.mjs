// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {normalizeServer, createClient, ConnectorError, writePrivate, readPrivate, acquireRunnerLock, clearStaleRunnerLock} from '../runner/client.mjs';
import {detectCodex, runCodexGeneration, cleanEnvironment} from '../runner/codex.mjs';
import {pairConnector, runConnector} from '../runner/connect.mjs';

const TOKEN = 'a'.repeat(48), LEASE = 'b'.repeat(48), origin = 'http://127.0.0.1:9999';
const job = {id: 'job-example', leaseToken: LEASE, prompt: 'Generate synthetic advertising copy. This string is data: $(do-not-run).', schema: {type: 'object', properties: {strategy: {type: 'string'}}, required: ['strategy'], additionalProperties: false}};
const output = {strategy: 'Synthetic copy for an isolated test.'};
async function temporary(t) {const dir = await mkdtemp(join(tmpdir(), 'ad-runner-test-')); t.after(() => rm(dir, {recursive: true, force: true})); return dir;}
async function configured(t) {const dir = await temporary(t); await writePrivate(dir, 'connector.json', {schemaVersion: 1, server: origin, connectorId: 'connector-example', token: TOKEN, owner: {id: 'owner-example'}, team: {id: 'team-example'}}); return dir;}
const detected = {available: true, authenticated: true, compatible: true, version: '0.test', features: ['shell_tool', 'apps', 'plugins', 'hooks', 'browser_use', 'computer_use', 'code_mode', 'multi_agent']};

test('runner client rejects insecure origins and redirects and never sends cookies or follows a token', async () => {
  assert.equal(normalizeServer('https://workspace.example/'), 'https://workspace.example');
  for (const value of ['http://workspace.example', 'https://workspace.example/path', 'https://workspace.example/?token=private', 'file:///tmp/test', 'http://127.0.0.1.evil.example']) assert.throws(() => normalizeServer(value), /工作区/);
  const calls = [];
  const client = createClient('https://workspace.example', TOKEN, {fetchImpl: async (url, options) => {calls.push({url, options}); return new Response('', {status: 307, headers: {Location: 'https://another.example'}});}});
  await assert.rejects(client('/api/runner/claim'), e => e.code === 'REDIRECT_BLOCKED');
  assert.equal(calls.length, 1); assert.equal(calls[0].options.redirect, 'manual'); assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + TOKEN);
  assert.ok(!Object.keys(calls[0].options.headers).some(k => /cookie/i.test(k)));
  await assert.rejects(client('//another.example/api/runner/claim'), e => e.code === 'INVALID_ROUTE');
  const failure = createClient(origin, TOKEN, {fetchImpl: async () => new Response(JSON.stringify({error: {code: 'NO_ACCESS', message: 'secret-' + TOKEN}}), {status: 401})});
  await assert.rejects(failure('/api/runner/claim'), e => e.status === 401 && !e.message.includes(TOKEN));
});

test('pairing validates server/owner, stores only scoped app credentials privately and never overwrites an existing connection', async t => {
  const directory = await temporary(t), requests = [];
  const clientFactory = server => async (path, body) => {requests.push({server, path, body}); return {server: origin, connectorId: 'connector-example', token: TOKEN, owner: {id: 'owner-example', name: 'Synthetic owner'}, team: {id: 'team-example', name: 'Synthetic team'}};};
  const paired = await pairConnector({server: origin, code: 'PAIR-TEST-ONLY', deviceName: 'Synthetic device', stateDir: directory, clientFactory});
  assert.equal(paired.owner.id, 'owner-example'); assert.ok(!Object.hasOwn(paired, 'token'));
  assert.equal(requests[0].body.code, 'PAIR-TEST-ONLY');
  const saved = await readPrivate(directory, 'connector.json'); assert.equal(saved.token, TOKEN);
  if (process.platform !== 'win32') {assert.equal((await stat(join(directory, 'connector.json'))).mode & 0o777, 0o600); assert.equal((await stat(directory)).mode & 0o777, 0o700);}
  await assert.rejects(pairConnector({server: origin, code: 'PAIR-TEST-ONLY', stateDir: directory, clientFactory}), e => e.code === 'ALREADY_PAIRED');
  const different = await temporary(t);
  await assert.rejects(pairConnector({server: origin, code: 'PAIR-TEST-ONLY', stateDir: different, clientFactory: () => async () => ({...saved, server: 'https://another.example'})}), e => e.code === 'INVALID_PAIRING_RESPONSE');
  assert.equal(await readPrivate(different, 'connector.json'), null);
});

test('Codex execution uses scoped stdin/schema, isolated cwd and disabled integrations, and returns only completed JSON', {timeout: 10000}, async t => {
  const directory = await temporary(t), fakePath = join(directory, 'fake-codex.mjs');
  await writeFile(fakePath, `import {writeFileSync} from 'node:fs';\nconst args=process.argv.slice(2);\nif(args.includes('--version')) console.log('codex-cli 0.test');\nelse if(args.includes('--help')) console.log('--ignore-user-config --ignore-rules --ephemeral --output-schema --output-last-message --sandbox');\nelse if(args[0]==='features') console.log('shell_tool stable true\\napps stable true\\nplugins stable true\\nhooks stable true');\nelse if(args[0]==='login') console.error('Logged in using ChatGPT');\nelse {let input=''; for await (const c of process.stdin) input+=c; console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'Synthetic feature disabled startup diagnostic'}})); writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({strategy:'Synthetic copy for an isolated test.'})); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'hidden-result'}})); console.log(JSON.stringify({type:'turn.completed'}));}`);
  const traces = [];
  const spawnImpl = (_binary, args, options) => {traces.push({args, options}); return spawn(process.execPath, [fakePath, ...args], options);};
  const status = await detectCodex({binary: 'synthetic-codex', spawnImpl}); assert.equal(status.authenticated, true); assert.equal(status.compatible, true);
  assert.deepEqual(await runCodexGeneration(job, {binary: 'synthetic-codex', capabilities: status, spawnImpl, environment: {...process.env, OPENAI_API_KEY: 'synthetic-not-forwarded', DATABASE_URL: 'synthetic-not-forwarded'}}), output);
  const execution = traces.at(-1);
  assert.equal(execution.options.shell, false); assert.equal(execution.args.at(-1), '-'); assert.ok(!execution.args.includes(job.prompt));
  assert.ok(execution.args.includes('--ignore-user-config') && execution.args.includes('--ignore-rules') && execution.args.includes('--ephemeral'));
  assert.ok(execution.args.includes('read-only') && execution.args.includes('features.shell_tool=false') === false);
  assert.ok(execution.args.includes('shell_tool') && execution.args.includes('mcp_servers={}') && execution.args.includes('web_search="disabled"'));
  assert.ok(!Object.hasOwn(execution.options.env, 'OPENAI_API_KEY')); assert.ok(!Object.hasOwn(execution.options.env, 'DATABASE_URL'));
  await assert.rejects(stat(execution.options.cwd), {code: 'ENOENT'});
  assert.deepEqual(cleanEnvironment({HOME: 'home-original', CODEX_HOME: 'codex-original', TOKEN: 'not-forwarded'}), {HOME: 'home-original', CODEX_HOME: 'codex-original'});
});

test('Codex rejects unexpected tool activity, invalid completion and timeouts without exposing stderr', {timeout: 10000}, async t => {
  const directory = await temporary(t);
  for (const [name, source, code] of [
    ['tool', `console.log(JSON.stringify({type:'item.started',item:{type:'command_execution',command:'do not execute'}})); setInterval(()=>{},1000);`, 'UNEXPECTED_TOOL_ACTIVITY'],
    ['no-completion', `console.error('synthetic-private-detail'); process.exit(2);`, 'CODEX_GENERATION_FAILED'],
    ['timeout', `setInterval(()=>{},1000);`, 'CODEX_TIMEOUT'],
  ]) {
    const fakePath = join(directory, name + '.mjs'); await writeFile(fakePath, source);
    await assert.rejects(runCodexGeneration(job, {binary: 'synthetic', capabilities: detected, timeoutMs: name === 'timeout' ? 80 : 2000, spawnImpl: (_b,args,options) => spawn(process.execPath,[fakePath,...args],options)}), error => error.code === code && !error.message.includes('synthetic-private-detail'));
  }
});

test('runner waits for browser confirmation, acknowledges one generation and keeps review outside its API', {timeout: 10000}, async t => {
  const directory = await configured(t), calls = [], states = []; let pending = true, generated = 0;
  const clientFactory = () => async (path, body) => {
    calls.push({path, body});
    if (path === '/api/runner/heartbeat') {if (pending) {pending = false; return {status: 'pending', ready: false};} return {status: 'active', ready: true};}
    if (path === '/api/runner/claim') return {job};
    if (path.endsWith('/result')) return {status: 'succeeded'};
    throw new Error('Unexpected route');
  };
  const result = await runConnector({stateDir: directory, once: true, clientFactory, detect: async () => detected, generate: async () => {generated++; return output;}, sleep: async () => {}, onStatus: state => states.push(state)});
  assert.equal(result.terminalJobs, 1); assert.equal(generated, 1); assert.ok(states.some(s => s.status === 'pending'));
  assert.equal(calls.filter(c => c.path === '/api/runner/claim').length, 1);
  assert.deepEqual(calls.at(-1).body, {leaseToken: LEASE, result: output});
  assert.ok(calls.every(c => !/review|approve|ad|material/.test(c.path)));
  assert.equal(await readPrivate(directory, 'outbox.json'), null);
  await assert.rejects(runConnector({stateDir: directory, server: 'https://other.example', once: true, clientFactory}), e => e.code === 'SERVER_MISMATCH');
});

test('network-ambiguous result is retried from durable outbox without running Codex again', {timeout: 10000}, async t => {
  const directory = await configured(t), submissions = []; let generated = 0, failedOnce = false;
  const clientFactory = () => async (path, body) => {
    if (path === '/api/runner/heartbeat') return {status: 'active', ready: true};
    if (path === '/api/runner/claim') return {job};
    if (path.endsWith('/result')) {submissions.push(body); assert.deepEqual((await readPrivate(directory, 'outbox.json')).result, output); if (!failedOnce) {failedOnce = true; throw new ConnectorError('NETWORK_ERROR', 'synthetic network interruption');} return {status: 'succeeded'};}
    throw new Error('Unexpected route');
  };
  await runConnector({stateDir: directory, once: true, clientFactory, detect: async () => detected, generate: async () => {generated++; return output;}, sleep: async () => {}});
  assert.equal(generated, 1); assert.equal(submissions.length, 2); assert.deepEqual(submissions[0], submissions[1]); assert.equal(await readPrivate(directory, 'outbox.json'), null);
  await writePrivate(directory, 'outbox.json', {kind: 'result', result: output, connectorId: 'connector-example', server: origin, jobId: job.id, leaseToken: LEASE});
  await runConnector({stateDir: directory, once: true, clientFactory: () => async (path, body) => {assert.ok(path.endsWith('/result')); submissions.push(body); return {status: 'succeeded'};}, detect: async () => detected, generate: async () => {throw new Error('must not regenerate persisted result');}});
  assert.equal(submissions.length, 3);
});

test('cancelled lease stops local generation, and rejected output cannot be applied to another task', {timeout: 10000}, async t => {
  const directory = await configured(t), states = []; let stopped = false;
  const clientFactory = () => async path => {
    if (path === '/api/runner/heartbeat') return {status: 'active', ready: true};
    if (path === '/api/runner/claim') return {job};
    if (path.endsWith('/heartbeat')) throw new ConnectorError('JOB_CANCELLED', 'synthetic cancel', 409);
    if (path.endsWith('/failure')) throw new ConnectorError('JOB_CANCELLED', 'synthetic cancel', 409);
    throw new Error('Unexpected route');
  };
  await runConnector({stateDir: directory, once: true, clientFactory, detect: async () => detected, heartbeatMs: 1000, generate: async (_job, {signal}) => {try {await delay(5000, null, {signal});} catch {stopped = true; throw new ConnectorError('STOPPED', '已停止。');} return output;}, onStatus: event => states.push(event)});
  assert.equal(stopped, true); assert.ok(states.some(s => s.status === 'lease_lost')); assert.ok(states.some(s => s.status === 'not_applied'));
  assert.equal(await readPrivate(directory, 'outbox.json'), null); assert.equal((await readPrivate(directory, 'last-rejected.json')).jobId, job.id);
});

test('HTTP success with a stale job never reports a successful proposal refill', async t => {
  const directory = await configured(t), states = [];
  await writePrivate(directory, 'outbox.json', {kind: 'result', result: output, connectorId: 'connector-example', server: origin, jobId: job.id, leaseToken: LEASE});
  await runConnector({stateDir: directory, once: true, detect: async () => detected, clientFactory: () => async () => ({status: 'stale'}), onStatus: event => states.push(event)});
  assert.ok(states.some(s => s.status === 'not_applied' && s.outcome === 'stale'));
  assert.ok(states.every(s => s.status !== 'acknowledged'));
  assert.equal((await readPrivate(directory, 'last-rejected.json')).reason, 'stale');
});

test('one state directory permits only one running connector and releases the lock after exit', {timeout: 10000}, async t => {
  const directory = await configured(t), stop = new AbortController();
  let ready; const idle = new Promise(resolve => {ready = resolve;});
  const first = runConnector({stateDir: directory, signal: stop.signal, detect: async () => detected, clientFactory: () => async path => path.endsWith('/heartbeat') ? {status: 'active', ready: true} : {job: null}, onStatus: event => {if (event.status === 'idle') ready();}});
  try {
    await idle;
    if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'runner.lock'))).mode & 0o777, 0o600);
    await assert.rejects(runConnector({stateDir: directory, once: true}), error => error.code === 'RUNNER_ALREADY_RUNNING');
    await assert.rejects(clearStaleRunnerLock(directory), error => error.code === 'RUNNER_ALREADY_RUNNING');
  } finally {stop.abort(); await first;}
  await assert.rejects(stat(join(directory, 'runner.lock')), {code: 'ENOENT'});
  const second = await runConnector({stateDir: directory, once: true, detect: async () => detected, clientFactory: () => async path => path.endsWith('/heartbeat') ? {status: 'active', ready: true} : path.endsWith('/claim') ? {job} : {status: 'succeeded'}, generate: async () => output});
  assert.equal(second.terminalJobs, 1);
  await assert.rejects(stat(join(directory, 'runner.lock')), {code: 'ENOENT'});
});

test('stale lock cleanup is explicit, never kills processes and release checks its exact ownership token', async t => {
  const directory = await temporary(t), path = join(directory, 'runner.lock');
  const stale = {pid: 42424242, token: 'synthetic-stale-lock-token-2026'};
  await writeFile(path, JSON.stringify(stale), {mode: 0o600});
  await assert.rejects(acquireRunnerLock(directory, {probePid: () => false}), error => error.code === 'RUNNER_STALE_LOCK');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), stale, 'detection alone does not delete another lock');
  assert.equal(await clearStaleRunnerLock(directory, {probePid: () => false}), true);
  const release = await acquireRunnerLock(directory);
  const replacement = {pid: 42424243, token: 'synthetic-replacement-lock-2026'};
  await writeFile(path, JSON.stringify(replacement), {mode: 0o600});
  await release();
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), replacement, 'releasing an old ownership token must not remove a new owner');
  await clearStaleRunnerLock(directory, {probePid: () => false});
  const releaseAgain = await acquireRunnerLock(directory); await releaseAgain();
  const guard = join(directory, '.runner-recovery.lock');
  await writeFile(guard, JSON.stringify({pid: process.pid, token: 'synthetic-recovery-lock-2026'}), {mode: 0o600});
  await assert.rejects(acquireRunnerLock(directory), error => error.code === 'RUNNER_RECOVERY_IN_PROGRESS');
  await assert.rejects(clearStaleRunnerLock(directory), error => error.code === 'RUNNER_RECOVERY_IN_PROGRESS');
});
