// SPDX-License-Identifier: MIT
import {betterAuth} from 'better-auth';
import {getMigrations} from 'better-auth/db/migration';
import {createHash} from 'node:crypto';

export async function createAuth({db, baseURL, secret, rateLimitMax = 15}) {
  const options = {
    appName: 'Ad Growth Console',
    baseURL,
    basePath: '/api/auth',
    secret,
    database: db,
    trustedOrigins: [baseURL],
    emailAndPassword: {enabled: true, minPasswordLength: 12, maxPasswordLength: 128, autoSignIn: false},
    session: {expiresIn: 60 * 60 * 8, updateAge: 60 * 60},
    rateLimit: {enabled: true, storage: 'database', window: 60, max: 100, customRules: {'/sign-in/email': {window: 60, max: rateLimitMax}}},
    telemetry: {enabled: false},
    advanced: {cookiePrefix: 'agc-' + createHash('sha256').update(baseURL).digest('hex').slice(0, 12), useSecureCookies: baseURL.startsWith('https://'), ipAddress: {ipAddressHeaders: ['x-console-client-ip']}},
  };
  const migration = await getMigrations(options);
  await migration.runMigrations();
  const auth = betterAuth(options);
  await auth.$context;
  // Await the library's schema-readiness check before accepting requests or closing.
  await auth.api.getSession({headers: new Headers()});
  return auth;
}
