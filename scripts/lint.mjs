import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

const files = await Promise.all(['src', 'api', 'test', 'scripts'].map(filesIn)).then(groups => groups.flat());
const failures = [];
for (const file of files) await new Promise(resolve => {
  const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
  child.on('exit', code => { if (code) failures.push(file); resolve(); });
});
if (failures.length) { console.error(`Lint failed in: ${failures.join(', ')}`); process.exit(1); }
console.log(`Lint passed for ${files.length} JavaScript files.`);
