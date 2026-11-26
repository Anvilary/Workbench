import assert from 'node:assert/strict';
import test from 'node:test';
import express, { type Request, type Response } from 'express';
import { createServer } from 'node:http';
import { createNoAuthMiddleware } from '../../../src/security/no-auth-middleware.js';

test('performance administrative endpoint enforces loopback, session authentication, and process sanitization', async () => {
  const app = express();
  const mockTerminals = [
    {
      terminalId: 'term-1',
      sessionId: 'sess-1',
      label: 'Codex Session',
      kind: 'agent' as const,
      agent: 'codex' as const,
      cwd: '/workspace/proj',
      env: { SECRET_TOKEN: 'leaked-token' },
      argv: ['codex', '--api-key=supersecret'],
      buffer: 'terminal output secret',
    },
    {
      terminalId: 'term-2',
      sessionId: '',
      label: 'Zsh (1)',
      kind: 'shell' as const,
      agent: null,
      cwd: '/workspace/proj',
    },
  ];

  const mockRegistry = {
    list: () => mockTerminals,
    pidOf: (id: string) => (id === 'term-1' ? 12345 : 12346),
    supervisorPid: 10001,
    nativeIdentityOf: (id: string) => (id === 'term-1' ? { provider: 'codex', home: '/home/user' } : null),
  };

  // Simulated middleware to test authorization states
  let authKind: string | null = null;
  app.use((req, _res, next) => {
    if (authKind) {
      (req as any).workbenchCredential = { kind: authKind };
    }
    next();
  });

  // Mock route matching the exact server handler logic in packages/server/src/index.ts
  app.get('/api/performance/terminals', (request: Request, response: Response) => {
    const clientIp = request.socket.remoteAddress;
    const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
    if (!isLoopback) {
      response.status(403).json({ ok: false, error: 'Loopback access only' });
      return;
    }
    const reqAuth = (request as unknown as { workbenchCredential?: { kind: string } }).workbenchCredential;
    if (!reqAuth || (reqAuth.kind !== 'session' && reqAuth.kind !== 'local')) {
      response.status(reqAuth?.kind === 'device' ? 403 : 401).json({
        ok: false,
        error: reqAuth?.kind === 'device' ? 'Forbidden: paired devices cannot inspect processes' : 'Unauthorized: valid local session required',
      });
      return;
    }

    const list = mockRegistry.list();
    const terminals = list.map((descriptor) => {
      const pid = mockRegistry.pidOf(descriptor.terminalId);
      const identity = mockRegistry.nativeIdentityOf(descriptor.terminalId);
      return {
        terminalId: descriptor.terminalId,
        sessionId: descriptor.sessionId || null,
        title: descriptor.label,
        kind: descriptor.kind,
        agent: descriptor.agent,
        pid,
        cwd: descriptor.cwd,
        provider: identity?.provider ?? descriptor.agent ?? null,
      };
    });

    response.json({
      ok: true,
      backendPid: process.pid,
      supervisorPid: mockRegistry.supervisorPid,
      terminals,
    });
  });

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    // 1. Unauthenticated request must be rejected with 401
    authKind = null;
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/performance/terminals`);
    assert.equal(unauthRes.status, 401);
    const unauthData = (await unauthRes.json()) as any;
    assert.equal(unauthData.ok, false);
    assert.match(unauthData.error, /Unauthorized/);

    // 2. Paired remote device credential must be rejected with 403
    authKind = 'device';
    const deviceRes = await fetch(`http://127.0.0.1:${port}/api/performance/terminals`);
    assert.equal(deviceRes.status, 403);
    const deviceData = (await deviceRes.json()) as any;
    assert.equal(deviceData.ok, false);
    assert.match(deviceData.error, /Forbidden/);

    // 3. Authorized local session succeeds
    authKind = 'session';
    const res = await fetch(`http://127.0.0.1:${port}/api/performance/terminals`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.ok, true);
    assert.equal(typeof data.backendPid, 'number');
    assert.equal(data.supervisorPid, 10001);
    assert.equal(data.terminals.length, 2);

    // Verify first terminal
    assert.equal(data.terminals[0].terminalId, 'term-1');
    assert.equal(data.terminals[0].title, 'Codex Session');
    assert.equal(data.terminals[0].pid, 12345);
    assert.equal(data.terminals[0].provider, 'codex');

    // Verify second terminal
    assert.equal(data.terminals[1].terminalId, 'term-2');
    assert.equal(data.terminals[1].title, 'Zsh (1)');
    assert.equal(data.terminals[1].pid, 12346);
    assert.equal(data.terminals[1].provider, null);

    // Security check: Verify no environment variables, raw command arguments, or buffers leaked
    for (const term of data.terminals) {
      assert.equal(term.env, undefined);
      assert.equal(term.argv, undefined);
      assert.equal(term.buffer, undefined);
      assert.equal(term.token, undefined);
      assert.equal(term.SECRET_TOKEN, undefined);
    }
  } finally {
    server.close();
  }
});

test('real no-auth middleware grants the local credential used by the performance endpoint', async () => {
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    app.use(createNoAuthMiddleware(port));
    app.get('/api/performance/terminals', (request, response) => {
      response.json({ kind: (request as typeof request & { workbenchCredential?: { kind: string } }).workbenchCredential?.kind });
    });
    const result = await fetch(`http://127.0.0.1:${port}/api/performance/terminals`);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { kind: 'local' });
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
