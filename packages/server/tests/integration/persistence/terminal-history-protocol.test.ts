import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClientMessage } from '@agent-workbench/shared';

const valid = { type: 'terminal.history.page', terminalId: 'test-terminal', requestId: 'request', page: 0 };
test('history protocol accepts bounded requests and rejects malformed or oversized requests', () => {
  assert.deepEqual(parseClientMessage(JSON.stringify(valid)), { ...valid, pageSize: 1000, direction: 'backward' });
  const invalid = [
    { page: -1 }, { page: 1.5 }, { page: 1_000_001 }, { page: Number.MAX_SAFE_INTEGER },
    { page: '0' }, { pageSize: 0 }, { pageSize: 1001 }, { pageSize: 1.5 }, { pageSize: '1000' },
    { direction: 'invalid' }, { requestId: '' }, { requestId: 'r'.repeat(129) },
    { terminalId: '' }, { terminalId: {} }, { requestId: {} },
  ];
  for (const fields of invalid) assert.equal(parseClientMessage(JSON.stringify({ ...valid, ...fields })), null, JSON.stringify(fields));
});
