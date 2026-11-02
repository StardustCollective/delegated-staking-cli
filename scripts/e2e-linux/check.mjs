// Checks the transcript and the saved key file. Prints a PASS/FAIL summary and never the secrets.
import fs from 'node:fs';
import path from 'node:path';

const [file, codeArg, home] = process.argv.slice(2);
const code = Number(codeArg);
const key = process.env.DSC_E2E_KEY;
const password = process.env.DSC_E2E_PASSWORD;
const raw = fs.readFileSync(file, 'utf8');
const text = raw
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .replace(/\r/g, '')
  .replace(/(\? [^\n?]*?\[input is masked\])+/g, (m) => m.slice(m.lastIndexOf('? ')));

const failures = [];
const address = text.match(/Address: (DAG[A-Za-z0-9]+)/)?.[1];
const serverLine = text.split('\n').find((l) => l.includes('InsufficientRegistrationBalance'));

if (code !== 1) failures.push(`exit code was ${code}, expected 1`);
if (!serverLine) failures.push('no InsufficientRegistrationBalance in the output');
if (serverLine && !(serverLine.includes('Server response:') && serverLine.includes('balance=0'))) {
  failures.push('the server line lacks "Server response:" or balance=0');
}
if (!text.includes('Your balance (0 DAG) is under the minimum')) failures.push('no explanation ("Your balance (0 DAG) is under the minimum") in the output');
if (!address) failures.push('no address in the output');
for (const [name, needle] of [['key (lowercase)', key], ['key (uppercase)', key.toUpperCase()], ['password', password]]) {
  if (raw.includes(needle)) failures.push(`the output contains the ${name}`);
}
if (address) {
  const root = path.join(home, '.delegated-staking-cli');
  const dir = path.join(root, address);
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  try {
    if (mode(path.join(dir, 'key.p12')) !== '600') failures.push(`key.p12 mode is ${mode(path.join(dir, 'key.p12'))}, expected 600`);
    if (mode(root) !== '700') failures.push(`${root} mode is ${mode(root)}, expected 700`);
    if (mode(dir) !== '700') failures.push(`account directory mode is ${mode(dir)}, expected 700`);
  } catch {
    failures.push(`key.p12 is missing for ${address}`);
  }
}

// The raw transcript is never printed: the secrets are redacted first, even when none was found.
const redact = (t) => [key, key.toUpperCase(), password].reduce((acc, secret) => acc.replaceAll(secret, '[REDACTED]'), t);
console.log('----- transcript (escape codes removed, secrets redacted) -----');
console.log(redact(text).trim());
console.log('----- result -----');
console.log(`Address:    ${address ?? '(none)'}`);
console.log(`Exit code:  ${code}`);
console.log(`Server:     ${serverLine ? redact(serverLine).trim() : '(none)'}`);
if (failures.length) {
  console.log('FAIL');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS');
