import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const files = (await readdir(new URL('../tests/', import.meta.url)))
  .filter((name) => name.endsWith('.mjs'))
  .sort();
for (const file of files) {
  const result = spawnSync(process.execPath, [`tests/${file}`], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Passed ${files.length} test suites.`);
