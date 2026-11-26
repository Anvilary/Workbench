const warned = new Set();
const upstreamKeys = new Set(['CWD', 'DEBUG', 'NO_OPEN', 'NO_RESTORE', 'PORT']);

export function workbenchEnv(key, env = process.env) {
  const canonical = `WORKBENCH_${key}`;
  const legacy = [`MAW_${key}`];
  if (upstreamKeys.has(key)) legacy.push(`AGENT_WORKBENCH_${key}`);
  const first = env[canonical] ?? legacy.map(name => env[name]).find(value => value !== undefined);
  if (env[canonical] !== undefined) {
    for (const name of legacy) {
      if (env[name] === undefined || env[name] === first || warned.has(name)) continue;
      warned.add(name);
      console.warn(`Ignoring ${name} because ${canonical} is set`);
    }
  }
  return first;
}
