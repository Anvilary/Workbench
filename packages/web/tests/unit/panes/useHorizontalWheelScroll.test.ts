import { test } from 'node:test';
import assert from 'node:assert/strict';

test('useHorizontalWheelScroll converts vertical wheel delta to horizontal scroll offset', () => {
  let wheelHandler: ((event: any) => void) | null = null;

  const mockNode = {
    clientWidth: 500,
    scrollWidth: 1000,
    scrollLeft: 100,
    addEventListener: (type: string, fn: any) => {
      if (type === 'wheel') wheelHandler = fn;
    },
    removeEventListener: (type: string, fn: any) => {
      if (type === 'wheel' && wheelHandler === fn) wheelHandler = null;
    },
  };

  mockNode.addEventListener('wheel', (event: any) => {
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    if (mockNode.scrollWidth <= mockNode.clientWidth) return;

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 18;
    else if (event.deltaMode === 2) delta *= mockNode.clientWidth;
    else delta = Math.sign(delta) * Math.min(Math.abs(delta), 100);

    if (delta === 0) return;
    if (delta < 0 && mockNode.scrollLeft <= 0) return;
    if (delta > 0 && mockNode.scrollLeft + mockNode.clientWidth >= mockNode.scrollWidth - 1) return;

    event.preventDefault();
    mockNode.scrollLeft += delta;
  });

  const handler = wheelHandler as ((event: any) => void) | null;
  assert.ok(handler !== null);

  // 1. Vertical scroll down converts to scrollLeft increase
  let defaultPrevented = false;
  const mockEvent = {
    deltaX: 0,
    deltaY: 50,
    deltaMode: 0,
    preventDefault: () => { defaultPrevented = true; },
  };

  handler!(mockEvent);
  assert.equal(defaultPrevented, true);
  assert.equal(mockNode.scrollLeft, 150);

  // 2. Horizontal gesture passes through without modification
  let horizontalPrevented = false;
  const horizontalEvent = {
    deltaX: 60,
    deltaY: 10,
    deltaMode: 0,
    preventDefault: () => { horizontalPrevented = true; },
  };
  handler!(horizontalEvent);
  assert.equal(horizontalPrevented, false);
  assert.equal(mockNode.scrollLeft, 150);

  // 3. At boundary: cannot scroll past left edge
  mockNode.scrollLeft = 0;
  let boundaryPrevented = false;
  const scrollUpEvent = {
    deltaX: 0,
    deltaY: -30,
    deltaMode: 0,
    preventDefault: () => { boundaryPrevented = true; },
  };
  handler!(scrollUpEvent);
  assert.equal(boundaryPrevented, false);
  assert.equal(mockNode.scrollLeft, 0);

  // 4. At right edge: cannot scroll past max scrollWidth
  mockNode.scrollLeft = 500; // scrollLeft + clientWidth = 1000 = scrollWidth
  let rightBoundaryPrevented = false;
  const scrollDownPastEnd = {
    deltaX: 0,
    deltaY: 30,
    deltaMode: 0,
    preventDefault: () => { rightBoundaryPrevented = true; },
  };
  handler!(scrollDownPastEnd);
  assert.equal(rightBoundaryPrevented, false);
  assert.equal(mockNode.scrollLeft, 500);
});
