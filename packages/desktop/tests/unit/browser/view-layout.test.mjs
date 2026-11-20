import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserViewState } from '../../../src/browser/view-state.mjs';
import { createViewLayout } from '../../../src/browser/view-layout.mjs';

function fakeView(name, log) {
  return {
    name,
    bounds: null,
    visible: false,
    focused: false,
    setBounds(bounds) { this.bounds = bounds; },
    setVisible(visible) { this.visible = visible; log.push(`${name}.visible=${visible}`); },
    webContents: {
      isDestroyed: () => false,
      isFocused: () => false,
      focus() { log.push(`${name}.focus`); },
      setBackgroundThrottling(value) { log.push(`${name}.throttle=${value}`); },
    },
  };
}

function setup() {
  const log = [];
  const children = new Set();
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    getContentSize: () => [1000, 800],
    webContents: { getZoomFactor: () => 1 },
    contentView: { addChildView: (v) => children.add(v), removeChildView: (v) => children.delete(v) },
  };
  const state = createBrowserViewState();
  const sent = [];
  const layout = createViewLayout({ win, send: (m) => sent.push(m), state });
  const a = fakeView('a', log);
  const b = fakeView('b', log);
  state.views.set('a', a);
  state.views.set('b', b);
  return { layout, state, children, log, sent, a, b };
}
const rect = (x) => ({ x, y: 0, width: 400, height: 300 });
const viewport = { width: 1000, height: 800 };

test('layout attaches the visible views with their bounds and focuses the requested one', () => {
  const { layout, state, children, a, b } = setup();
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }, { id: 'b', bounds: rect(500) }] });
  assert.deepEqual([...state.attachedViews.keys()].sort(), ['a', 'b']);
  assert.equal(children.size, 2);
  assert.deepEqual(a.bounds, { x: 0, y: 0, width: 400, height: 300 });
  assert.deepEqual(b.bounds, { x: 500, y: 0, width: 400, height: 300 });
  assert.ok(a.visible && b.visible);
  assert.equal(state.layoutFocusedId, 'a');
  assert.equal(state.reportedFocusedId, 'a');
});

test('layout detaches a view that is no longer visible and keeps the others attached', () => {
  const { layout, state, children, a, b } = setup();
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }, { id: 'b', bounds: rect(500) }] });
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }] });
  assert.deepEqual([...state.attachedViews.keys()], ['a']);
  assert.equal(children.has(b), false);
  assert.equal(b.visible, false);
  assert.equal(children.has(a), true);
});

test('an empty layout or a layout with unusable geometry hides every view', () => {
  const { layout, state, children } = setup();
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }] });
  layout.applyLayout({ type: 'layout', focusedId: null, viewport, views: [] });
  assert.equal(state.attachedViews.size, 0);
  assert.equal(children.size, 0);
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }] });
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport: { width: 10, height: 10 }, views: [{ id: 'a', bounds: rect(0) }] });
  assert.equal(children.size, 1, 'a view with invalid geometry is not attached again and the valid one stays');
});

test('invalidate hides everything and asks the shell for a new layout', () => {
  const { layout, state, children, sent } = setup();
  layout.applyLayout({ type: 'layout', focusedId: 'a', viewport, views: [{ id: 'a', bounds: rect(0) }] });
  layout.invalidate();
  assert.equal(state.attachedViews.size, 0);
  assert.equal(children.size, 0);
  assert.deepEqual(sent, [{ type: 'layout-needed' }]);
});
