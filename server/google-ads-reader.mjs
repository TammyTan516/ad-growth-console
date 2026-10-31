// SPDX-License-Identifier: MIT
// Read-only Google Ads REST reporting. Credentials remain in private local files.
// https://developers.google.com/google-ads/api/docs/reporting/overview
// https://developers.google.com/google-ads/api/docs/reporting/paging
// Search is fixed to Google's endpoint; callers cannot supply URLs or GAQL.
import {readFileSync, statSync} from 'node:fs';
import {dirname, isAbsolute, resolve} from 'node:path';
import {AppError} from './errors.mjs';
import {createGoogleHttpsTransport} from './google-https-transport.mjs';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const ADS_ORIGIN = 'https://googleads.googleapis.com';
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const MAX_PAGES = 20, MAX_ROWS = 200000, DAY = 86400000;
const fail = (code, message, status = 502) => {throw new AppError(status, code, message);};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function id(value) {
  const result = typeof value === 'string' ? value.replaceAll('-', '') : '';
  if (!/^\d{10}$/.test(result)) fail('GOOGLE_INVALID_ACCOUNT', '请使用有效的 Google Ads 子账户编号。', 400);
  return result;
}
function remoteId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^\d{1,30}$/.test(value)) fail('GOOGLE_INVALID_RESPONSE', 'Google 数据中的对象编号不完整。');
  return value;
}
function readJSON(path, max = 128 * 1024) {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > max) throw new Error('invalid file');
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!plain(parsed)) throw new Error('invalid JSON');
    return parsed;
  } catch {fail('GOOGLE_CONFIG_INVALID', 'Google 数据连接的私有配置无法读取，请由部署者检查。', 503);}
}
function privatePath(value, base) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f]/.test(value)) fail('GOOGLE_CONFIG_INVALID', 'Google 数据连接的私有文件位置未配置完整。', 503);
  return isAbsolute(value) ? value : resolve(base, value);
}
function validSecret(value) {return typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/[\u0000-\u001f\u007f]/.test(value);}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('GOOGLE_INVALID_DATE', '请选择有效的日报日期。', 400);
  return value;
}
function dateInZone(time, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(time);
    const part = type => parts.find(p => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {fail('GOOGLE_INVALID_RESPONSE', 'Google 账户时区无法确认，未生成日报。');}
}
function string(value, fallback = '', max = 500) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('GOOGLE_INVALID_RESPONSE', 'Google 返回的名称或状态格式不正确。');
  return value;
}
function numeric(value, {integer = false, positive = false} = {}) {
  // Google REST/protobuf omits default scalar zeros. This applies only inside a
  // successfully received, validated row; failures never become zero reports.
  if (value === undefined) return 0;
  if (!['number','string'].includes(typeof value) || value === '' || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(Number(value))) || (positive && Number(value) < 0)) fail('GOOGLE_INVALID_RESPONSE', 'Google 返回的指标格式不正确。');
  return Number(value);
}
function cost(value) {
  if (value === undefined) return '0';
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,19}$/.test(text) || BigInt(text) > 9223372036854775807n) fail('GOOGLE_INVALID_RESPONSE', 'Google 返回的费用格式不正确。');
  return BigInt(text).toString();
}
async function responseJSON(response, maxBytes) {
  try {
    const chunks = []; let length = 0;
    for await (const chunk of response.body || []) {
      length += chunk.length;
      if (length > maxBytes) {await response.body?.cancel().catch(() => {}); fail('GOOGLE_RESPONSE_TOO_LARGE', 'Google 返回的数据过多，请缩短日期范围。');}
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!plain(parsed)) throw new Error('invalid JSON');
    return parsed;
  } catch (error) {
    if (error instanceof AppError) throw error;
    fail('GOOGLE_INVALID_RESPONSE', 'Google 返回的数据不完整，请稍后重新读取。');
  }
}

