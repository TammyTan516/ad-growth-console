// SPDX-License-Identifier: MIT
// Configuration is a reviewed instruction, never evidence of live platform state.
import {ensure} from './errors.mjs';
import {fields, text, revision, PLATFORMS} from './validation.mjs';

const TARGET_FIELDS = ['platform', 'accountId', 'accountName', 'accountCurrency', 'accountTimeZone', 'accountUrl', 'campaignName', 'groupName', 'campaignType', 'budgetLevel', 'dailyBudget', 'bidStrategy', 'bidValue', 'conversionEventId', 'conversionEventName', 'pixelId', 'identityId', 'instagramAccountId', 'creativeMode', 'locationIds', 'languageCodes', 'placements', 'audienceBindings', 'keywordMatchType'];
const HOSTS = {Google: ['ads.google.com'], Meta: ['adsmanager.facebook.com', 'business.facebook.com'], TikTok: ['ads.tiktok.com']};
const TYPES = {Google: ['search'], Meta: ['sales'], TikTok: ['website_conversions']};
const BIDS = {Google: ['manual_cpc', 'maximize_clicks', 'maximize_conversions'], Meta: ['lowest_cost', 'cost_cap'], TikTok: ['lowest_cost', 'cost_cap']};
const PLACEMENTS = {Google: ['google_search'], Meta: ['facebook_feed', 'instagram_feed'], TikTok: ['tiktok']};
const reject = (condition, message) => ensure(condition, 400, 'INVALID_EXECUTION_CONFIGURATION', message);
const required = (condition, message) => ensure(condition, 400, 'EXECUTION_CONFIGURATION_INCOMPLETE', message);

function choice(value, allowed, label, complete) {
  const result = text(value ?? '', label, 80);
  reject(!result || allowed.includes(result), `${label}不在当前支持范围内。`);
  if (complete) required(result, `请填写${label}。`);
  return result;
}
function amount(value, label) {
  if (value === '' || value === undefined || value === null) return null;
  reject(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000 && Math.abs(Math.round(value * 100) - value * 100) < 0.000001, `${label}需大于 0、不超过 100000，最多两位小数。`);
  return value;
}
function list(value, label, max = 20) {
  const values = value ?? [];
  reject(Array.isArray(values) && values.length <= max, `${label}最多填写 ${max} 项。`);
  const result = values.map(v => text(v, label, 160, true));
  reject(new Set(result).size === result.length, `${label}不能重复。`);
  return result;
}
function accountId(value, platform) {
  let result = text(value ?? '', '广告账户编号', 80);
  if (!result) return result;
  if (platform === 'Google') {
    reject(/^\d{10}$/.test(result) || /^\d{3}-\d{3}-\d{4}$/.test(result), 'Google 广告账户编号需为 10 位数字。');
    result = result.replaceAll('-', '');
  } else {
    if (platform === 'Meta' && /^act_\d+$/.test(result)) result = result.slice(4);
    reject(/^\d{1,30}$/.test(result), `${platform} 广告账户编号需填写后台显示的数字编号。`);
  }
  return result;
}
function accountUrl(value, platform, id) {
  const result = text(value ?? '', '广告账户网址', 2048);
  if (!result) return result;
  let url;
  try { url = new URL(result); } catch { reject(false, '广告账户网址格式不正确。'); }
  reject(url.protocol === 'https:' && !url.username && !url.password && HOSTS[platform].includes(url.hostname) && (!url.port || url.port === '443'), '请使用对应广告平台的 HTTPS 后台网址。');
  reject(![...url.searchParams.keys()].some(k => /^(access_token|token|password|session|authorization|code)$/i.test(k)), '广告账户网址不能包含登录密钥或临时授权码。');
  // Google ocid is not the visible customer ID, so it must not be compared to it.
  const accountKey = platform === 'Meta' ? 'act' : platform === 'TikTok' ? 'aadvid' : null;
  if (id && accountKey && url.searchParams.has(accountKey)) reject(accountId(url.searchParams.get(accountKey), platform) === id, '账户网址与填写的广告账户编号不同。');
  return url.href;
}

