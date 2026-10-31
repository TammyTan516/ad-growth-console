// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createGoogleAdsReader} from '../server/google-ads-reader.mjs';
import {createGoogleHttpsTransport} from '../server/google-https-transport.mjs';

const accountId = '1234567890', campaignId = '987654321';
const range = {startDate:'2026-10-25', endDate:'2026-10-26'};
const clock = () => Date.parse('2026-10-27T06:00:00Z');
const json = (data, status = 200, headers) => new Response(JSON.stringify(data), {status, headers});
const metadata = {customer:{id:accountId, descriptiveName:'Example workspace', currencyCode:'CNY', timeZone:'Asia/Shanghai', manager:false, email:'must-not-be-returned@example.com'}};
const campaign = {campaign:{id:campaignId, name:'Example campaign', status:'PAUSED', advertisingChannelType:'SEARCH', startDateTime:'2026-10-01 00:00:00'}};
const daily = (day = '2026-10-26') => ({campaign:{id:campaignId}, segments:{date:day}, metrics:{impressions:'100', clicks:'8', costMicros:'12345678', conversions:1.5, conversionsValue:19.5}});
const conversion = {campaign:{id:campaignId}, segments:{date:'2026-10-26', conversionAction:`customers/${accountId}/conversionActions/111222`, conversionActionName:'Registration', conversionActionCategory:'SIGNUP'}, metrics:{conversions:1.5, conversionsValue:19.5}};
function fixture(t, {credentials = {}, handle, env = {}} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'google-reader-test-'));
  t.after(() => rmSync(dir, {recursive:true, force:true}));
  const tokenPath = join(dir, 'oauth.json');
  writeFileSync(tokenPath, JSON.stringify({token:'fixture-access', expiry:'2030-01-01T00:00:00Z', client_id:'fixture-client', client_secret:'fixture-client-value', refresh_token:'fixture-refresh', token_uri:'https://oauth2.googleapis.com/token', scopes:['https://www.googleapis.com/auth/adwords'], ...credentials}), {mode:0o600});
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({auth_mode:'user_oauth', oauth_token_file:'oauth.json', google_ads_customer_ids:[accountId], google_ads_login_customer_id:'9999999999'}), {mode:0o600});
  const calls = [];
  async function fetchImpl(url, options) {
    calls.push({url, options});
    const supplied = await handle?.(url, options, calls);
    if (supplied) return supplied;
    if (url === 'https://oauth2.googleapis.com/token') return json({access_token:'refreshed-fixture-access', expires_in:3600});
    const {query} = JSON.parse(options.body);
    if (query.includes('FROM customer')) return json({results:[metadata]});
    if (query.includes('campaign.name')) return json({results:[campaign]});
    if (query.includes('segments.conversion_action')) return json({results:[conversion]});
    return json({results:[daily()]});
  }
  return {reader:createGoogleAdsReader({env:{GOOGLE_ADS_CONFIG_FILE:configPath, ...env}, fetchImpl, clock}), calls, configPath, tokenPath};
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('unconfigured reader reports no connection and cannot use arbitrary accounts', async () => {
  let calls = 0;
  const reader = createGoogleAdsReader({env:{}, fetchImpl:async () => {calls++;}});
  assert.equal(reader.status().configured, false);
  assert.equal(reader.status().readOnly, true);
  await rejects(reader.readAccount(accountId, range), 'GOOGLE_NOT_CONFIGURED');
  assert.equal(calls, 0);
});