export function createGoogleAdsReader({env = process.env, fetchImpl, clock = Date.now} = {}) {
  let settings, configurationError, transport = fetchImpl || fetch;
  try {
    if (env.GOOGLE_ADS_CONFIG_FILE) {
      const configFile = privatePath(env.GOOGLE_ADS_CONFIG_FILE, process.cwd());
      const config = readJSON(configFile);
      if (config.auth_mode !== 'user_oauth' || !Array.isArray(config.google_ads_customer_ids) || !config.google_ads_customer_ids.length || config.google_ads_customer_ids.length > 20) fail('GOOGLE_CONFIG_INVALID', '请配置用户 OAuth 和允许读取的广告账户。', 503);
      const accountIds = [...new Set(config.google_ads_customer_ids.map(id))];
      const tokenFile = privatePath(config.oauth_token_file, dirname(configFile));
      const apiVersion = env.GOOGLE_ADS_API_VERSION || 'v25';
      if (!/^v[1-9]\d{1,2}$/.test(apiVersion)) fail('GOOGLE_CONFIG_INVALID', 'Google Ads API 版本配置不正确。', 503);
      const loginCustomerId = config.google_ads_login_customer_id ? id(config.google_ads_login_customer_id) : '';
      if (env.GOOGLE_ADS_HTTPS_PROXY) {
        const scopedTransport = createGoogleHttpsTransport(env.GOOGLE_ADS_HTTPS_PROXY);
        if (!fetchImpl) transport = scopedTransport;
      }
      settings = {accountIds, tokenFile, apiVersion, loginCustomerId};
    }
  } catch (error) {
    configurationError = error instanceof AppError ? {code:error.code, message:error.message} : {code:'GOOGLE_CONFIG_INVALID', message:'Google 数据连接配置不完整。'};
  }
  let cachedToken, refreshPromise;
  function status() {
    return {configured:Boolean(settings), readOnly:true, accountIds:settings?.accountIds || [], apiVersion:settings?.apiVersion || 'v25', ...(configurationError ? {error:configurationError} : {})};
  }
  async function request(url, options, maxBytes) {
    let response;
    try {response = await transport(url, {...options, redirect:'manual', signal:AbortSignal.timeout(30000)});}
    catch {fail('GOOGLE_UNAVAILABLE', '暂时无法读取 Google 数据，请稍后重试。');}
    if (response.status >= 300 && response.status < 400) {await response.body?.cancel().catch(() => {}); fail('GOOGLE_REDIRECT_BLOCKED', 'Google 请求发生了意外跳转，已停止读取。');}
    const data = await responseJSON(response, maxBytes);
    return {response, data};
  }
  async function token(force = false) {
    if (!force && cachedToken?.expiresAt > clock() + 60000) return cachedToken.value;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const credentials = readJSON(settings.tokenFile);
      if (credentials.token_uri && credentials.token_uri !== OAUTH_URL) fail('GOOGLE_CONFIG_INVALID', 'Google 授权端点配置不正确。', 503);
      if (Array.isArray(credentials.scopes) && !credentials.scopes.includes(ADS_SCOPE)) fail('GOOGLE_AUTH_REQUIRED', '现有授权不包含 Google Ads，请重新授权。', 409);
      const expiresAt = Date.parse(credentials.expiry || '');
      if (!force && validSecret(credentials.token) && expiresAt > clock() + 60000) {
        cachedToken = {value:credentials.token, expiresAt};
        return cachedToken.value;
      }
      if (![credentials.client_id, credentials.client_secret, credentials.refresh_token].every(validSecret)) fail('GOOGLE_AUTH_REQUIRED', 'Google Ads 授权不完整，请重新授权。', 409);
      const form = new URLSearchParams({grant_type:'refresh_token', client_id:credentials.client_id, client_secret:credentials.client_secret, refresh_token:credentials.refresh_token});
      const {response, data} = await request(OAUTH_URL, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:form.toString()}, 64 * 1024);
      if (!response.ok) {
        if (['invalid_grant','invalid_client','unauthorized_client','access_denied'].includes(data.error) || [400,401,403].includes(response.status)) fail('GOOGLE_AUTH_REQUIRED', 'Google Ads 授权已失效，请重新登录授权后再更新日报。', 409);
        fail('GOOGLE_UNAVAILABLE', 'Google 授权服务暂不可用，请稍后重试。');
      }
      if (!validSecret(data.access_token) || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 60 || Number(data.expires_in) > 86400) fail('GOOGLE_INVALID_RESPONSE', 'Google 未返回有效授权，请重新授权。');
      cachedToken = {value:data.access_token, expiresAt:clock() + Number(data.expires_in) * 1000};
      return cachedToken.value;
    })();
    try {return await refreshPromise;} finally {refreshPromise = undefined;}
  }
  async function search(accountId, query) {
    const rows = [], seen = new Set(); let pageToken, pages = 0;
    do {
      const payload = {query, ...(pageToken ? {pageToken} : {})};
      const url = `${ADS_ORIGIN}/${settings.apiVersion}/customers/${accountId}/googleAds:search`;
      const run = async accessToken => request(url, {method:'POST', headers:{'Content-Type':'application/json', Authorization:'Bearer ' + accessToken, ...(settings.loginCustomerId ? {'login-customer-id':settings.loginCustomerId} : {})}, body:JSON.stringify(payload)}, 16 * 1024 * 1024);
      let result = await run(await token());
      if (result.response.status === 401) result = await run(await token(true));
      const {response, data} = result;
      if (!response.ok) {
        if (response.status === 401) fail('GOOGLE_AUTH_REQUIRED', 'Google Ads 授权已失效，请重新登录授权。', 409);
        if (response.status === 403) fail('GOOGLE_ACCESS_DENIED', '当前 Google 授权无权读取这个广告账户。', 403);
        if (response.status === 429) fail('GOOGLE_RATE_LIMITED', 'Google 数据读取次数暂时受限，请稍后重试。', 429);
        fail(response.status === 400 ? 'GOOGLE_QUERY_REJECTED' : 'GOOGLE_UNAVAILABLE', 'Google 未能返回完整日报数据，请检查连接或稍后重试。');
      }
      if ((!Array.isArray(data.results) && data.results !== undefined) || (data.results?.length || 0) > 10000) fail('GOOGLE_INVALID_RESPONSE', 'Google 报表返回格式不正确。');
      rows.push(...(data.results || [])); pages += 1;
      pageToken = data.nextPageToken;
      if (pageToken !== undefined && (typeof pageToken !== 'string' || pageToken.length > 16384)) fail('GOOGLE_INVALID_RESPONSE', 'Google 报表分页信息不正确。');
      if (rows.length > MAX_ROWS || (pageToken && pages >= MAX_PAGES)) fail('GOOGLE_REPORT_TOO_LARGE', 'Google 报表超出本次完整读取范围，请缩短日期范围。');
      if (pageToken && seen.has(pageToken)) fail('GOOGLE_INVALID_RESPONSE', 'Google 报表分页重复，未保存不完整结果。');
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    return rows;
  }
  async function readAccount(rawAccountId, {startDate, endDate} = {}) {
    if (!settings) fail(configurationError?.code || 'GOOGLE_NOT_CONFIGURED', configurationError?.message || '请先由部署者配置 Google Ads 的只读数据连接。', 503);
    const accountId = id(rawAccountId);
    if (!settings.accountIds.includes(accountId)) fail('GOOGLE_ACCOUNT_NOT_ALLOWED', '此账户不在允许读取的 Google Ads 账户清单中。', 403);
    dateOnly(startDate); dateOnly(endDate);
    const days = (Date.parse(endDate + 'T00:00:00Z') - Date.parse(startDate + 'T00:00:00Z')) / DAY + 1;
    if (days < 1 || days > 31) fail('GOOGLE_INVALID_DATE', '每次只能读取连续 1 至 31 个自然日。', 400);
    const metadata = await search(accountId, 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager FROM customer LIMIT 1');
    if (metadata.length !== 1 || !plain(metadata[0]) || !plain(metadata[0].customer)) fail('GOOGLE_INVALID_RESPONSE', '未能确认 Google Ads 子账户资料。');
    const customer = metadata[0].customer;
    if (String(customer.id) !== accountId || customer.manager === true || !/^[A-Z]{3}$/.test(customer.currencyCode || '') || !customer.timeZone) fail('GOOGLE_INVALID_RESPONSE', 'Google 返回的账户、币种或时区与子账户不一致。');
    const account = {id:accountId, name:string(customer.descriptiveName), currency:customer.currencyCode, timeZone:string(customer.timeZone, '', 100)};
    const today = dateInZone(clock(), account.timeZone);
    if (endDate >= today) fail('GOOGLE_INCOMPLETE_DAY', '日报只读取账户时区昨天及之前的完整自然日。', 400);
    // v23 removed start_date in favor of an account-local date and time.
    const hasStartDateTime = Number(settings.apiVersion.slice(1)) >= 23;
    const startField = hasStartDateTime ? 'start_date_time' : 'start_date';
    const campaignRows = await search(accountId, `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.${startField} FROM campaign ORDER BY campaign.id`);
    const campaigns = campaignRows.map(row => {
      if (!plain(row) || !plain(row.campaign)) fail('GOOGLE_INVALID_RESPONSE', 'Google 广告计划资料不完整。');
      const c = row.campaign;
      const startValue = hasStartDateTime ? c.startDateTime : c.startDate;
      let startDate;
      if (startValue !== undefined) {
        if (hasStartDateTime && (typeof startValue !== 'string' || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(startValue))) fail('GOOGLE_INVALID_RESPONSE', 'Google 广告计划的开始时间格式不正确。');
        startDate = dateOnly(hasStartDateTime ? startValue.slice(0, 10) : startValue);
      }
      return {id:remoteId(c.id), name:string(c.name), status:string(c.status, 'UNKNOWN', 80), channelType:string(c.advertisingChannelType, 'UNKNOWN', 80), ...(startDate === undefined ? {} : {startDate})};
    });
    const campaignIds = new Set(campaigns.map(c => c.id));
    if (campaignIds.size !== campaigns.length) fail('GOOGLE_INVALID_RESPONSE', 'Google 广告计划资料重复，未生成日报。');
    const where = `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' ORDER BY segments.date, campaign.id`;
    const dailyRows = await search(accountId, 'SELECT segments.date, campaign.id, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign ' + where);
    const conversionRows = await search(accountId, 'SELECT segments.date, campaign.id, segments.conversion_action, segments.conversion_action_name, segments.conversion_action_category, metrics.conversions, metrics.conversions_value FROM campaign ' + where);
    function basis(row) {
      if (!plain(row) || !plain(row.campaign) || !plain(row.segments) || (row.metrics !== undefined && !plain(row.metrics))) fail('GOOGLE_INVALID_RESPONSE', 'Google 日报行资料不完整。');
      const campaignId = remoteId(row.campaign.id), date = dateOnly(row.segments.date);
      if (!campaignIds.has(campaignId) || date < startDate || date > endDate) fail('GOOGLE_INVALID_RESPONSE', 'Google 日报行超出本次账户或日期范围。');
      return {date, campaignId};
    }
    const daily = dailyRows.map(row => ({...basis(row), impressions:numeric(row.metrics?.impressions, {integer:true, positive:true}), clicks:numeric(row.metrics?.clicks, {integer:true, positive:true}), costMicros:cost(row.metrics?.costMicros), conversions:numeric(row.metrics?.conversions), conversionValue:numeric(row.metrics?.conversionsValue)}));
    const conversionDaily = conversionRows.map(row => {
      const base = basis(row), action = string(row.segments.conversionAction, '', 200), match = action.match(/^customers\/\d{10}\/conversionActions\/(\d{1,30})$/);
      if (!match) fail('GOOGLE_INVALID_RESPONSE', 'Google 转化操作编号不完整。');
      return {...base, conversionActionId:match[1], conversionActionName:string(row.segments.conversionActionName), category:string(row.segments.conversionActionCategory, 'UNKNOWN', 100), conversions:numeric(row.metrics?.conversions), conversionValue:numeric(row.metrics?.conversionsValue)};
    });
    if (new Set(daily.map(row => row.date + ':' + row.campaignId)).size !== daily.length || new Set(conversionDaily.map(row => row.date + ':' + row.campaignId + ':' + row.conversionActionId)).size !== conversionDaily.length) fail('GOOGLE_INVALID_RESPONSE', 'Google 日报行重复，未保存可能重复计数的结果。');
    return {account, campaigns, daily, conversionDaily};
  }
  return {status, readAccount};
}
