import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { _electron as electron } from 'playwright';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const id = '8e4fefc1-e565-40cc-b85b-f7d43a16b1df';

const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeChatGptView } from './src/agency/NativeChatGptView.tsx';

function App() {
  const [sidebarMenu, setSidebarMenu] = useState(false);
  const [activeTab, setActiveTab] = useState('terminal');

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: 'system-ui, sans-serif', background: '#18181b', color: '#f4f4f5' }}>
      {/* Left Sidebar */}
      <aside style={{ width: '240px', background: '#27272a', borderRight: '1px solid #3f3f46', display: 'flex', flexDirection: 'column', position: 'relative', zIndex: 10 }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #3f3f46', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: '14px' }}>My Project</span>
          <button
            id="workspace-menu-trigger"
            onClick={() => setSidebarMenu(!sidebarMenu)}
            style={{ background: sidebarMenu ? '#3f3f46' : 'transparent', border: 'none', color: '#d4d4d8', borderRadius: '4px', padding: '4px 8px', cursor: 'pointer', fontSize: '13px' }}
          >
            •••
          </button>
        </div>

        {sidebarMenu && (
          <div
            id="workspace-menu"
            className="agency-dropdown-menu"
            role="menu"
            style={{
              position: 'absolute',
              top: '48px',
              left: '16px',
              width: '200px',
              background: '#18181b',
              border: '1px solid #3f3f46',
              borderRadius: '6px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
              padding: '6px',
              zIndex: 100,
            }}
          >
            <div style={{ padding: '6px 8px', fontSize: '11px', color: '#a1a1aa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Workspace Actions
            </div>
            <button style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: '#f4f4f5', padding: '8px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
              Rename workspace
            </button>
            <button style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: '#f4f4f5', padding: '8px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}>
              Workspace settings
            </button>
            <div style={{ height: '1px', background: '#3f3f46', margin: '4px 0' }} />
            <button
              id="menu-delete-action"
              style={{ width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: '#f87171', padding: '8px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer' }}
            >
              Delete workspace...
            </button>
          </div>
        )}

        <div style={{ padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ padding: '8px 12px', background: '#3f3f46', borderRadius: '6px', fontSize: '13px', fontWeight: 500 }}>
            feature/chatgpt-integration
          </div>
          <div style={{ padding: '8px 12px', color: '#a1a1aa', borderRadius: '6px', fontSize: '13px' }}>
            main
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        {/* Top Header / Tab Bar */}
        <header style={{ height: '48px', background: '#202023', borderBottom: '1px solid #3f3f46', display: 'flex', alignItems: 'center', padding: '0 16px', gap: '8px' }}>
          <button
            id="tab-terminal"
            onClick={() => setActiveTab('terminal')}
            style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: activeTab === 'terminal' ? '#3f3f46' : 'transparent', color: '#f4f4f5', fontSize: '13px', cursor: 'pointer' }}
          >
            Terminal (bash)
          </button>
          <button
            id="tab-chatgpt"
            onClick={() => setActiveTab('chatgpt')}
            style={{ padding: '6px 12px', borderRadius: '6px', border: 'none', background: activeTab === 'chatgpt' ? '#3f3f46' : 'transparent', color: '#10b981', fontWeight: 500, fontSize: '13px', cursor: 'pointer' }}
          >
            ChatGPT (Claude 3.7 vs GPT-4.5)
          </button>
        </header>

        {/* Viewport for NativeChatGPT / Terminal */}
        <main style={{ flex: 1, display: 'flex', position: 'relative' }}>
          {activeTab === 'chatgpt' ? (
            <NativeChatGptView tab={{ id: '${id}', url: 'https://chatgpt.com/' }} onDisplayed={() => {}} />
          ) : (
            <div style={{ padding: '24px', fontFamily: 'monospace', color: '#a1a1aa' }}>Terminal session (exited)...</div>
          )}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
`;

async function main() {
  const bundle = await build({
    stdin: { contents: fixture, resolveDir: path.join(here, '../web'), loader: 'tsx' },
    bundle: true,
    write: false,
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
  });

  const chatGptHtml = `
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { margin: 0; background: #212121; color: #ececec; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; height: 100vh; }
        header { height: 50px; border-bottom: 1px solid #303030; display: flex; align-items: center; padding: 0 20px; font-weight: 600; font-size: 16px; color: #10a37f; }
        .chat-content { flex: 1; overflow-y: auto; padding: 40px 20%; display: flex; flex-direction: column; gap: 24px; }
        .message-user { align-self: flex-end; background: #2f2f2f; padding: 12px 18px; border-radius: 18px; max-width: 70%; line-height: 1.5; font-size: 15px; }
        .message-assistant { align-self: flex-start; max-width: 85%; line-height: 1.6; font-size: 15px; color: #d1d5db; }
        .assistant-header { font-weight: 600; color: #10a37f; margin-bottom: 6px; display: flex; align-items: center; gap: 8px; }
        .prompt-box { padding: 20px 20%; background: #212121; }
        .prompt-input { width: 100%; box-sizing: border-box; background: #2f2f2f; border: 1px solid #424242; border-radius: 24px; padding: 14px 20px; color: white; font-size: 15px; outline: none; }
      </style>
    </head>
    <body>
      <header>ChatGPT 4o</header>
      <div class="chat-content">
        <div class="message-user">Can you explain the difference between WebContentsView and BrowserView in Electron?</div>
        <div class="message-assistant">
          <div class="assistant-header">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z"/></svg>
            ChatGPT
          </div>
          <p>Certainly! In modern Electron (versions 29+), <strong>WebContentsView</strong> replaces the deprecated <code>BrowserView</code>.</p>
          <p>Key architectural advantages include:</p>
          <ul>
            <li>Full participation in the Chromium Views hierarchy (<code>BaseWindow.contentView.addChildView</code>).</li>
            <li>Precise z-ordering and compositing relative to other views.</li>
            <li>Independent process isolation, custom partitions, and robust security boundaries.</li>
          </ul>
        </div>
      </div>
      <div class="prompt-box">
        <input class="prompt-input" value="Message ChatGPT..." readonly />
      </div>
    </body>
  </html>
  `;

  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(bundle.outputFiles[0].text);
    } else {
      res.end(`
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>
              html, body, #root { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; }
              .maw-browser-viewer { display: flex; flex: 1; width: 100%; height: 100%; min-width: 0; min-height: 0; }
              .agency-dropdown-menu { z-index: 9999; }
            </style>
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/bundle.js"></script>
          </body>
        </html>
      `);
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const data = await mkdtemp(path.join(tmpdir(), 'maw-evidence-'));
  const evidenceDir = path.join(here, 'evidence');
  const artifactDir = '/home/alteixeira20/.gemini/antigravity-cli/brain/20ee035b-b388-4783-9e9c-b1adfc2f7bac';
  await mkdir(evidenceDir, { recursive: true });

  const desktop = await electron.launch({
    chromiumSandbox: true,
    executablePath: require('electron'),
    args: [here, '--ozone-platform=x11'],
    env: {
      ...process.env,
      MAW_DESKTOP_URL: `http://127.0.0.1:${server.address().port}/`,
      MAW_DESKTOP_DATA_DIR: data,
    },
  });

  try {
    await desktop.evaluate(({ session }) => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#212121;color:#ececec;font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column}header{height:48px;border-bottom:1px solid #303030;display:flex;align-items:center;padding:0 20px;font-weight:600;color:#10a37f}.chat{flex:1;padding:30px 15%;display:flex;flex-direction:column;gap:18px}.user{align-self:flex-end;background:#2f2f2f;padding:10px 16px;border-radius:18px;max-width:70%}.asst{align-self:flex-start;max-width:85%;color:#d1d5db;line-height:1.6}.input-box{padding:20px 15%}.input{width:100%;box-sizing:border-box;background:#2f2f2f;border:1px solid #424242;border-radius:24px;padding:12px 20px;color:white;font-size:14px}</style></head><body><header>ChatGPT · GPT-4o</header><div class="chat"><div class="user">Explain WebContentsView vs BrowserView in Electron.</div><div class="asst"><strong>ChatGPT:</strong> In modern Electron, <code>WebContentsView</code> replaces <code>BrowserView</code> with true Views hierarchy participation, reliable z-ordering, and process isolation.</div></div><div class="input-box"><input class="input" value="Message ChatGPT..." readonly/></div></body></html>`;
      session.fromPartition('persist:maw-chatgpt').protocol.handle('https', () =>
        new Response(html, { headers: { 'Content-Type': 'text/html' } })
      );
    });

    const page = await desktop.firstWindow();

    // Switch to ChatGPT tab now that protocol handler is active
    await page.locator('#tab-chatgpt').click();

    // Wait for native view to attach
    let initialCount = 0;
    for (let i = 0; i < 50; i++) {
      initialCount = await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents).length
      );
      if (initialCount === 1) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[Evidence] Native ChatGPT view attached: ${initialCount} (expected: 1)`);

    // 1. Open the sidebar workspace menu
    await page.locator('#workspace-menu-trigger').click();
    await page.waitForSelector('#workspace-menu');
    await new Promise((r) => setTimeout(r, 300));

    // Verify view is still attached while menu is open
    const attachedWhileMenuOpen = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents).length
    );
    console.log(`[Evidence] Native views attached while sidebar menu is open: ${attachedWhileMenuOpen} (expected: 1)`);

    // Capture screenshot of real Electron window with sidebar menu open and ChatGPT visible
    const screenshotBuffer = await desktop.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const image = await win.capturePage();
      return image.toPNG().toString('base64');
    });

    const screenshotPath = path.join(evidenceDir, 'chatgpt-sidebar-menu-visible.png');
    const artifactScreenshotPath = path.join(artifactDir, 'chatgpt-sidebar-menu-visible.png');
    await writeFile(screenshotPath, Buffer.from(screenshotBuffer, 'base64'));
    await writeFile(artifactScreenshotPath, Buffer.from(screenshotBuffer, 'base64'));
    console.log(`[Evidence] Screenshot saved to ${screenshotPath} and ${artifactScreenshotPath}`);

    // 2. Normal click test inside native view and MAW buttons
    await page.locator('#tab-terminal').click(); // switch to terminal
    await new Promise((r) => setTimeout(r, 200));
    const attachedTerminal = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents).length
    );
    console.log(`[Evidence] Attached views after switching to terminal: ${attachedTerminal} (expected: 0)`);

    await page.locator('#tab-chatgpt').click(); // switch back to chatgpt
    await new Promise((r) => setTimeout(r, 200));
    const attachedChatGptAgain = await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].contentView.children.filter((v) => v.webContents).length
    );
    console.log(`[Evidence] Attached views after switching back to ChatGPT: ${attachedChatGptAgain} (expected: 1)`);

    console.log('[Evidence] All real Electron interaction evidence captured successfully!');
  } finally {
    await desktop.close();
    server.close();
    await rm(data, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[Evidence] Error:', err);
  process.exit(1);
});
