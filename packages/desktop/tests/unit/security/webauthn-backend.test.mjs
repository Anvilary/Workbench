import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  isFido2ToolsAvailable,
  discoverFido2Devices,
  getDeviceCapabilities,
  listResidentCredentials,
  executeAssertion,
  CANCELLED_MESSAGE,
} from '../../../src/security/webauthn/backend.mjs';

test('discoverFido2Devices parses device list accurately', async () => {
  const mockExec = async () => ({
    stdout: '/dev/hidraw3: vendor=0x1050, product=0x0406 (Yubico YubiKey FIDO+CCID)\n/dev/hidraw4: vendor=0x1050, product=0x0407 (Yubico YubiKey OTP+FIDO+CCID)\n',
  });

  const devices = await discoverFido2Devices(mockExec);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].path, '/dev/hidraw3');
  assert.equal(devices[0].vendor, '0x1050');
  assert.equal(devices[0].product, '0x0406');
  assert.equal(devices[0].description, 'Yubico YubiKey FIDO+CCID');

  assert.equal(devices[1].path, '/dev/hidraw4');
  assert.equal(devices[1].vendor, '0x1050');
  assert.equal(devices[1].product, '0x0407');
});

test('discoverFido2Devices returns empty array on failure or no devices', async () => {
  const failingExec = async () => { throw new Error('Device not found'); };
  const devices = await discoverFido2Devices(failingExec);
  assert.deepEqual(devices, []);
});

test('getDeviceCapabilities parses clientPin and retry counters', async () => {
  const mockExecWithPin = async () => ({
    stdout: 'proto: 0x02\noptions: rk, up, clientPin, credMgmt\npin retries: 5\nminpinlen: 6\n',
  });
  const caps = await getDeviceCapabilities('/dev/hidraw3', mockExecWithPin);
  assert.equal(caps.hasClientPin, true);
  assert.equal(caps.pinRetries, 5);
  assert.equal(caps.minPinLength, 6);

  const mockExecNoPin = async () => ({
    stdout: 'proto: 0x02\noptions: rk, up, noplat\npin retries: undefined\nminpinlen: 4\n',
  });
  const capsNoPin = await getDeviceCapabilities('/dev/hidraw4', mockExecNoPin);
  assert.equal(capsNoPin.hasClientPin, false);
  assert.equal(capsNoPin.pinRetries, null);
  assert.equal(capsNoPin.minPinLength, 4);
});

// Mock spawn process for testing child process lifecycle
class MockProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 99999;
    this.stdin = {
      written: [],
      write: (data) => { this.stdin.written.push(data); },
      end: () => { this.stdin.ended = true; },
      ended: false,
    };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }
  kill(signal) {
    this.killed = true;
    this.killSignal = signal;
  }
}

test('executeAssertion sends credential parameters and captures stdout successfully', async () => {
  const proc = new MockProcess();
  const mockSpawn = (cmd, args, opts) => {
    assert.equal(cmd, 'fido2-assert');
    assert.ok(args.includes('-G'));
    assert.ok(args.includes('/dev/hidraw3'));
    assert.equal(opts.detached, true);
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from('mock-assertion-stdout\n'));
      proc.emit('close', 0);
    });
    return proc;
  };

  const clientDataHash = Buffer.alloc(32, 0x12);
  const result = await executeAssertion({
    devicePath: '/dev/hidraw3',
    rpId: 'auth.openai.com',
    clientDataHash,
    credentialId: 'test-cred',
    pin: null,
    timeoutMs: 5000,
    spawnFn: mockSpawn,
  });

  assert.equal(result, 'mock-assertion-stdout\n');
  assert.ok(proc.stdin.written.join('').includes(clientDataHash.toString('base64')));
  assert.ok(proc.stdin.written.join('').includes('auth.openai.com'));
});

