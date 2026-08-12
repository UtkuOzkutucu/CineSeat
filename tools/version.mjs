/**
 * Print the current version, or the version a given bump would produce.
 *
 *   node tools/version.mjs          -> 1.0.2
 *   node tools/version.mjs patch    -> 1.0.3
 *   node tools/version.mjs minor    -> 1.1.0
 *   node tools/version.mjs major    -> 2.0.0
 *
 * A separate file rather than `node -p "…"` inside RELEASE.bat on purpose: a
 * batch `for /f ('command')` is delimited by single quotes, so any single quote
 * in the JavaScript ends the command early and Node receives a syntax error.
 * Keeping the logic here means the batch file never has to quote anything.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const { version } = JSON.parse(readFileSync(pkgPath, 'utf8'));

const bump = process.argv[2];
if (!bump) {
  console.log(version);
  process.exit(0);
}

const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);

const next = {
  major: `${major + 1}.0.0`,
  minor: `${major}.${minor + 1}.0`,
  patch: `${major}.${minor}.${patch + 1}`,
}[bump];

if (!next) {
  console.error(`bilinmeyen surum turu: ${bump}`);
  process.exit(1);
}

console.log(next);
