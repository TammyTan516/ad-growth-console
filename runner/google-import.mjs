// SPDX-License-Identifier: MIT
// Pure Google Ads browser-upload preparation. No files, network or account writes.
// Official browser templates (checked 2026-10-27):
// https://support.google.com/google-ads/answer/10702525
// https://support.google.com/google-ads/answer/10702623
// Current browser campaign template requires EU political ads = Yes|No:
// https://www.gstatic.com/adwords/campaignmgmt/templates/campaign_mcc_template.csv
// Entity headers follow the current browser uploader templates, not old XLSX:
// https://www.gstatic.com/adwords/campaignmgmt/templates/ad_group_mcc_template.csv
// https://www.gstatic.com/adwords/campaignmgmt/templates/responsive_search_ad_mcc_template.csv
// https://www.gstatic.com/adwords/campaignmgmt/templates/keyword_mcc_template.csv
// Search language targeting changed from September 2026; the template's Language
// field remains a provider hint, not proof of a campaign-level audience filter:
// https://support.google.com/google-ads/answer/1722078
// Campaign/group/ad/keyword files are separate; preview each before applying.
import {createHash} from 'node:crypto';

export class GoogleImportError extends Error {
  constructor(code, message) {super(message); this.name = 'GoogleImportError'; this.code = code;}
}
const fail = (code, message) => {throw new GoogleImportError(code, message);};
const requireValue = (condition, code, message) => {if (!condition) fail(code, message);};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const HASH = /^[a-f0-9]{64}$/;
const STAGES = ['campaign', 'adGroup', 'ad', 'keywords'];
const BIDS = {manual_cpc:'Manual CPC',maximize_clicks:'Maximize clicks',maximize_conversions:'Maximize Conversions'};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const width = value => [...value].reduce((n, char) => n + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\uAC00-\uD7AF\uFF01-\uFF60\uFFE0-\uFFE6\p{Extended_Pictographic}]/u.test(char) ? 2 : 1), 0);
function literal(value, label, max = 2000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value), 'INVALID_LITERAL', `${label}为空、过长或包含控制字符。`);
  requireValue(!/^[\s\uFEFF]*[=+\-@]/u.test(value), 'FORMULA_REJECTED', `${label}以电子表格公式字符开头，请先修改并重新审核。`);
  requireValue(value !== 'remove_value', 'INVALID_LITERAL', `${label}不能使用批量删除指令。`);
  return value;
}
function account(value) {
  requireValue(typeof value === 'string' && /^(?:\d{10}|\d{3}-\d{3}-\d{4})$/.test(value), 'INVALID_ACCOUNT', 'Google 子账户编号需为 10 位数字。');
  return value.replaceAll('-', '');
}
function remoteId(value) {
  requireValue(typeof value === 'string' && /^\d{1,30}$/.test(value), 'INVALID_REMOTE_ID', '请使用浏览器实际读取的 Google 对象数字编号。');
  return value;
}
function finalURL(value) {
  literal(value, '最终链接', 4096); let url;
  try {url = new URL(value);} catch {fail('INVALID_URL', '最终链接格式不正确。');}
  requireValue(url.protocol === 'https:' && !url.username && !url.password && ![...url.searchParams.keys()].some(k=>/^(?:access_token|refresh_token|token|password|session|authorization|code|api_key|secret)$/i.test(k)), 'INVALID_URL', '最终链接必须是完整 HTTPS 网址，且不能包含登录信息。');
  return value; // Preserve the exact frozen URL, including UTM ordering and fragment.
}
function joined(values, label) {
  requireValue(Array.isArray(values) && values.length > 0 && values.length <= 20, 'INVALID_TARGETING', `${label}尚未明确。`);
  return values.map(value => {
    literal(value, label, 160);
    requireValue(!/[;|]/.test(value), 'INVALID_TARGETING', `${label}请使用独立名称或编号，不要嵌入额外定位指令。`);
    return value;
  }).join('; ');
}
function dateOnly(brief, target) {
  requireValue(brief.timeZone === target.accountTimeZone, 'TIME_ZONE_MISMATCH', '本版导入要求需求与账户时区一致，请先核对并重新审核。');
  requireValue(typeof brief.startAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(brief.startAt), 'INVALID_START_DATE', '请明确审核方案中的开始日期和时间。');
  const day = brief.startAt.slice(0,10), hour = Number(brief.startAt.slice(11,13)), minute = Number(brief.startAt.slice(14,16));
  requireValue(hour < 24 && minute < 60 && Number.isFinite(Date.parse(day+'T00:00:00Z')) && new Date(day+'T00:00:00Z').toISOString().slice(0,10) === day, 'INVALID_START_DATE', '开始日期或时间不正确。');
  return day;
}
function number(value, label) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 100000 && Math.abs(Math.round(value*100)-value*100)<0.000001, 'INVALID_AMOUNT', `${label}需要是审核过的有效金额。`);
  return String(value);
}
function csv(headers, rows) {
  const cell = value => '"' + String(value ?? '').replaceAll('"','""') + '"';
  return '\uFEFF' + [headers, ...rows].map(row=>row.map(cell).join(',')).join('\r\n') + '\r\n';
}
function knownObjects(objects, snapshot, accountId) {
  requireValue(Array.isArray(objects) && objects.length <= 9, 'INVALID_OBJECTS', '请提供实际核对的原有对象列表。');
  const by = {};
  for (const item of objects) {
    requireValue(plain(item), 'INVALID_OBJECTS', '对象记录格式不正确。');
    if (item.platform && item.platform !== 'Google') continue;
    requireValue(['campaign','adGroup','ad'].includes(item.level) && !by[item.level] && item.status === 'paused', 'PARENT_NOT_PAUSED', '已知对象必须逐层唯一并已核对暂停状态。');
    if (item.accountId !== undefined) requireValue(account(item.accountId) === accountId, 'ACCOUNT_MISMATCH', '已知对象不属于本次账户。');
    by[item.level] = {...item,id:remoteId(item.id),parentId:item.parentId ? remoteId(item.parentId) : ''};
  }
  const existingParent = snapshot.brief.operation === 'new_group';
  requireValue(!existingParent || !by.campaign, 'PARENT_SCOPE_MISMATCH', '新增广告组不能把已有父计划当作本任务新建对象。');
  const parentId = existingParent ? remoteId(snapshot.brief.parentCampaign?.campaignId) : by.campaign?.id;
  if (existingParent) requireValue(snapshot.brief.parentCampaign?.platform === 'Google' && account(snapshot.brief.parentCampaign.accountId) === accountId, 'PARENT_SCOPE_MISMATCH', '父计划账户与本次范围不一致。');
  if (by.campaign) requireValue(!by.campaign.parentId, 'PARENT_SCOPE_MISMATCH', '广告计划不能带有广告组父编号。');
  if (by.adGroup) requireValue(parentId && by.adGroup.parentId === parentId, 'PARENT_SCOPE_MISMATCH', '新广告组的父计划编号不一致。');
  if (by.ad) requireValue(by.adGroup && by.ad.parentId === by.adGroup.id, 'PARENT_SCOPE_MISMATCH', '广告的父广告组编号不一致。');
  return {by,parentId};
}
/**
 * Prepare one entity-specific CSV for the Google Ads *browser* bulk uploader.
 * Input: the immutable snapshot from a create_paused job, observed object records
 * from that same job, and stage campaign|adGroup|ad|keywords. A new campaign also
 * requires an explicit euPoliticalAds:false declaration from the operator after
 * reviewing the ad content. Political campaigns are outside this MVP's scope.
 * This pure function
 * cannot prove remote state or replace a live lease, fresh preflight, submit
 * intent, preview, human review, or read-back. It never enables an object.
 * Output: {filename,csv,headers,rowCount,stage,paused:true,manualChecks}.
 * No caller-supplied budget, text, URL or account override is accepted.
 */
