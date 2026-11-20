/** Build a reviewed, non-secret host binding. Does not execute wrappers or read auth/history. */
import { readFile, writeFile } from 'node:fs/promises';
import { artifactDigest, NativeIdentities } from '../src/features/sessions/native-identity.ts';
const [specFile, output] = process.argv.slice(2);
if (!specFile || !output) throw new Error('Usage: tsx scripts/build-native-attestation.mjs reviewed-spec.json NEW-manifest.json');
const spec = JSON.parse(await readFile(specFile, 'utf8'));
if (!Array.isArray(spec.identities)) throw new Error('Missing reviewed identities');
const identities = [];
for (const row of spec.identities) {
  const artifacts = [];
  for (const file of row.artifacts) artifacts.push({ path: file, sha256: await artifactDigest(file) });
  identities.push({ ...row, artifacts });
}
await writeFile(output, JSON.stringify({ version: 2, identities }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
await NativeIdentities.load(output);
console.log(`Prepared ${identities.length} host bindings. No provider executed; no authentication inspected.`);
