// SPDX-License-Identifier: MIT
import {ensure} from './errors.mjs';

export const PLATFORMS = ['Google', 'Meta', 'TikTok'];
export const ROLES = ['admin', 'editor', 'viewer'];
export function fields(value, allowed) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID_INPUT', '请提交有效的内容。');
  ensure(Object.keys(value).every(key => allowed.includes(key)), 400, 'INVALID_INPUT', '提交内容包含不支持的字段。');
  return value;
}
export function text(value, label, max, required = false) {
  ensure(typeof value === 'string', 400, 'INVALID_INPUT', `${label}格式不正确。`);
  const clean = value.trim();
  ensure(clean.length <= max && (!required || clean.length > 0), 400, 'INVALID_INPUT', `请填写${label}，长度不超过 ${max} 个字符。`);
  ensure(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(clean), 400, 'INVALID_INPUT', `${label}含有不支持的字符。`);
  return clean;
}
export function email(value) {
  const clean = text(value, '邮箱', 254, true).toLowerCase();
  ensure(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean), 400, 'INVALID_EMAIL', '请填写有效的邮箱地址。');
  return clean;
}
export function role(value) {
  ensure(ROLES.includes(value), 400, 'INVALID_ROLE', '请选择管理员、编辑或只读成员。');
  return value;
}
export function password(value) {
  ensure(typeof value === 'string' && value.length >= 12 && value.length <= 128, 400, 'INVALID_PASSWORD', '密码需要 12 至 128 个字符。');
  return value;
}
export function revision(value) {
  ensure(Number.isSafeInteger(value) && value > 0, 400, 'INVALID_REVISION', '请使用当前方案的版本号保存。');
  return value;
}
export function proposalBrief(value = {}) {
  fields(value, ['operation', 'platforms', 'objective', 'country', 'language', 'audienceDirection', 'groupName', 'budgets', 'startAt', 'timeZone', 'parentCampaign']);
  const result = {operation: 'new_campaign', platforms: [], objective: 'registration', country: 'US', language: 'English', audienceDirection: '', groupName: '', budgets: {}, startAt: '', timeZone: 'Asia/Shanghai', parentCampaign: null, ...value};
  ensure(['new_campaign', 'new_group'].includes(result.operation), 400, 'INVALID_INPUT', '请选择新建计划或新增广告组。');
  ensure(['registration', 'first_subscription'].includes(result.objective), 400, 'INVALID_INPUT', '请选择注册或首次订阅目标。');
  ensure(Array.isArray(result.platforms) && result.platforms.length <= 3 && new Set(result.platforms).size === result.platforms.length && result.platforms.every(p => PLATFORMS.includes(p)), 400, 'INVALID_INPUT', '投放平台不正确。');
  ensure(result.operation !== 'new_group' || result.platforms.length <= 1, 400, 'INVALID_INPUT', '在已有计划下新增广告组时，请只选择一个平台。');
  for (const [key, label, max] of [['country', '投放地区', 64], ['language', '广告语言', 64], ['audienceDirection', '人群方向', 2000], ['groupName', '广告组名称', 120], ['startAt', '开始时间', 32], ['timeZone', '时区', 80]]) result[key] = text(result[key], label, max);
  if (result.startAt) {
    ensure(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(result.startAt), 400, 'INVALID_INPUT', '开始时间格式不正确。');
    const canonical = result.startAt.length === 16 ? result.startAt + ':00' : result.startAt;
    const timestamp = Date.parse(canonical + 'Z');
    ensure(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === canonical, 400, 'INVALID_INPUT', '开始时间不是有效的日历日期或时间。');
  }
  try { new Intl.DateTimeFormat('en', {timeZone: result.timeZone}); } catch { ensure(false, 400, 'INVALID_INPUT', '请选择有效的时区。'); }
  fields(result.budgets, PLATFORMS);
  for (const [p, amount] of Object.entries(result.budgets)) ensure(typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 && amount <= 100000 && Math.abs(Math.round(amount * 100) - amount * 100) < 0.000001, 400, 'INVALID_INPUT', `${p} 日预算需为 0 至 100000 的金额，最多两位小数。`);
  if (result.parentCampaign !== null) {
    fields(result.parentCampaign, ['platform', 'accountId', 'campaignId', 'name']);
    ensure(PLATFORMS.includes(result.parentCampaign.platform), 400, 'INVALID_INPUT', '父计划平台不正确。');
    result.parentCampaign = {platform: result.parentCampaign.platform, ...Object.fromEntries(['accountId', 'campaignId', 'name'].map(key => [key, text(result.parentCampaign[key] || '', '父计划信息', 160)]))};
    ensure(result.operation === 'new_group' && result.platforms.includes(result.parentCampaign.platform), 400, 'INVALID_INPUT', '父计划与本次平台不一致。');
  }
  return result;
}