test('complete read uses fixed Google search endpoint, follows pagination and preserves fractional conversions/micros', async t => {
  const f = fixture(t, {handle:async (url, options) => {
    if (url.includes('googleAds:search')) {
      const payload = JSON.parse(options.body);
      if (payload.query.includes('metrics.impressions')) return payload.pageToken ? json({results:[daily('2026-10-25')]}) : json({results:[daily()], nextPageToken:'second-page'});
    }
  }});
  const data = await f.reader.readAccount(accountId, range);
  assert.deepEqual(data.account, {id:accountId, name:'Example workspace', currency:'CNY', timeZone:'Asia/Shanghai'});
  assert.deepEqual(data.campaigns, [{id:campaignId, name:'Example campaign', status:'PAUSED', channelType:'SEARCH', startDate:'2026-10-01'}]);
  assert.ok(f.calls.some(c => JSON.parse(c.options.body).query.includes('campaign.start_date_time')));
  assert.equal(data.daily.length, 2);
  assert.equal(data.daily[0].costMicros, '12345678');
  assert.equal(data.daily[0].conversions, 1.5);
  assert.equal(data.conversionDaily[0].conversionActionId, '111222');
  assert.equal(data.conversionDaily[0].category, 'SIGNUP');
  for (const {url, options} of f.calls) {
    assert.equal(url, `https://googleads.googleapis.com/v25/customers/${accountId}/googleAds:search`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['login-customer-id'], '9999999999');
    assert.ok(JSON.parse(options.body).query.startsWith('SELECT '));
    assert.equal(JSON.parse(options.body).pageSize, undefined);
  }
  assert.ok(!JSON.stringify(data).includes('must-not-be-returned'));
  assert.ok(!JSON.stringify(data).includes('fixture-access'));
  assert.ok(!JSON.stringify(f.reader.status()).includes(f.configPath));
});

test('OAuth refresh stays in memory and never overwrites the private authorization file', async t => {
  const f = fixture(t, {credentials:{expiry:'2020-01-01T00:00:00Z'}});
  const before = readFileSync(f.tokenPath, 'utf8');
  await f.reader.readAccount(accountId, range);
  assert.equal(f.calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(new URLSearchParams(f.calls[0].options.body).get('grant_type'), 'refresh_token');
  assert.ok(f.calls.slice(1).every(c => c.options.headers.Authorization === 'Bearer refreshed-fixture-access'));
  assert.equal(readFileSync(f.tokenPath, 'utf8'), before);
});

test('invalid grant is an actionable sanitized error and performs no Ads reads', async t => {
  const f = fixture(t, {credentials:{expiry:'2020-01-01T00:00:00Z'}, handle:async () => json({error:'invalid_grant', error_description:'fixture-private-value must never appear'}, 400)});
  await assert.rejects(f.reader.readAccount(accountId, range), error => error.code === 'GOOGLE_AUTH_REQUIRED' && !error.message.includes('fixture-private-value'));
  assert.equal(f.calls.length, 1);
});

test('account allowlist, strict dates, date ordering and maximum31 days fail before any network request', async t => {
  const f = fixture(t);
  await rejects(f.reader.readAccount('8888888888', range), 'GOOGLE_ACCOUNT_NOT_ALLOWED');
  await rejects(f.reader.readAccount(accountId, {startDate:"2026-10-26' OR 1=1", endDate:'2026-10-26'}), 'GOOGLE_INVALID_DATE');
  await rejects(f.reader.readAccount(accountId, {startDate:'2026-02-30', endDate:'2026-03-01'}), 'GOOGLE_INVALID_DATE');
  await rejects(f.reader.readAccount(accountId, {startDate:'2026-10-27', endDate:'2026-10-26'}), 'GOOGLE_INVALID_DATE');
  await rejects(f.reader.readAccount(accountId, {startDate:'2026-09-01', endDate:'2026-10-26'}), 'GOOGLE_INVALID_DATE');
  assert.equal(f.calls.length, 0);
});

test('today cannot be reported as a complete day after the actual account time zone is read', async t => {
  const f = fixture(t);
  await rejects(f.reader.readAccount(accountId, {startDate:'2026-10-27', endDate:'2026-10-27'}), 'GOOGLE_INCOMPLETE_DAY');
  assert.equal(f.calls.length, 1);
});

test('redirects from either fixed Google endpoint are never followed with credentials', async t => {
  for (const expired of [false, true]) {
    const f = fixture(t, {credentials:expired ? {expiry:'2020-01-01T00:00:00Z'} : {}, handle:async () => new Response('', {status:302, headers:{Location:'https://untrusted.example/'}})});
    await rejects(f.reader.readAccount(accountId, range), 'GOOGLE_REDIRECT_BLOCKED');
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].options.redirect, 'manual');
  }
});

