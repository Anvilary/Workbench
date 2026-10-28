FINAL — BOUNDED AUDIT COMPLETE

Final decision: bounded audit complete; final continuation sections below and 08/09 supersede historical checkpoint limitations. No performance refactoring before QA; Group A/B corrections remain required.

# Functional Reliability

Audited source: `90a74a4fb12364e888e78cd72927f24898ca0950`
Audit branch: `audit/agency-ui-pre-qa-20261027`
Date: 2026-10-28 (UTC); environment: Ubuntu/Linux x86_64, kernel 7.0.0-38-generic; Node v24.22.0; npm 11.8.0; git 2.53.0; gh 2.46.0.
Limitations: synthetic/local bounded review; real-provider checks require manual QA. Earlier checkpoint sections are historical; final continuation conclusions supersede their incomplete-state statements.
Last completed step: integrated account isolation, critical boundary review, sustained PTYs, long transcript and browser reconnection; final backlog and handoff.


## FUNC-001 — rapid close leaks server picker; next picker remains in loading state

Independent browser reproduction: with a real production server and headless Chrome, delay only incoming `picker.listing` delivery 500 ms. Open the New workspace folder picker and close it before its listing arrives, wait for the delayed reply to be discarded, repeat eight times. The ninth open receives a real `picker-failed` server response; the UI remains on "Reading the disk...". Browser instrumentation counted eight actual listing responses and one `picker-failed` response. This demonstrates a timing race with artificial delay; frequency in normal operation has not been measured. The server owns a maximum of eight pickers per socket (`directory-picker.ts:43,145-151`); `FolderPicker.tsx:62-85` removes its listener and closes only an already-known ID, so a listing arriving after unmount cannot be closed. Error rendering at `FolderPicker.tsx:145-147,187` is nested under the non-null-listing branch, so an initial error is hidden. Reconnecting creates a fresh socket and is a possible workaround, not yet verified. Suggested fix: cancel or correlate open requests so late-created IDs are closed, including rapid reopen/multiple requests; display errors independently of a successful listing. Regression: delayed-response browser test repeating eight cycles, ninth open succeeds or shows a visible error, and no leaked server picker IDs.

Reproduction: extend the temporary screenshot browser fixture described in 05. Before `page.goto(url)` insert the WebSocket `onmessage` delay instrumentation below; before `await browser.close()` insert the browser actions. This simulates network/dispatch delay without modifying implementation. The full runnable copy is `/tmp/agency-audit-picker-race.mjs` while it exists.

```javascript
await page.addInitScript(() => {
 const d=Object.getOwnPropertyDescriptor(WebSocket.prototype,'onmessage');
 Object.defineProperty(WebSocket.prototype,'onmessage',{...d,set(handler){
  d.set.call(this, function(event){let msg;try{msg=JSON.parse(event.data)}catch{};if(window.__delayPicker && msg?.type==='error' && msg.code==='picker-failed')window.__pickerErrors=(window.__pickerErrors||0)+1;if(window.__delayPicker && msg?.type==='picker.listing'){window.__pickerListings=(window.__pickerListings||0)+1;setTimeout(()=>handler.call(this,event),500)}else handler.call(this,event)});
 }});
});


await page.evaluate(()=>{window.__delayPicker=true});
await page.getByRole('button',{name:'New workspace',exact:true}).click();
await page.getByLabel('Workspace name').fill('Picker race fixture');
for(let i=0;i<8;i++){
 await page.getByRole('button',{name:'Select existing folder'}).click();
 await page.locator('.picker-modal').waitFor({state:'visible'});
 await page.locator('.picker-modal button[title="Close"]').click();
 await page.waitForTimeout(600);
}
await page.getByRole('button',{name:'Select existing folder'}).click();
await page.waitForTimeout(700);
const text=await page.locator('.picker-modal').innerText();
const counts=await page.evaluate(()=>({errors:window.__pickerErrors||0,listings:window.__pickerListings||0}));assert.equal(counts.listings,8);assert.ok(counts.errors>=1);assert.ok(/Reading the disk/.test(text));console.log('AUDIT_PICKER_RACE',JSON.stringify({...counts,uiStuckLoading:true}));


```

## Continuation 02 — authenticated socket and picker recovery

Disposable production server: actual WS `unexpected-response` HTTP status is 403 for each of bad token, foreign Origin, and foreign Host (three independent attempts; transport errors cannot satisfy these assertions). An Agency workspace.create containing arbitrary cwd is rejected as `Invalid Agency request`. Exhaust eight pickers, observe ninth `picker-failed`, close that socket, connect fresh socket without Origin using valid token, and receive a new picker listing. Reattach existing shell, execute `printf '%s%s\\n' 'EXECUTED_' 'MARKER'`; assert joined EXECUTED_MARKER in actual terminal.output, then `exit 42` and assert the exact runtime row publishes exitCode 42. This extends earlier E2E coverage using non-echo output and real exit code. Fixture `/tmp/agency-audit-boundaries.mjs`, same isolated setup as 05 screenshot harness. FUNC-001 reconnect workaround is now verified at socket level; browser remains responsible for refreshing state.

## Continuation 04 — browser reconnect and real process preservation

Real Chrome with disposable server: select Shell Only, click workspace-header Done, restore the Shell Only row from Done view, select it again. Set browser context offline, explicitly close instrumented browser WebSockets, wait until connected indicator disappears, click Done while offline and assert visible role=alert. Count sent Agency mutations before reconnect; restore connectivity, await connected indicator and500ms settle, assert mutation count unchanged. A separate authenticated socket attaches the **original** shell terminal ID and executes split printf marker `PRESERVED_` + `SHELL`; assert joined output from terminal.output. All assertions passed. Thus Done/Restore + disconnect preserved this actual shell and no attempted offline mutation replayed. Does not guarantee the outcome of a mutation already sent before a connection failed; UI correctly asks user to verify state. Fixture `/tmp/agency-audit-browser-reconnect.mjs`, derived from screenshot setup, page.addInitScript wraps WebSocket only to retain socket instances/count outgoing Agency non-list messages; no app modifications.

Concurrent start/stop, duplicate native controllers, launch failures, stale/symlink cwd, restart reconciliation, corruption/future-schema handling: reviewed assertions in prior independently passing runtime/domain/profile suites (06). Preserve distinction between fake registries and actual provider behavior. Rapid switching and dialog Tab/Escape checks have browser evidence (04/05). First-load picker error visibility remains FUNC-001. No new reliability finding is assigned solely from coverage limits.
