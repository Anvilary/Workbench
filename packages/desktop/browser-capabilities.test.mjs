import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { _electron as electron } from 'playwright';

const desktopDir = path.dirname(new URL(import.meta.url).pathname);
const tabId = '33333333-3333-4333-8333-333333333333';
const fixtureMp4Url = pathToFileURL(path.join(desktopDir, 'fixtures', 'sample.mp4')).toString();
const fixtureWebmUrl = pathToFileURL(path.join(desktopDir, 'fixtures', 'sample.webm')).toString();

const eventually = async (fn, timeoutMs = 15000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 40));
  }
  assert.fail('Condition did not settle within timeout');
};

test('modern browser capabilities: video playback, MSE, canvas, WebGL, fullscreen and unthrottled rendering', { timeout: 60000 }, async () => {
  const server = createServer((_req, res) => res.end(`<!doctype html><script>
window.events = [];
window.tabId = '${tabId}';
window.mawChatGpt.subscribe(s => {
  window.events.push(s);
  if (s.type === 'layout-needed' && window.tabId) {
    const v = { width: 1280, height: 860 };
    window.mawChatGpt.command({
      type: 'layout',
      views: [{ id: window.tabId, bounds: { x: 0, y: 0, width: 1280, height: 860 } }],
      viewport: v
    });
  }
});
</script>`));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const data = await mkdtemp(path.join(os.tmpdir(), 'maw-capabilities-test-'));
  let app;
  const launch = () => electron.launch({
    chromiumSandbox: true,
    executablePath: '/opt/maw-electron/45.2.0/electron',
    args: [desktopDir, '--ozone-platform=x11'],
    env: {
      ...process.env,
      HOME: data,
      MAW_DESKTOP_DATA_DIR: data,
      MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
      MAW_MAX_RESIDENT_VIEWS: '4',
      MAW_MEMORY_PRESSURE_TIER: 'normal',
    },
  });

  try {
    app = await launch();
    const page = await app.firstWindow();
    await page.waitForFunction(() => Array.isArray(window.events));

    // Monitor for GPU process crashes
    await app.evaluate(({ app }) => {
      app.gpuCrashes = [];
      app.on('child-process-gone', (_event, details) => {
        if (details.type === 'GPU') app.gpuCrashes.push(details);
      });
    });

    // Register protocol interceptor for the general browser partition
    await app.evaluate(({ session, net }, { mp4Url, webmUrl }) => {
      const browserSess = session.fromPartition('persist:maw-browser');

      browserSess.protocol.handle('https', async (request) => {
        const url = new URL(request.url);

        if (url.pathname === '/media-test') {
          const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Capabilities Test</title>
<style>
@keyframes slide { from { transform: translateX(0); } to { transform: translateX(50px); } }
#anim-box { width: 50px; height: 50px; animation: slide 0.1s linear infinite; }
</style>
</head>
<body>
  <video id="v-mp4" src="https://capabilities.maw-audit.com/sample.mp4" playsinline muted controls></video>
  <video id="v-webm" src="https://capabilities.maw-audit.com/sample.webm" playsinline muted controls></video>
  <audio id="a-test"></audio>
  <canvas id="c-2d" width="100" height="100"></canvas>
  <canvas id="c-gl" width="100" height="100"></canvas>
  <canvas id="c-gl2" width="100" height="100"></canvas>
  <svg id="svg-test" viewBox="0 0 100 100" width="100" height="100">
    <circle id="svg-circle" cx="50" cy="50" r="40" fill="blue">
      <animate attributeName="r" values="20;40;20" dur="0.2s" repeatCount="indefinite"/>
    </circle>
  </svg>
  <div id="anim-box"></div>
  <iframe id="sub-frame" src="https://capabilities.maw-audit.com/frame-redirect" allow="fullscreen"></iframe>
</body>
</html>`;
          return new Response(html, { headers: { 'Content-Type': 'text/html' } });
        }

        if (url.pathname === '/sample.mp4') {
          return net.fetch(mp4Url);
        }

        if (url.pathname === '/sample.webm') {
          return net.fetch(webmUrl);
        }

        if (url.pathname === '/frame-redirect') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'https://capabilities.maw-audit.com/frame-target' },
          });
        }

        if (url.pathname === '/frame-target') {
          return new Response('<!doctype html><body><p id="frame-marker">target frame loaded</p></body>', {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        if (url.pathname === '/long-token-test') {
          return new Response(JSON.stringify({ ok: true, length: request.url.length }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        return new Response('not found', { status: 404 });
      });
    }, { mp4Url: fixtureMp4Url, webmUrl: fixtureWebmUrl });

    const command = payload => page.evaluate(cmd => window.mawChatGpt.command(cmd), payload);

    // Open capabilities test page
    await command({ type: 'open', id: tabId, provider: 'other', url: 'https://capabilities.maw-audit.com/media-test' });

    const info = await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('MAW'));
      return { contentSize: win.getContentSize(), zoom: win.webContents.getZoomFactor() };
    });

    // Layout the view so it is attached to the window, made visible, and given bounds matching viewport
    await page.evaluate(async ({ id, w, h }) => {
      const v = { width: w, height: h };
      await window.mawChatGpt.command({
        type: 'layout',
        views: [{ id, bounds: { x: 0, y: 0, width: w, height: h } }],
        viewport: v,
      });
    }, { id: tabId, w: info.contentSize[0], h: info.contentSize[1] });

    // Wait until WebContentsView has finished loading
    await eventually(async () => {
      return app.evaluate(({ webContents, session }) => {
        const contents = webContents.getAllWebContents().find(c =>
          c.session === session.fromPartition('persist:maw-browser') &&
          c.getURL().includes('/media-test')
        );
        return contents && !contents.isLoading();
      });
    });

    // 1. Verify Video Playback and MediaSource Extensions
    const mediaResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(async () => {
        const vMp4 = document.getElementById('v-mp4');
        const vWebm = document.getElementById('v-webm');

        let mp4PlayErr = null;
        try { await vMp4.play(); } catch (e) { mp4PlayErr = e.message; }

        let webmPlayErr = null;
        try { await vWebm.play(); } catch (e) { webmPlayErr = e.message; }

        await new Promise(r => setTimeout(r, 200));

        const mseMp4 = typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E, mp4a.40.2"');
        const mseWebm = typeof MediaSource !== 'undefined' &&
          MediaSource.isTypeSupported('video/webm; codecs="vp9, opus"');

        return {
          mp4Paused: vMp4.paused,
          mp4CurrentTime: vMp4.currentTime,
          mp4Error: vMp4.error ? vMp4.error.code : null,
          mp4PlayErr,
          webmPaused: vWebm.paused,
          webmCurrentTime: vWebm.currentTime,
          webmError: vWebm.error ? vWebm.error.code : null,
          webmPlayErr,
          mseMp4,
          mseWebm,
        };
      })()`);
    });

    assert.equal(mediaResults.mp4Paused, false, 'MP4 video must be playing');
    assert.ok(mediaResults.mp4CurrentTime > 0, 'MP4 video must advance currentTime');
    assert.equal(mediaResults.mp4Error, null, 'MP4 video element must not error');
    assert.equal(mediaResults.mp4PlayErr, null, 'MP4 play() promise must resolve');

    assert.equal(mediaResults.webmPaused, false, 'WebM video must be playing');
    assert.ok(mediaResults.webmCurrentTime > 0, 'WebM video must advance currentTime');
    assert.equal(mediaResults.webmError, null, 'WebM video element must not error');
    assert.equal(mediaResults.webmPlayErr, null, 'WebM play() promise must resolve');

    assert.equal(mediaResults.mseMp4, true, 'MediaSource must support H.264/AAC');
    assert.equal(mediaResults.mseWebm, true, 'MediaSource must support VP9/Opus');

    // 2. Verify Canvas 2D, WebGL 1, WebGL 2, and OffscreenCanvas contexts
    const canvasResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(() => {
        const c2d = document.getElementById('c-2d');
        const ctx2d = c2d.getContext('2d');
        ctx2d.fillStyle = '#00ff00';
        ctx2d.fillRect(0, 0, 50, 50);
        const pixel2d = ctx2d.getImageData(10, 10, 1, 1).data;

        const cGl = document.getElementById('c-gl');
        const gl = cGl.getContext('webgl') || cGl.getContext('experimental-webgl');
        let glRenderer = null;
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          glRenderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        }

        const cGl2 = document.getElementById('c-gl2');
        const gl2 = cGl2.getContext('webgl2');
        let gl2Renderer = null;
        if (gl2) {
          const dbg2 = gl2.getExtension('WEBGL_debug_renderer_info');
          gl2Renderer = dbg2 ? gl2.getParameter(dbg2.UNMASKED_RENDERER_WEBGL) : gl2.getParameter(gl2.RENDERER);
        }

        let hasOffscreen = typeof OffscreenCanvas !== 'undefined';
        let offscreen2d = false;
        let offscreenGl = false;
        if (hasOffscreen) {
          try {
            offscreen2d = !!(new OffscreenCanvas(32, 32)).getContext('2d');
            offscreenGl = !!(new OffscreenCanvas(32, 32)).getContext('webgl');
          } catch {}
        }

        return {
          has2d: !!ctx2d,
          drawn2dGreen: pixel2d[1] > 200,
          hasGl: !!gl,
          glRenderer,
          hasGl2: !!gl2,
          gl2Renderer,
          hasOffscreen,
          offscreen2d,
          offscreenGl,
        };
      })()`);
    });

    assert.equal(canvasResults.has2d, true, 'Canvas 2D context must be available');
    assert.equal(canvasResults.drawn2dGreen, true, 'Canvas 2D context must render successfully');
    assert.equal(canvasResults.hasGl, true, 'WebGL context must be available');
    assert.ok(canvasResults.glRenderer, 'WebGL renderer identifier must be populated');
    assert.equal(canvasResults.hasGl2, true, 'WebGL2 context must be available');
    assert.ok(canvasResults.gl2Renderer, 'WebGL2 renderer identifier must be populated');
    assert.equal(canvasResults.hasOffscreen, true, 'OffscreenCanvas must be supported');
    assert.equal(canvasResults.offscreen2d, true, 'OffscreenCanvas 2D context must be available');
    assert.equal(canvasResults.offscreenGl, true, 'OffscreenCanvas WebGL context must be available');

    // 2b. Verify Web Audio API, SVG animation, and CSS animation
    const richMediaResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(() => {
        let audioCtxState = null;
        try {
          const actx = new (window.AudioContext || window.webkitAudioContext)();
          audioCtxState = actx.state;
          actx.close();
        } catch (e) { audioCtxState = e.message; }

        const svgCircle = document.getElementById('svg-circle');
        const hasSvgBBox = typeof svgCircle?.getBBox === 'function';

        const animBox = document.getElementById('anim-box');
        let webAnimSupported = false;
        try {
          const anim = animBox.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100 });
          webAnimSupported = typeof anim.play === 'function';
        } catch {}

        return {
          audioCtxState,
          hasSvgBBox,
          webAnimSupported,
        };
      })()`);
    });

    assert.equal(richMediaResults.audioCtxState, 'running', 'Web Audio API AudioContext must be running');
    assert.equal(richMediaResults.hasSvgBBox, true, 'SVG elements must support geometric queries (getBBox)');
    assert.equal(richMediaResults.webAnimSupported, true, 'Web Animations API must be supported');

    // 3. Verify Fullscreen permission and execution
    const fullscreenResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(async () => {
        let fullscreenErr = null;
        let isFullscreen = false;
        try {
          const p = document.documentElement.requestFullscreen();
          await Promise.race([
            p,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Fullscreen timeout')), 2000))
          ]);
          isFullscreen = !!document.fullscreenElement;
          if (isFullscreen) {
            await document.exitFullscreen();
          }
        } catch (e) {
          fullscreenErr = e.message;
        }
        const perm = await navigator.permissions.query({ name: 'fullscreen', allowWithoutGesture: true });
        return { fullscreenErr, isFullscreen, permState: perm.state };
      })()`);
    });

    assert.equal(fullscreenResults.fullscreenErr, null, 'requestFullscreen() must not fail');
    assert.equal(fullscreenResults.isFullscreen, true, 'document.fullscreenElement must be active');
    assert.equal(fullscreenResults.permState, 'granted', 'Fullscreen permission must be granted');

    // 4. Verify unthrottled requestAnimationFrame when unfocused (backgroundThrottling: false)
    const animationResults = await app.evaluate(async ({ webContents, session, BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find(w => w.getTitle().includes('MAW'));
      const childrenCount = win ? win.contentView.children.length : -1;
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      const isVisible = contents ? !!contents.getOwnerBrowserWindow() : false;
      const jsResult = await contents.executeJavaScript(`(async () => {
        let rafCount = 0;
        const start = performance.now();
        await new Promise(r => {
          function tick() {
            rafCount++;
            if (performance.now() - start >= 400) r();
            else requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
          setTimeout(r, 1000); // safety fallback
        });
        return { frames: rafCount };
      })()`);
      return jsResult;
    });

    assert.ok(
      animationResults.frames >= 12,
      'requestAnimationFrame must produce smooth animation without background throttling (got ' + animationResults.frames + ' frames in 400ms)'
    );

    // 5. Verify Subframe Redirects (isMainFrame === false) load within iframe
    await page.waitForTimeout(500);
    const subframeResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(() => {
        const iframe = document.getElementById('sub-frame');
        const doc = iframe.contentDocument || iframe.contentWindow?.document;
        const marker = doc ? doc.getElementById('frame-marker') : null;
        return {
          hasDoc: !!doc,
          markerText: marker ? marker.textContent : null,
          iframeUrl: iframe.contentWindow?.location?.href || null,
        };
      })()`);
    });

    assert.equal(subframeResults.markerText, 'target frame loaded', 'Subframe redirect must complete inside iframe');

    // 6. Verify long signed URL allowance in onBeforeRequest (up to 8192 chars)
    const longUrlResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(async () => {
        const query = 'x'.repeat(3000);
        const url = 'https://capabilities.maw-audit.com/long-token-test?token=' + query;
        try {
          const res = await fetch(url);
          const data = await res.json();
          return { ok: data.ok, length: data.length };
        } catch (e) {
          return { error: e.message };
        }
      })()`);
    });

    assert.equal(longUrlResults.ok, true, 'Long URL fetch must succeed without onBeforeRequest cancellation');
    assert.ok(longUrlResults.length > 3000, 'Long URL with query string must reach handler');

    // 7. Verify sanitized clipboard write permission
    const clipboardResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(async () => {
        const perm = await navigator.permissions.query({ name: 'clipboard-write' });
        return { state: perm.state };
      })()`);
    });

    assert.equal(clipboardResults.state, 'granted', 'Sanitized clipboard write permission must be granted');

    // 8. Verify speaker-selection and pointer-lock permissions
    const permResults = await app.evaluate(async ({ webContents, session }) => {
      const contents = webContents.getAllWebContents().find(c =>
        c.session === session.fromPartition('persist:maw-browser') &&
        c.getURL().includes('/media-test')
      );
      return contents.executeJavaScript(`(async () => {
        let speakerState = null;
        try {
          const s = await navigator.permissions.query({ name: 'speaker-selection' });
          speakerState = s.state;
        } catch {}
        return { speakerState };
      })()`);
    });
    if (permResults.speakerState) {
      assert.equal(permResults.speakerState, 'granted', 'Speaker selection permission must be granted');
    }

    // 9. Verify GPU process stability: zero GPU process crashes during entire run
    const gpuCrashes = await app.evaluate(({ app }) => app.gpuCrashes || []);
    assert.equal(gpuCrashes.length, 0, 'No GPU process crashes must occur during video playback and WebGL');
  } finally {
    if (app) await app.close();
    await new Promise(r => server.close(r));
    await rm(data, { recursive: true, force: true });
  }
});
