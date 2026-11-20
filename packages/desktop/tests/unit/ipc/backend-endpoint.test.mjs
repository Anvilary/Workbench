import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackendEndpoint } from '../../../src/app/backend-endpoint.mjs';

test('the backend endpoint owns the current URL and hands shell storage over once', () => {
  const first = new URL('http://127.0.0.1:4100/?token=a');
  const second = new URL('http://127.0.0.1:4200/?token=b');
  const endpoint = createBackendEndpoint(first, { serviceUrl: () => first });
  assert.equal(endpoint.current().href, first.href);
  endpoint.set(second);
  assert.equal(endpoint.current().origin, 'http://127.0.0.1:4200');
  assert.equal(endpoint.takePendingShellStorage(), null);
  endpoint.setPendingShellStorage({ local: [['k', 'v']], session: [] });
  assert.deepEqual(endpoint.takePendingShellStorage(), { local: [['k', 'v']], session: [] });
  assert.equal(endpoint.takePendingShellStorage(), null);
});
