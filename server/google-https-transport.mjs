// SPDX-License-Identifier: MIT
// A proxy configured here applies only to the fixed Google reporting endpoints.
// It never changes global agents, TLS validation or the application's other fetches.
import {Agent, request} from 'node:https';
import {Readable} from 'node:stream';
import {AppError} from './errors.mjs';

export function createGoogleHttpsTransport(proxyValue) {
  let proxy;
  try {
    if (typeof proxyValue !== 'string' || proxyValue.length > 4096 || /[\u0000-\u0020\u007f]/.test(proxyValue)) throw new Error();
    proxy = new URL(proxyValue);
    if (!['http:', 'https:'].includes(proxy.protocol) || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error();
  } catch {
    throw new AppError(503, 'GOOGLE_CONFIG_INVALID', 'Google 数据连接的代理配置不正确，请由部署者检查。');
  }
  // Node 24 supports scoped proxyEnv. Do not inherit process-wide NO_PROXY or
  // proxy variables: this setting deliberately selects this reader's route.
  const agent = new Agent({proxyEnv:{HTTPS_PROXY:proxy.href}, maxSockets:4});
  return function googleFetch(rawUrl, options = {}) {
    const url = new URL(rawUrl);
    const allowed = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && (
      (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') ||
      (url.hostname === 'googleads.googleapis.com' && /^\/v[1-9]\d{1,2}\/customers\/\d{10}\/googleAds:search$/.test(url.pathname))
    );
    if (!allowed || options.method !== 'POST') return Promise.reject(new Error('Google transport destination rejected'));
    return new Promise((resolve, reject) => {
      const req = request(url, {agent, method:'POST', headers:options.headers, signal:options.signal}, response => {
        try {
          // HTTPS request never follows redirects. The reader rejects any 3xx.
          const headers = new Headers();
          for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
          const empty = [204, 205, 304].includes(response.statusCode);
          if (empty) response.resume();
          resolve(new Response(empty ? null : Readable.toWeb(response), {status:response.statusCode, headers}));
        } catch (error) {response.destroy(); reject(error);}
      });
      req.once('error', reject);
      req.end(options.body);
    });
  };
}