export function createGoogleImport({snapshot,objects = [],stage,euPoliticalAds} = {}) {
  requireValue(STAGES.includes(stage), 'INVALID_STAGE', '请选择广告计划、广告组、广告或关键词导入阶段。');
  requireValue(plain(snapshot) && snapshot.schemaVersion === 1 && snapshot.desiredState === 'paused' && snapshot.review?.status === 'approved', 'REVIEW_REQUIRED', '只能从已审核、要求暂停创建的冻结方案生成导入文件。');
  const {fingerprint,...basis} = snapshot;
  requireValue(typeof fingerprint === 'string' && HASH.test(fingerprint) && fingerprint === digest(basis), 'SNAPSHOT_MISMATCH', '冻结方案校验失败，请重新领取任务，不能修改本地副本。');
  requireValue(typeof snapshot.proposalId === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(snapshot.proposalId) && Number.isSafeInteger(snapshot.proposalRevision) && snapshot.proposalRevision > 0, 'INVALID_SNAPSHOT', '冻结方案缺少编号和版本。');
  requireValue(['new_campaign','new_group'].includes(snapshot.brief?.operation) && snapshot.brief.platforms?.includes('Google'), 'UNSUPPORTED_SCOPE', '本版仅准备新搜索计划或在已有计划下新增广告组。');
  const targets = snapshot.configuration?.targets?.filter(t=>t.platform === 'Google') || [], specs = snapshot.adSpecifications?.filter(a=>a.platform === 'Google') || [];
  requireValue(targets.length === 1 && specs.length === 1, 'INVALID_SNAPSHOT', '冻结方案需包含唯一的 Google 账户与广告。');
  const target = targets[0], spec = specs[0], accountId = account(target.accountId), names = snapshot.effectiveNames?.Google;
  requireValue(target.campaignType === 'search' && target.creativeMode === 'text' && Object.hasOwn(BIDS,target.bidStrategy) && target.placements?.length === 1 && target.placements[0] === 'google_search', 'UNSUPPORTED_FORMAT', '仅支持标准搜索文字广告及 Google 搜索结果，不自动扩展网络。');
  requireValue(names && typeof names === 'object', 'INVALID_SNAPSHOT', '冻结方案缺少执行名称。');
  const campaignName = literal(names.campaign, '计划名称', 250), groupName = literal(names.adGroup, '广告组名称', 250);
  requireValue(number(target.dailyBudget,'日预算') === number(snapshot.brief.budgets?.Google,'需求日预算'), 'BUDGET_MISMATCH', '日预算与冻结需求不一致。');
  requireValue(target.budgetLevel === (snapshot.brief.operation === 'new_group' ? 'inherit_campaign' : 'campaign'), 'BUDGET_SCOPE_MISMATCH', '预算层级与本次操作范围不一致。');
  const known = knownObjects(objects,snapshot,accountId), {by,parentId} = known;
  const manualChecks = ['先在当前 Google 子账户预览：只能出现本文件对应的新对象，所有状态必须为 Paused；有任何意外或错误时不要应用。', '每次应用前取得本阶段提交许可，应用后重新打开对象，保存真实编号和暂停截图；不确定结果先核对，不能再次创建。', `文件不会设置计划专用转化目标。需在暂停计划设置中核对 ${literal(target.conversionEventName,'转化目标名称',160)}（${literal(target.conversionEventId,'转化目标编号',160)}）。`, 'Google 自 2026 年 9 月起移除搜索计划的语言定向设置，改为按广告语言自动匹配。模板仍保留 Language 列，仅作为平台兼容提示；预览成功不代表锁定语言人群。需核对广告和落地页的实际语言，并在结果中如实记录。'];
  manualChecks.push('新广告可能继承账户级附加链接、宣传信息和徽标；本文件不会隔离或移除这些素材。启用前需检查继承素材的文案和落地链接，不能认为本次审核文案与 UTM 已覆盖所有展示内容；不得为本次测试修改账户全局素材。');
  let headers, rows;
  if (stage === 'campaign') {
    requireValue(snapshot.brief.operation === 'new_campaign' && !Object.keys(by).length, 'ALREADY_CREATED', '不能为已有对象或新增组任务再次创建计划。');
    requireValue(euPoliticalAds === false, 'EU_POLITICAL_DECLARATION_REQUIRED', '本版仅支持非政治广告。新建计划前需明确核对并传入 euPoliticalAds:false，不能默认代为声明。');
    headers = ['Action','Campaign status','Customer ID','Campaign','Campaign type','Networks','Budget','Budget type','Bid strategy type','Campaign start date','Language','Location','EU political ads'];
    rows = [['Add','Paused',accountId,campaignName,'Search','Google search',number(target.dailyBudget,'日预算'),'Daily',BIDS[target.bidStrategy],dateOnly(snapshot.brief,target),joined(target.languageCodes,'语言'),joined(target.locationIds,'地区'),'No']];
    manualChecks.push('文件仅写开始日期，不写日内开始时间；需核对账户时区、开始日期及后续启用时的投放时间安排。', '位置名称／编号必须在预览中匹配唯一位置，并核对实际位置选项；不以 CSV 名称代替实际界面验证。');
    if (target.bidStrategy === 'maximize_clicks' && target.bidValue) manualChecks.push(`文件未包含点击出价上限列；需在暂停计划设置中核对已审核上限 ${number(target.bidValue,'点击出价上限')}。`);
  } else if (stage === 'adGroup') {
    requireValue(parentId && !by.adGroup && !by.ad, 'PARENT_REQUIRED', '先记录暂停父计划的真实编号；已有广告组不能重复创建。');
    headers = ['Action','Customer ID','Campaign ID','Campaign','Ad group','Ad group status'];
    rows = [['Add',accountId,parentId,campaignName,groupName,'Paused']];
    if (target.bidStrategy === 'manual_cpc') manualChecks.push(`官方新组模板未声明默认 CPC 列；请在暂停组中核对已审核的默认点击出价 ${number(target.bidValue,'点击出价')}，关键词文件另写 Default max. CPC。`);
  } else {
    requireValue(parentId && by.adGroup, 'PARENT_REQUIRED', '先记录暂停计划与新广告组的真实编号。');
    if (stage === 'ad') {
      requireValue(!by.ad, 'ALREADY_CREATED', '已记录广告编号，不能再次创建广告。');
      requireValue(Array.isArray(spec.headlines) && spec.headlines.length >= 3 && spec.headlines.length <= 15 && Array.isArray(spec.descriptions) && spec.descriptions.length >= 2 && spec.descriptions.length <= 4, 'INVALID_COPY', '响应式搜索广告需要 3 至 15 条标题、2 至 4 条描述。');
      const headlines = spec.headlines.map(v=>literal(v,'标题',100)), descriptions = spec.descriptions.map(v=>literal(v,'描述',300));
      requireValue(headlines.every(v=>width(v)<=30) && descriptions.every(v=>width(v)<=90), 'INVALID_COPY', '标题或描述超过 Google 搜索广告字符限制。');
      const tracking = snapshot.tracking?.find(t=>t.id === spec.trackingId && t.platform === 'Google' && t.materialId === spec.materialId);
      requireValue(tracking && tracking.url === spec.landingUrl, 'TRACKING_MISMATCH', '广告最终链接必须与冻结追踪记录一致。');
      headers = ['Action','Ad status','Customer ID','Campaign ID','Campaign','Ad group ID','Ad group','Ad type',...headlines.map((_,i)=>`Headline ${i+1}`),...descriptions.map((_,i)=>`Description ${i+1}`),'Final URL'];
      rows = [['Add','Paused',accountId,parentId,campaignName,by.adGroup.id,groupName,'Responsive search ad',...headlines,...descriptions,finalURL(spec.landingUrl)]];
      manualChecks.push('广告名称不是此模板的可写字段；以实际广告 ID 关联记录，不能把素材名称当作广告 ID。');
    } else {
      requireValue(Array.isArray(spec.keywords) && spec.keywords.length > 0 && spec.keywords.length <= 100 && ['phrase','exact'].includes(target.keywordMatchType), 'INVALID_KEYWORDS', '关键词数量或匹配方式不正确。');
      const words = spec.keywords.map(v=>literal(v,'关键词',200));
      requireValue(new Set(words.map(v=>v.trim().toLowerCase())).size === words.length && words.every(v=>!/["\[\]]/.test(v)), 'INVALID_KEYWORDS', '请使用不重复的原始关键词；匹配方式由审核设置指定，不要嵌入匹配符号。');
      headers = ['Action','Keyword status','Customer ID','Ad group ID','Keyword','Type'];
      if (target.bidStrategy === 'manual_cpc') headers.push('Default max. CPC');
      rows = words.map(word=>['Add','Paused',accountId,by.adGroup.id,word,target.keywordMatchType === 'phrase' ? 'Phrase match' : 'Exact match',...(target.bidStrategy === 'manual_cpc' ? [number(target.bidValue,'关键词点击出价')] : [])]);
      manualChecks.push('关键词也明确创建为暂停；本函数不判断后台是否已存在同词。先核对既有记录，不能因本地重启再次应用同一份文件。');
    }
  }
  if (spec.negativeKeywords?.length) manualChecks.push('否定关键词未写入本文件；需在同一暂停计划中按冻结清单单独添加并核对。');
  if (target.audienceBindings?.length) manualChecks.push('本文件不设置人群；需逐一核对冻结的平台人群编号及包含／排除用途，不能上传或擅自扩大人群。');
  return {filename:`google-${snapshot.proposalId}-v${snapshot.proposalRevision}-${stage}.csv`,csv:csv(headers,rows),headers,rowCount:rows.length,stage,paused:true,manualChecks};
}
