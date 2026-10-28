/** Assertions shared by real PTY acceptance and their negative controls. */
export const executed = (output, marker) => output.includes(marker);
export const ansiGreen = (output, marker) => output.includes(`\x1b[32m${marker}\x1b[0m`);
export const interrupted = (output) => /INTERRUPT_STATUS:130(?:\r?\n)/.test(output);
export const exited = (session, expected) => session?.lifecycle === 'exited' &&
  Number.isInteger(session.exitCode) && (expected === undefined || session.exitCode === expected);

export function rejectedUpgrade(WebSocket, url, headers, expectedStatus = 403) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      error ? reject(error) : resolve(true);
    };
    const timer = setTimeout(() => finish(new Error('Upgrade refusal timed out')), 3000);
    socket.once('open', () => finish(new Error('Unexpected successful upgrade')));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      finish(response.statusCode === expectedStatus ? undefined :
        new Error(`Expected HTTP ${expectedStatus}, received ${response.statusCode}`));
    });
    socket.on('error', (error) => finish(error));
  });
}