test('executeAssertion pipes PIN and captures assertion stdout without depending on stderr prompt', async () => {
  const proc = new MockProcess();
  const mockSpawn = (cmd, args) => {
    assert.ok(args.includes('-v'));
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from('pin-succeeded-assertion\n'));
      proc.emit('close', 0);
    });
    return proc;
  };

  const clientDataHash = Buffer.alloc(32, 0x34);
  const secretPin = 'super-secret-pin-1234';

  const result = await executeAssertion({
    devicePath: '/dev/hidraw3',
    rpId: 'auth.openai.com',
    clientDataHash,
    isResident: true,
    pin: secretPin,
    timeoutMs: 5000,
    spawnFn: mockSpawn,
  });

  assert.equal(result, 'pin-succeeded-assertion\n');
  assert.ok(proc.stdin.written.includes(secretPin + '\n'));
});

test('executeAssertion cleans up and rejects on cancellation signal', async () => {
  const proc = new MockProcess();
  const controller = new AbortController();

  const mockSpawn = () => {
    setImmediate(() => {
      controller.abort();
    });
    return proc;
  };

  const clientDataHash = Buffer.alloc(32, 0x56);
  await assert.rejects(
    async () => {
      await executeAssertion({
        devicePath: '/dev/hidraw3',
        rpId: 'auth.openai.com',
        clientDataHash,
        timeoutMs: 5000,
        signal: controller.signal,
        spawnFn: mockSpawn,
      });
    },
    (err) => err.message === CANCELLED_MESSAGE
  );
});

test('executeAssertion cleans up and rejects on timeout', async () => {
  const proc = new MockProcess();
  const mockSpawn = () => proc; // Never emits close

  const clientDataHash = Buffer.alloc(32, 0x78);
  await assert.rejects(
    async () => {
      await executeAssertion({
        devicePath: '/dev/hidraw3',
        rpId: 'auth.openai.com',
        clientDataHash,
        timeoutMs: 50,
        spawnFn: mockSpawn,
      });
    },
    /timed out after 50ms/
  );
});

test('discoverFido2Devices and getDeviceCapabilities time out instead of deadlocking', async () => {
  const hangingExec = () => new Promise(() => {});

  const devices = await discoverFido2Devices(hangingExec, { timeoutMs: 30 });
  assert.deepEqual(devices, []);

  const caps = await getDeviceCapabilities('/dev/hidraw0', hangingExec, {
    retries: 0,
    retryDelayMs: 0,
    timeoutMs: 30,
  });
  assert.equal(caps.probeError, true);
  assert.match(caps.error, /timed out/i);
});

test('executeAssertion and listResidentCredentials absorb async proc.stdin EPIPE errors without crashing', async () => {
  class EpipeMockProcess extends EventEmitter {
    constructor() {
      super();
      this.pid = 99998;
      this.stdin = new EventEmitter();
      this.stdin.write = () => {
        setImmediate(() => {
          const err = new Error('write EPIPE');
          err.code = 'EPIPE';
          this.stdin.emit('error', err);
        });
      };
      this.stdin.end = () => {};
      this.stdout = new EventEmitter();
      this.stderr = new EventEmitter();
    }
    kill() {}
  }

  const assertProc = new EpipeMockProcess();
  const mockSpawnAssert = () => {
    setImmediate(() => {
      assertProc.stderr.emit('data', Buffer.from('Enter PIN for /dev/hidraw0: '));
      setTimeout(() => assertProc.emit('close', 1), 15);
    });
    return assertProc;
  };
  await assert.rejects(
    () => executeAssertion({
      devicePath: '/dev/hidraw0',
      rpId: 'chatgpt.com',
      clientDataHash: Buffer.alloc(32, 1),
      pin: '1234',
      timeoutMs: 1000,
      spawnFn: mockSpawnAssert,
    }),
    /NotAllowedError/,
  );

  const listProc = new EpipeMockProcess();
  const mockSpawnList = () => {
    setImmediate(() => {
      listProc.stderr.emit('data', Buffer.from('Enter PIN for /dev/hidraw0: '));
      setTimeout(() => listProc.emit('close', 1), 15);
    });
    return listProc;
  };
  const creds = await listResidentCredentials({
    devicePath: '/dev/hidraw0',
    rpId: 'chatgpt.com',
    pin: '1234',
    timeoutMs: 1000,
    spawnFn: mockSpawnList,
  });
  assert.deepEqual(creds, []);
});
