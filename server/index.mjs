// SPDX-License-Identifier: MIT
import {randomBytes} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createApplication} from './app.mjs';

process.umask(0o077);
const mode = process.env.NODE_ENV || 'development';
const port = Number(process.env.PORT || 3000), host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
const dataDir = resolve(process.env.DATA_DIR || '.local');
mkdirSync(dataDir, {recursive: true, mode: 0o700});
function secret(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  if (mode === 'production') throw new Error(`Set ${envName} through your deployment secret configuration.`);
  const path = resolve(dataDir, fileName);
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('base64url'), {mode: 0o600, flag: 'wx'});
  return readFileSync(path, 'utf8').trim();
}
const app = await createApplication({dbPath: resolve(dataDir, 'console.sqlite'), storageEnv: process.env, baseURL: process.env.APP_URL || `http://127.0.0.1:${port}`, authSecret: secret('BETTER_AUTH_SECRET', 'auth-secret'), bootstrapToken: secret('BOOTSTRAP_TOKEN', 'bootstrap-token'), mode});
app.server.listen(port, host, () => {
  console.log(`Ad Growth Console team workspace: ${process.env.APP_URL || `http://127.0.0.1:${port}`}`);
  console.log('Local development data is private. First-time setup needs the bootstrap-token file in DATA_DIR; no secrets are printed.');
});
async function shutdown() { await app.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
