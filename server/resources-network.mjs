// SPDX-License-Identifier: MIT
import {lookup as dnsLookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {ensure} from './errors.mjs';

const MAX_DOCUMENT = 2 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const MAX_URLS = 2000;
const MAX_MAPS = 20;

export function publicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    // Restrict to globally routable unicast and reject transition/documentation ranges.
    const ip = new URL(`https://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    const [first, second = ''] = ip.split(':');
    const special2001 = first === '2001' && (parseInt(second || '0', 16) <= 0x1ff || second === 'db8');
    return /^[23][0-9a-f]{3}:/.test(ip) && !special2001 && !/^2002:/.test(ip) && !/^3fff:/.test(ip);
  }
  return false;
}

export function httpsURL(value, label = '链接', {allowFragment = false} = {}) {
  let url;
  try { url = new URL(value); } catch { ensure(false, 400, 'INVALID_URL', `${label}需要是完整的 HTTPS 地址。`); }
  ensure(url.protocol === 'https:' && !url.username && !url.password && (allowFragment || !url.hash) && (!url.port || url.port === '443'), 400, 'INVALID_URL', `${label}需要使用 HTTPS，不含密码${allowFragment ? '' : '、片段'}或特殊端口。`);
  ensure(url.href.length <= 2048, 400, 'INVALID_URL', `${label}过长。`);
  return url;
}

async function addresses(url, deadline) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  ensure(hostname && !/(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(hostname), 400, 'UNSAFE_SITEMAP_URL', 'Sitemap 需要使用公开网站的 HTTPS 地址。');
  let timer;
  const answers = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await Promise.race([
    dnsLookup(hostname, {all: true, verbatim: true}).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Sitemap DNS timeout')), Math.max(1, Math.min(5000, deadline - Date.now()))); }),
  ]);
  ensure(answers.length > 0 && answers.every(item => publicAddress(item.address)), 400, 'UNSAFE_SITEMAP_URL', 'Sitemap 地址不能访问本机、内网或保留网络。');
  return answers;
}

async function fetchXML(url, context, redirects = 0) {
  ensure(Date.now() < context.deadline, 504, 'SITEMAP_TIMEOUT', '读取 Sitemap 超时，请稍后再试。');
  const answers = await addresses(url, context.deadline);
  const remaining = context.deadline - Date.now();
  ensure(remaining > 0, 504, 'SITEMAP_TIMEOUT', '读取 Sitemap 超时，请稍后再试。');
  const answer = answers[0];
  // Pin the validated DNS answer to this TLS connection. A second resolver lookup
  // must not be allowed to turn a public address into an internal address.
  const response = await new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'GET', agent: false,
      headers: {'Accept': 'application/xml,text/xml;q=0.9', 'Accept-Encoding': 'identity', 'User-Agent': 'AdGrowthConsole-Sitemap/0.3'},
      lookup(_hostname, options, callback) {
        callback(null, options.all ? [answer] : answer.address, answer.family);
      },
      timeout: Math.min(remaining, 10000),
    }, resolve);
    const deadlineTimer = setTimeout(() => request.destroy(new Error('Sitemap deadline')), Math.max(1, remaining));
    request.once('close', () => clearTimeout(deadlineTimer));
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('Sitemap request timeout')));
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.destroy();
    ensure(redirects < 3 && response.headers.location, 400, 'SITEMAP_REDIRECT', 'Sitemap 跳转次数过多或地址无效。');
    const target = httpsURL(new URL(response.headers.location, url).href, 'Sitemap');
    ensure(target.origin === context.origin, 400, 'SITEMAP_REDIRECT', 'Sitemap 不允许跳转到另一个网站。');
    return fetchXML(target, context, redirects + 1);
  }
  if (response.statusCode !== 200 || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
    response.destroy();
    ensure(response.statusCode === 200, 400, 'SITEMAP_FETCH_FAILED', '未能读取 Sitemap，请检查地址与网站访问情况。');
    ensure(false, 400, 'SITEMAP_ENCODING', '请提供未压缩的 XML Sitemap 地址。');
  }
  let size = 0;
  const chunks = [];
  const timer = setTimeout(() => response.destroy(new Error('Sitemap deadline')), Math.max(1, context.deadline - Date.now()));
  try {
    for await (const chunk of response) {
      size += chunk.length;
      context.bytes += chunk.length;
      ensure(size <= MAX_DOCUMENT && context.bytes <= MAX_TOTAL, 413, 'SITEMAP_TOO_LARGE', 'Sitemap 内容过大，请拆分或缩小范围。');
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); response.destroy(); }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}

function decodeXML(value) {
  ensure(!/&(?!(?:amp|lt|gt|quot|apos|#[0-9]+|#x[0-9a-f]+);)/i.test(value), 400, 'INVALID_SITEMAP', 'Sitemap 含有未编码的 XML 实体。');
  return value.replace(/&([^;]{1,20});/g, (_all, entity) => {
    const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
    if (Object.hasOwn(named, entity)) return named[entity];
    const point = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#[0-9]+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    ensure(Number.isInteger(point) && point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff), 400, 'INVALID_SITEMAP', 'Sitemap 含有不支持的 XML 实体。');
    return String.fromCodePoint(point);
  });
}

// A bounded, non-expanding XML reader for the sitemap subset. No external
// entities, DTD, scripts, or HTML execution are supported. Tag nesting is checked
// before a sync is allowed to write any data.
export function parseSitemap(xml) {
  ensure(!/<!DOCTYPE|<!ENTITY/i.test(xml), 400, 'INVALID_SITEMAP', 'Sitemap 不支持 DTD 或外部实体。');
  const tokens = xml.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g) || [];
  ensure(tokens.join('') === xml, 400, 'INVALID_SITEMAP', 'Sitemap XML 不完整。');
  const stack = [], locations = [];
  let root = '', rootClosed = false, text = '';
  for (const token of tokens) {
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (!token.startsWith('<') || token.startsWith('<![CDATA[')) {
      const value = token.startsWith('<![CDATA[') ? token.slice(9, -3) : decodeXML(token);
      ensure(stack.length || !value.trim(), 400, 'INVALID_SITEMAP', 'Sitemap 根节点之外含有内容。');
      if (stack.at(-1)?.local === 'loc') text += value;
      continue;
    }
    const closing = token.startsWith('</');
    const match = token.match(closing ? /^<\/([A-Za-z_][\w.:-]*)\s*>$/ : /^<([A-Za-z_][\w.:-]*)(?:\s+[^<>]*)?\s*\/?\s*>$/);
    ensure(match, 400, 'INVALID_SITEMAP', 'Sitemap XML 标签格式不正确。');
    const name = match[1], local = name.split(':').at(-1);
    if (closing) {
      ensure(stack.length && stack.at(-1).name === name, 400, 'INVALID_SITEMAP', 'Sitemap XML 标签未正确闭合。');
      if (local === 'loc') {
        const parent = stack.at(-2)?.local;
        ensure((root === 'urlset' && parent === 'url') || (root === 'sitemapindex' && parent === 'sitemap'), 400, 'INVALID_SITEMAP', 'Sitemap 链接的位置不正确。');
        ensure(text.trim().length > 0 && text.length <= 4096, 400, 'INVALID_SITEMAP', 'Sitemap 含有空链接或超长链接。');
        locations.push(text.trim()); text = '';
        ensure(locations.length <= MAX_URLS, 413, 'SITEMAP_TOO_LARGE', 'Sitemap 最多支持 2000 个页面，请缩小范围。');
      }
      stack.pop();
      if (!stack.length) rootClosed = true;
    } else {
      ensure(!rootClosed && stack.length < 16, 400, 'INVALID_SITEMAP', 'Sitemap XML 层级不正确。');
      ensure(stack.at(-1)?.local !== 'loc', 400, 'INVALID_SITEMAP', 'Sitemap 链接不能包含子标签。');
      if (!stack.length) {
        ensure(!root && ['urlset', 'sitemapindex'].includes(local), 400, 'INVALID_SITEMAP', '该地址不是 URL Sitemap 或 Sitemap 索引。');
        root = local;
      }
      if (!/\/\s*>$/.test(token)) stack.push({name, local});
      else if (!stack.length) rootClosed = true;
      if (local === 'loc') text = '';
    }
  }
  ensure(root && rootClosed && stack.length === 0, 400, 'INVALID_SITEMAP', 'Sitemap XML 未正确结束。');
  return {kind: root, locations};
}

async function rootSitemap(value) {
  const root = httpsURL(value, 'Sitemap');
  const context = {origin: root.origin, deadline: Date.now() + 25000, bytes: 0};
  const parsed = parseSitemap(await fetchXML(root, context));
  const locations = parsed.locations.map(location => {
    const target = httpsURL(location, 'Sitemap 中的链接');
    ensure(target.origin === root.origin, 400, 'SITEMAP_CROSS_SITE', '请使用只包含当前网站页面的 Sitemap。');
    return target.href;
  });
  return {root, context, parsed: {...parsed, locations}};
}

export async function inspectSitemap(value) {
  try {
    const {root, parsed} = await rootSitemap(value);
    return {url: root.href, kind: parsed.kind, children: parsed.kind === 'sitemapindex' ? [...new Set(parsed.locations)] : []};
  } catch (error) {
    if (error?.code && error?.status) throw error;
    ensure(false, 400, 'SITEMAP_FETCH_FAILED', '未能完整读取 Sitemap，请检查地址或稍后重试。');
  }
}

export function chooseSitemapChildren(sitemap, selectedSitemaps = []) {
  ensure(Array.isArray(selectedSitemaps) && selectedSitemaps.length <= MAX_MAPS && selectedSitemaps.every(url => typeof url === 'string'), 400, 'INVALID_SITEMAP_SELECTION', '请最多选择 20 个 Sitemap 分类。');
  if (sitemap.kind === 'sitemapindex') {
    ensure(selectedSitemaps.length > 0, 409, 'SITEMAP_SELECTION_REQUIRED', '这是 Sitemap 索引，请先选择要导入的页面分类。', {sitemap});
    ensure(new Set(selectedSitemaps).size === selectedSitemaps.length && selectedSitemaps.every(url => sitemap.children.includes(url)), 400, 'INVALID_SITEMAP_SELECTION', '所选分类已变化，请重新读取 Sitemap 索引后选择。');
  } else ensure(selectedSitemaps.length === 0, 400, 'INVALID_SITEMAP_SELECTION', '这是页面 Sitemap，无需选择子分类。');
  return [...selectedSitemaps];
}

export async function readSitemap(value, {selectedSitemaps = []} = {}) {
  ensure(Array.isArray(selectedSitemaps) && selectedSitemaps.length <= MAX_MAPS && selectedSitemaps.every(url => typeof url === 'string'), 400, 'INVALID_SITEMAP_SELECTION', '请最多选择 20 个 Sitemap 分类。');
  let root, context, rootParsed;
  try { ({root, context, parsed: rootParsed} = await rootSitemap(value)); } catch (error) {
    if (error?.code && error?.status) throw error;
    ensure(false, 400, 'SITEMAP_FETCH_FAILED', '未能完整读取 Sitemap，请检查地址或稍后重试。');
  }
  const declared = [...new Set(rootParsed.locations)];
  selectedSitemaps = chooseSitemapChildren({url: root.href, kind: rootParsed.kind, children: rootParsed.kind === 'sitemapindex' ? declared : []}, selectedSitemaps);
  const visited = new Set(), pages = new Set();
  async function visit(url, depth, existingParsed) {
    if (visited.has(url.href)) return;
    ensure(depth <= 3 && visited.size < MAX_MAPS, 413, 'SITEMAP_TOO_LARGE', 'Sitemap 索引层级或文件数量过多，请缩小范围。');
    visited.add(url.href);
    const parsed = existingParsed || parseSitemap(await fetchXML(url, context));
    const locations = depth === 0 && parsed.kind === 'sitemapindex' ? selectedSitemaps : parsed.locations;
    for (const location of locations) {
      const target = httpsURL(location, 'Sitemap 中的链接');
      ensure(target.origin === root.origin, 400, 'SITEMAP_CROSS_SITE', '请使用只包含当前网站页面的 Sitemap。');
      if (parsed.kind === 'sitemapindex') await visit(target, depth + 1);
      else {
        pages.add(target.href);
        ensure(pages.size <= MAX_URLS, 413, 'SITEMAP_TOO_LARGE', 'Sitemap 最多支持 2000 个页面，请缩小范围。');
      }
    }
  }
  try { await visit(root, 0, rootParsed); } catch (error) {
    if (error?.code && error?.status) throw error;
    ensure(false, 400, 'SITEMAP_FETCH_FAILED', '未能完整读取 Sitemap，请检查地址或稍后重试。');
  }
  // Empty valid maps do not silently remove an existing landing-page inventory.
  ensure(pages.size > 0, 400, 'EMPTY_SITEMAP', 'Sitemap 中没有可导入的页面，原落地页库保持不变。');
  return {url: root.href, urls: [...pages], selectedSitemaps: [...selectedSitemaps]};
}