test('private token URI cannot send credentials to an arbitrary destination', async t => {
  const f = fixture(t, {credentials:{token_uri:'https://untrusted.example/token'}});
  await rejects(f.reader.readAccount(accountId, range), 'GOOGLE_CONFIG_INVALID');
  assert.equal(f.calls.length, 0);
});

test('repeated pages, mid-pagination failures and duplicate source rows never return partial success', async t => {
  const repeated = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('campaign.name') ? json({results:[campaign], nextPageToken:'repeated'}) : undefined});
  await rejects(repeated.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
  const partial = fixture(t, {handle:async (url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.query?.includes('metrics.impressions')) return payload.pageToken ? json({error:{message:'sensitive provider message'}}, 503) : json({results:[daily()], nextPageToken:'pending'});
  }});
  await rejects(partial.reader.readAccount(accountId, range), 'GOOGLE_UNAVAILABLE');
  const duplicate = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('metrics.impressions') ? json({results:[daily(), daily()]}) : undefined});
  await rejects(duplicate.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
});

test('protobuf omitted scalar zeros are legitimate only within validated successful rows; malformed metrics fail', async t => {
  const zero = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('metrics.impressions') ? json({results:[{campaign:{id:campaignId}, segments:{date:'2026-10-26'}, metrics:{}}]}) : undefined});
  const data = await zero.reader.readAccount(accountId, range);
  assert.deepEqual(data.daily[0], {date:'2026-10-26', campaignId, impressions:0, clicks:0, costMicros:'0', conversions:0, conversionValue:0});
  const invalid = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('metrics.impressions') ? json({results:[{...daily(), metrics:{costMicros:'99999999999999999999'}}]}) : undefined});
  await rejects(invalid.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
});

test('wrong account metadata or report rows outside the requested range reject the complete batch', async t => {
  const wrongAccount = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('FROM customer') ? json({results:[{customer:{...metadata.customer, id:'8888888888'}}]}) : undefined});
  await rejects(wrongAccount.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
  const wrongDate = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('metrics.impressions') ? json({results:[daily('2026-10-24')]}) : undefined});
  await rejects(wrongDate.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
});

test('campaign start date remains unknown when omitted and invalid calendar dates cannot be reported as verified', async t => {
  const missing = fixture(t, {handle:async (url, options) => {
    if (JSON.parse(options.body).query?.includes('campaign.name')) {
      const {startDateTime, ...withoutDate} = campaign.campaign;
      return json({results:[{campaign:withoutDate}]});
    }
  }});
  assert.equal(Object.hasOwn((await missing.reader.readAccount(accountId, range)).campaigns[0], 'startDate'), false);
  const invalid = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('campaign.name') ? json({results:[{campaign:{...campaign.campaign, startDateTime:'2026-02-30 00:00:00'}}]}) : undefined});
  await rejects(invalid.reader.readAccount(accountId, range), 'GOOGLE_INVALID_DATE');
});

