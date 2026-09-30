import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('production CSP permits Clerk bot protection without opening arbitrary frames', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const csp = config.headers.find(item => item.source === '/(.*)').headers.find(item => item.key === 'Content-Security-Policy').value;
  assert.match(csp, /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /connect-src [^;]*https:\/\/\*\.protect\.clerk\.com:\*/);
  assert.match(csp, /frame-src [^;]*https:\/\/challenges\.cloudflare\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
});
