# MAW Restricted Chromium CDP Tab Controller Specification

## 1. Overview

The Restricted Chromium DevTools Protocol (CDP) Tab Controller is a security gateway running inside the `maw-neko` container. It enables MAW to manage browser tabs (enumeration, creation, selection, navigation, closure) without exposing raw Chromium DevTools capabilities.

- **Internal CDP Endpoint**: `http://127.0.0.1:9222` (Container-internal loopback only)
- **Controller Endpoint**: `http://127.0.0.1:9223` (Mapped to host loopback `127.0.0.1:9223`)
- **Protocol**: HTTP/1.1 REST + JSON
- **Authentication**: Optional Bearer token configured via `CONTROLLER_AUTH_TOKEN`. If unset, access is restricted to loopback connections.

---

## 2. Security Boundaries & Guardrails

| Capability | Policy | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Tab Enumeration** | Allowed (Page targets only) | Filters for `type == "page"`. Strips `webSocketDebuggerUrl` and `devtoolsFrontendUrl`. |
| **Tab Creation** | Allowed (Validated URLs) | Enforces regex `^(https?://\|about:blank)`. Rejects `file://`, `javascript:`, `chrome://`, `data:`. |
| **Tab Activation** | Allowed | Calls internal CDP `/json/activate/{id}`. Brings tab to X11 foreground. |
| **Tab Navigation** | Allowed (Isolated) | Connects via WebSocket to target `Page.navigate`. Strictly limits command to `Page.navigate`. |
| **Tab Closure** | Allowed | Calls internal CDP `/json/close/{id}`. |
| **DOM Inspection** | **STRICTLY PROHIBITED** | No endpoints exposed for `DOM.getDocument`, `DOM.getOuterHTML`, or CSS selectors. |
| **Script Evaluation** | **STRICTLY PROHIBITED** | No endpoints exposed for `Runtime.evaluate` or script injection. |
| **Cookie Extraction** | **STRICTLY PROHIBITED** | No endpoints exposed for `Network.getCookies` or `Storage.getCookies`. |
| **Automated Keystrokes**| **STRICTLY PROHIBITED** | No endpoints exposed for `Input.dispatchKeyEvent` or simulated typing. |

---

## 3. API Reference

### 3.1 Health & Status Check

- **Method**: `GET /health` or `GET /status`
- **Response**: `200 OK`
```json
{
  "status": "healthy",
  "browser": "Chrome/156.0.8078.47",
  "tabs_count": 3
}
```

---

### 3.2 List Tabs

- **Method**: `GET /tabs`
- **Description**: Returns all user-visible browser page tabs. Internal browser UI targets (omnibox, extensions, service workers) and internal debugging URLs are stripped.
- **Response**: `200 OK`
```json
{
  "tabs": [
    {
      "id": "884FF7B36E12DA19B0F9E8122C3504DB",
      "title": "ChatGPT - Python script help",
      "url": "https://chatgpt.com/c/67890-abcdef",
      "faviconUrl": "https://chatgpt.com/favicon.ico"
    },
    {
      "id": "F94630A7C4339FF382B24EC0B5BF8581",
      "title": "ChatGPT - Architecture review",
      "url": "https://chatgpt.com/c/12345-ghijkl",
      "faviconUrl": "https://chatgpt.com/favicon.ico"
    }
  ],
  "count": 2
}
```

---

### 3.3 Create New Tab

- **Method**: `POST /tabs`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "url": "https://chatgpt.com"
}
```
*(If `url` is omitted, defaults to `https://chatgpt.com`)*
- **Response**: `201 Created`
```json
{
  "id": "7553989CCD74CDF34145B7DE832C0EA8",
  "title": "",
  "url": "https://chatgpt.com",
  "created": true
}
```
- **Error Response**: `400 Bad Request` if URL scheme is not `http://`, `https://`, or `about:blank`.

---

### 3.4 Activate / Select Tab

- **Method**: `POST /tabs/{tab_id}/activate` (or `POST /tabs/{tab_id}/select`)
- **Description**: Brings the specified tab to the visible foreground in Chromium and on the Neko X11 display.
- **Response**: `200 OK`
```json
{
  "id": "7553989CCD74CDF34145B7DE832C0EA8",
  "activated": true,
  "result": "Target activated"
}
```
- **Error Response**: `404 Not Found` if tab does not exist; `400 Bad Request` if `tab_id` fails alphanumeric validation.

---

### 3.5 Navigate Existing Tab

- **Method**: `POST /tabs/{tab_id}/navigate`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "url": "https://chatgpt.com/c/new-conversation-id"
}
```
- **Response**: `200 OK`
```json
{
  "id": "7553989CCD74CDF34145B7DE832C0EA8",
  "navigated": true,
  "url": "https://chatgpt.com/c/new-conversation-id"
}
```
- **Error Response**: `400 Bad Request` if URL is invalid; `404 Not Found` if tab is missing.

---

### 3.6 Close Tab

- **Method**: `DELETE /tabs/{tab_id}` (or `POST /tabs/{tab_id}/close`)
- **Description**: Gracefully closes the specified tab.
- **Response**: `200 OK`
```json
{
  "id": "7553989CCD74CDF34145B7DE832C0EA8",
  "closed": true,
  "result": "Target is closing"
}
```

---

## 4. MAW Integration Libraries

Two ready-to-use client libraries are provided in `infra/neko/controller/`:

1. **Python Client (`tab_client.py`)**:
   ```python
   from tab_client import TabClient

   client = TabClient("http://127.0.0.1:9223")
   tabs = client.list_tabs()
   new_tab = client.create_tab("https://chatgpt.com")
   client.activate_tab(new_tab["id"])
   client.close_tab(new_tab["id"])
   ```

2. **TypeScript / Node.js Client (`tab_client.mjs`)**:
   ```javascript
   import { TabClient } from "./infra/neko/controller/tab_client.mjs";

   const client = new TabClient({ baseUrl: "http://127.0.0.1:9223" });
   const tabs = await client.listTabs();
   const newTab = await client.createTab("https://chatgpt.com");
   await client.activateTab(newTab.id);
   await client.closeTab(newTab.id);
   ```