test('v23+ reads account-local start timestamps while older configured versions use the legacy date', async t => {
  for (const version of ['v23', 'v25']) {
    const f = fixture(t, {env:{GOOGLE_ADS_API_VERSION:version}});
    const data = await f.reader.readAccount(accountId, range);
    assert.equal(data.campaigns[0].startDate, '2026-10-01');
    assert.ok(f.calls.some(c => JSON.parse(c.options.body).query.includes('campaign.start_date_time')));
  }
  const legacy = fixture(t, {env:{GOOGLE_ADS_API_VERSION:'v22'}, handle:async (url, options) => {
    if (JSON.parse(options.body).query?.includes('campaign.name')) {
      const {startDateTime, ...fields} = campaign.campaign;
      return json({results:[{campaign:{...fields, startDate:'2026-10-01'}}]});
    }
  }});
  assert.equal((await legacy.reader.readAccount(accountId, range)).campaigns[0].startDate, '2026-10-01');
  assert.ok(legacy.calls.some(c => JSON.parse(c.options.body).query.includes('campaign.start_date FROM')));
  for (const timestamp of ['2026-10-01T00:00:00Z', '2026-10-01 24:00:00', '2026-10-01 12:60:00', '2026-10-01']) {
    const invalid = fixture(t, {handle:async (url, options) => JSON.parse(options.body).query?.includes('campaign.name') ? json({results:[{campaign:{...campaign.campaign, startDateTime:timestamp}}]}) : undefined});
    await rejects(invalid.reader.readAccount(accountId, range), 'GOOGLE_INVALID_RESPONSE');
  }
});

test('proxy configuration is validated without exposing its URL or credentials', async t => {
  for (const value of ['socks5://fixture-secret@127.0.0.1:9999', 'http://127.0.0.1/path?fixture-secret', 'http://127.0.0.1/#fixture-secret', 'invalid-fixture-secret']) {
    const f = fixture(t, {env:{GOOGLE_ADS_HTTPS_PROXY:value}});
    assert.equal(f.reader.status().configured, false);
    assert.equal(f.reader.status().error.code, 'GOOGLE_CONFIG_INVALID');
    assert.ok(!JSON.stringify(f.reader.status()).includes('fixture-secret'));
    await rejects(f.reader.readAccount(accountId, range), 'GOOGLE_CONFIG_INVALID');
    assert.equal(f.calls.length, 0);
  }
  const injected = fixture(t, {env:{GOOGLE_ADS_HTTPS_PROXY:'http://127.0.0.1:1'}});
  assert.equal((await injected.reader.readAccount(accountId, range)).daily.length, 1);
});

test('scoped HTTPS transport uses CONNECT only for fixed Google hosts, preserves global networking and never falls back direct', async t => {
  const proxy = createServer();
  const connections = [];
  proxy.on('connect', (req, socket) => {
    connections.push({url:req.url, headers:req.headers});
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const beforeProxy = process.env.HTTPS_PROXY;
  const transport = createGoogleHttpsTransport(`http://127.0.0.1:${proxy.address().port}`);
  const options = {method:'POST', headers:{Authorization:'Bearer private-google-fixture'}, body:'{}', signal:AbortSignal.timeout(2000)};
  for (const url of ['https://example.com/token', 'http://oauth2.googleapis.com/token', 'https://oauth2.googleapis.com/other', 'https://googleads.googleapis.com/v25/customers/1234567890/campaigns:mutate']) {
    await assert.rejects(transport(url, options), /destination rejected/);
  }
  assert.equal(connections.length, 0);
  await assert.rejects(transport(`https://googleads.googleapis.com/v25/customers/${accountId}/googleAds:search`, options));
  assert.equal(connections.length, 1);
  assert.equal(connections[0].url, 'googleads.googleapis.com:443');
  assert.equal(connections[0].headers.authorization, undefined);
  assert.equal(process.env.HTTPS_PROXY, beforeProxy);
  const f = fixture(t);
  const reader = createGoogleAdsReader({env:{GOOGLE_ADS_CONFIG_FILE:f.configPath, GOOGLE_ADS_HTTPS_PROXY:`http://127.0.0.1:${proxy.address().port}`}, clock});
  await assert.rejects(reader.readAccount(accountId, range), error => error.code === 'GOOGLE_UNAVAILABLE' && !error.message.includes('private-google-fixture') && !error.message.includes('127.0.0.1'));
  assert.equal(connections.length, 2);
});
