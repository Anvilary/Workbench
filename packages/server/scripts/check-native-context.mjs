/** Read-only context check. No CLI executes and no auth/history files are opened. */
import { readFile } from 'node:fs/promises';
import { validateDefinition } from '../src/agents/profiles/definition.ts';
import { NativeIdentities } from '../src/agency/native-identity.ts';
import { resolveConfiguredExecutable } from '../src/agents/profiles/executable.ts';
const [profilesFile, identitiesFile] = process.argv.slice(2);
if (!profilesFile || !identitiesFile) throw new Error('Usage: tsx scripts/check-native-context.mjs profiles.json identities.json');
const raw = JSON.parse(await readFile(profilesFile, 'utf8'));
if (raw.schemaVersion !== 1 || !Array.isArray(raw.profiles)) throw new Error('Invalid profile store');
const profiles = raw.profiles.map(row => validateDefinition(row.id, row));
const identities = await NativeIdentities.load(identitiesFile);
let failed = false;
for (const profile of profiles) {
  const selected = await resolveConfiguredExecutable(profile.executable, process.env);
  const identity = await identities.verifiedForProfile(profile, process.env);
  console.log(JSON.stringify({ profile: profile.id, executable: selected.status === 'available' ? selected.file : null,
    uid: process.getuid?.(), home: process.env.HOME ?? null, verifiedStateRoot: identity?.home ?? null,
    contextVerified: identity !== null, authentication: 'not-probed' }));
  failed ||= identity === null;
}
process.exitCode = failed ? 1 : 0;
