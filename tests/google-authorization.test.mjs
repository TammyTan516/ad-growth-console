// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Google authorization callback pages require actual private credential persistence before success', () => {
  const cwd=fileURLToPath(new URL('../', import.meta.url));
  const result=spawnSync(process.env.PYTHON3 || 'python3',['scripts/test_google_authorize.py'],{cwd,encoding:'utf8',timeout:20000,maxBuffer:128*1024});
  assert.equal(result.error,undefined,'stdlib Python callback test runner must be available');
  assert.equal(result.status,0,result.stderr || 'authorization callback checks failed');
  assert.match(result.stderr,/Ran 10 tests/);
  assert.match(result.stderr,/OK/);
});