export function validateExecutionConfiguration(input, brief, selectionSnapshot, content, {complete = false} = {}) {
  fields(input, ['targets']);
  reject(Array.isArray(input.targets) && input.targets.length <= 3, '请按平台填写广告搭建设置。');
  const selected = brief?.platforms ?? [];
  const targets = input.targets.map(raw => {
    fields(raw, TARGET_FIELDS);
    reject(PLATFORMS.includes(raw.platform) && selected.includes(raw.platform), '广告搭建设置包含本次未选择的平台。');
    const platform = raw.platform, target = {platform};
    target.accountId = accountId(raw.accountId, platform);
    for (const [key, label, max] of [['accountName', '账户名称', 160], ['accountTimeZone', '账户时区', 80], ['campaignName', '广告计划名称', 160], ['groupName', '广告组名称', 160], ['conversionEventId', '转化事件编号', 160], ['conversionEventName', '转化事件名称', 160], ['pixelId', '像素或数据源编号', 160], ['identityId', '广告发布身份编号', 160], ['instagramAccountId', 'Instagram 账户编号', 160]]) target[key] = text(raw[key] ?? '', label, max);
    target.accountCurrency = text(raw.accountCurrency ?? '', '账户币种', 3).toUpperCase();
    reject(!target.accountCurrency || /^[A-Z]{3}$/.test(target.accountCurrency), '账户币种需为三位字母代码，例如 USD。');
    if (target.accountTimeZone) {
      try { new Intl.DateTimeFormat('en', {timeZone: target.accountTimeZone}); } catch { reject(false, '账户时区不是有效的时区名称。'); }
    }
    target.accountUrl = accountUrl(raw.accountUrl, platform, target.accountId);
    target.campaignType = choice(raw.campaignType, TYPES[platform], '广告计划类型', complete);
    const budgetLevels = platform === 'Google' ? [brief.operation === 'new_group' ? 'inherit_campaign' : 'campaign'] : platform === 'Meta' ? (brief.operation === 'new_group' ? ['ad_group', 'inherit_campaign'] : ['campaign', 'ad_group']) : ['ad_group'];
    target.budgetLevel = choice(raw.budgetLevel, budgetLevels, '预算所在层级', complete);
    target.dailyBudget = amount(raw.dailyBudget, '日预算');
    target.bidStrategy = choice(raw.bidStrategy, BIDS[platform], '出价方式', complete);
    target.bidValue = amount(raw.bidValue, '出价金额');
    const canHaveBid = ['manual_cpc', 'maximize_clicks', 'cost_cap'].includes(target.bidStrategy);
    reject(!target.bidValue || !target.bidStrategy || canHaveBid, '当前出价方式不使用出价金额，请清空该金额。');
    target.creativeMode = choice(raw.creativeMode, platform === 'Google' ? ['text'] : ['file', 'creator_code'], '素材使用方式', complete);
    target.keywordMatchType = choice(raw.keywordMatchType, platform === 'Google' ? ['phrase', 'exact'] : [], '关键词匹配方式', complete && platform === 'Google');
    target.locationIds = list(raw.locationIds, '投放位置');
    target.languageCodes = list(raw.languageCodes, '广告语言');
    target.placements = list(raw.placements, '广告版位');
    reject(target.placements.every(p => PLACEMENTS[platform].includes(p)), '广告版位不在当前支持范围内。');
    const bindings = raw.audienceBindings ?? [];
    reject(Array.isArray(bindings) && bindings.length <= 20, '人群对应设置最多填写 20 项。');
    target.audienceBindings = bindings.map(binding => {
      fields(binding, ['resourceId', 'resourceRevision', 'use', 'platformAudienceId']);
      const result = {resourceId: text(binding.resourceId ?? '', '人群资源编号', 80, true), resourceRevision: revision(binding.resourceRevision), use: choice(binding.use, ['include', 'exclude'], '人群用途', true), platformAudienceId: text(binding.platformAudienceId ?? '', '平台人群编号', 160, complete)};
      reject((selectionSnapshot?.audiences ?? []).some(a => a.id === result.resourceId && a.revision === result.resourceRevision && a.use === result.use), '人群对应设置与本次所选人群版本或包含／排除用途不同。');
      return result;
    });
    reject(new Set(target.audienceBindings.map(a => a.resourceId)).size === target.audienceBindings.length, '同一平台的人群对应设置不能重复。');
    if (complete) {
      for (const key of ['accountId', 'accountName', 'accountCurrency', 'accountTimeZone', 'accountUrl', 'campaignName', 'groupName', 'conversionEventId', 'conversionEventName']) required(target[key], `${platform} 的账户、计划、广告组和转化事件设置尚未填完整。`);
      required(target.dailyBudget !== null && target.dailyBudget === brief.budgets?.[platform], `${platform} 的日预算需与已审核需求一致。`);
      required(target.locationIds.length && target.languageCodes.length && target.placements.length, `${platform} 请明确投放位置、语言和广告版位。`);
      if (['manual_cpc', 'cost_cap'].includes(target.bidStrategy)) required(target.bidValue, `${platform} 当前出价方式需要填写出价金额。`);
      const audiences = selectionSnapshot?.audiences ?? [];
      required(target.audienceBindings.length === audiences.length, `${platform} 请为每份已选人群填写对应的平台人群编号。`);
      if (brief.operation === 'new_group') {
        const parent = brief.parentCampaign;
        required(parent?.platform === platform && parent.campaignId && accountId(parent.accountId, platform) === target.accountId, '新增广告组的账户与父计划不一致，请核对后重试。');
        required(target.groupName === brief.groupName, '广告组名称需与已审核需求一致。');
      }
      const material = selectionSnapshot?.materials?.[0];
      if (platform !== 'Google') {
        required(target.pixelId && target.identityId, `${platform} 请填写像素或数据源编号，以及广告发布身份编号。`);
        if (platform === 'Meta' && target.placements.includes('instagram_feed')) required(target.instagramAccountId, '选择 Instagram 版位时，请填写对应的 Instagram 账户编号。');
        required(target.creativeMode === 'file', `${platform} 浏览器搭建初版只支持已上传文件，达人授权代码需要后续单独接入授权流程。`);
        required(material?.hasFile, `${platform} 所选素材尚未上传文件，请先上传审核素材。`);
        if (platform === 'TikTok') required(material?.mediaType === 'video', 'TikTok 初版只支持视频素材。');
      }
      const copy = content?.platforms?.find(p => p.platform === platform);
      required(copy && (platform === 'Google' ? copy.keywords?.length : copy.primaryTexts?.length), `${platform} 尚未准备好已审核的广告文案。`);
    }
    return target;
  });
  reject(new Set(targets.map(t => t.platform)).size === targets.length, '同一平台只能填写一份搭建设置。');
  if (complete) {
    required(selected.length > 0 && targets.length === selected.length && selected.every(p => targets.some(t => t.platform === p)), '请为本次选择的每个平台填写搭建设置。');
    required(selectionSnapshot?.materials?.length === 1, '浏览器搭建初版每份方案请选择一份素材；每个平台创建一条广告，多素材请拆分方案。');
  }
  return {targets};
}
