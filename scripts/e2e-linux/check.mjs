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
if (!text.includes('balance=0')) failures.push('no balance=0 in the output');
if (!address) failures.push('no address in the output');
for (const [name, needle] of [['key (lowercase)', key], ['key (uppercase)', key.toUpperCase()], ['password', password]]) {
  if (raw.includes(needle)) failures.push(`the output contains the ${name}`);
}
if (address) {
  const dir = path.join(home, '.delegated-staking-cli', address);
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  try {
    if (mode(path.join(dir, 'key.p12')) !== '600') failures.push(`key.p12 mode is ${mode(path.join(dir, 'key.p12'))}, expected 600`);
    if (mode(dir) !== '700') failures.push(`account directory mode is ${mode(dir)}, expected 700`);
  } catch {
    failures.push(`key.p12 is missing for ${address}`);
  }
}

console.log('----- transcript (escape codes removed) -----');
console.log(text.trim());
console.log('----- result -----');
console.log(`Address:    ${address ?? '(none)'}`);
console.log(`Exit code:  ${code}`);
console.log(`Server:     ${serverLine?.trim() ?? '(none)'}`);
if (failures.length) {
  console.log('FAIL');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS');
