# MAW Restricted Chromium CDP Tab Controller Specification

## 1. Overview

The Restricted Chromium DevTools Protocol (CDP) Tab Controller is a hardened gateway running inside the `maw-neko` container. It enables MAW to manage browser tabs (enumeration, creation, selection, navigation, closure) without exposing raw Chromium DevTools capabilities.

- **Internal CDP Endpoint**: `http://127.0.0.1:9222` (Container-internal loopback only)
- **Controller Endpoint**: `http://127.0.0.1:9223` (Mapped to host loopback `127.0.0.1:9223`)
- **Protocol**: HTTP/1.1 REST + JSON
- **Authentication**: **MANDATORY** Bearer token configured via `CONTROLLER_AUTH_TOKEN` (minimum 32 characters). Startup fails if missing or weak. Evaluated via `hmac.compare_digest`.

---

## 2. Security Boundaries & Guardrails

| Capability | Policy | Enforcement Mechanism |
| :--- | :--- | :--- |
| **Authentication** | **MANDATORY** | Requires `Authorization: Bearer <token>`. Timing-safe comparison. Returns `401 Unauthorized` if invalid. |
| **Tab Enumeration** | Allowed (Page targets only) | Filters for `type == "page"`. Strips `webSocketDebuggerUrl` and `devtoolsFrontendUrl`. |
| **Tab Creation** | Allowed (Validated origins) | Evaluates destination against approved ChatGPT and SSO allowlist. Rejects loopback, private IPs, metadata, and non-HTTPS schemes. |
| **Tab Activation** | Allowed | Calls internal CDP `/json/activate/{id}`. Brings tab to X11 foreground. |
| **Tab Navigation** | Allowed (Isolated + Validated) | Evaluates destination against allowlist. Connects via robust RFC 6455 WebSocket client using correlated request IDs to execute `Page.navigate`. Verifies state before returning success. |
| **Tab Closure** | Allowed | Calls internal CDP `/json/close/{id}`. |
| **DOM Inspection** | **STRICTLY PROHIBITED** | No endpoints exposed for `DOM.getDocument`, `DOM.getOuterHTML`, or CSS selectors. |
| **Script Evaluation** | **STRICTLY PROHIBITED** | No endpoints exposed for `Runtime.evaluate` or script injection. |
| **Cookie Extraction** | **STRICTLY PROHIBITED** | No endpoints exposed for `Network.getCookies` or `Storage.getCookies`. |
| **Automated Keystrokes**| **STRICTLY PROHIBITED** | No endpoints exposed for `Input.dispatchKeyEvent` or simulated typing. |

---

## 3. Navigation Origin Allowlist

The controller validates all tab creation and navigation targets against an approved list:

- **Approved Domains**:
  - `chatgpt.com`, `*.chatgpt.com`
  - `openai.com`, `*.openai.com`
  - `oaistatic.com`, `*.oaistatic.com`
  - `oaiusercontent.com`, `*.oaiusercontent.com`
  - `accounts.google.com` (Google SSO)
  - `login.microsoftonline.com`, `login.live.com` (Microsoft SSO)
  - `appleid.apple.com` (Apple SSO)
  - `about:blank`
  - *(Optional additional origins configured via `PERMITTED_ORIGINS` environment variable)*
- **Blocked Destinations**:
  - Loopback: `127.0.0.1`, `localhost`, `::1`
  - Private RFC 1918 subnets: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
  - Link-local: `169.254.0.0/16`
  - Cloud metadata services: `169.254.169.254`, `metadata.google.internal`
  - Non-HTTP schemes: `file:`, `javascript:`, `chrome:`, `data:`, `gopher:`, `ftp:`

Attempts to navigate to non-allowlisted destinations are rejected with `HTTP 403 Forbidden`.

---

## 4. API Reference

All requests require `Authorization: Bearer <CONTROLLER_AUTH_TOKEN>`.

### 4.1 Health & Status Check

- **Method**: `GET /health` or `GET /status`
- **Response**: `200 OK`
```json
{
  "status": "healthy",
  "browser": "Chrome/156.0.8078.47",
  "tabs_count": 2,
  "auth_enforced": true
}
```
- **Error Response**: `401 Unauthorized` if token is missing or invalid.

---

### 4.2 List Tabs

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

### 4.3 Create New Tab

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
- **Error Responses**:
  - `401 Unauthorized`: Missing or invalid Bearer token.
  - `403 Forbidden`: Destination origin is not in the approved allowlist or is an internal/loopback destination.
  - `400 Bad Request`: Invalid JSON or malformed URL.

---

### 4.4 Activate / Select Tab

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
- **Error Responses**:
  - `401 Unauthorized`: Missing/invalid token.
  - `404 Not Found`: Tab does not exist.
  - `400 Bad Request`: `tab_id` fails alphanumeric validation.

---

### 4.5 Navigate Existing Tab

- **Method**: `POST /tabs/{tab_id}/navigate`
- **Headers**: `Content-Type: application/json`
- **Request Body**:
```json
{
  "url": "https://chatgpt.com/c/new-conversation-id"
}
```
- **Behavior**: Uses robust RFC 6455 WebSocket client to send `Page.navigate` to the tab's internal target endpoint. Matches response IDs, handles timeouts, and checks browser loader state before responding.
- **Response**: `200 OK`
```json
{
  "id": "7553989CCD74CDF34145B7DE832C0EA8",
  "navigated": true,
  "url": "https://chatgpt.com/c/new-conversation-id"
}
```
- **Error Responses**:
  - `401 Unauthorized`: Missing/invalid token.
  - `403 Forbidden`: Destination origin not permitted.
  - `502 Bad Gateway`: Browser navigation failed (e.g. loader error).

---

### 4.6 Close Tab

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

## 5. Client Libraries

Two client libraries are provided in `infra/neko/controller/`:

1. **Python Client (`tab_client.py`)**:
   ```python
   from tab_client import TabClient

   client = TabClient(base_url="http://127.0.0.1:9223", token="<CONTROLLER_AUTH_TOKEN>")
   tabs = client.list_tabs()
   new_tab = client.create_tab("https://chatgpt.com")
   client.activate_tab(new_tab["id"])
   client.close_tab(new_tab["id"])
   ```

2. **TypeScript / Node.js Client (`tab_client.mjs`)**:
   ```javascript
   import { TabClient } from "./infra/neko/controller/tab_client.mjs";

   const client = new TabClient({
     baseUrl: "http://127.0.0.1:9223",
     token: process.env.CONTROLLER_AUTH_TOKEN
   });
   const tabs = await client.listTabs();
   const newTab = await client.createTab("https://chatgpt.com");
   await client.activateTab(newTab.id);
   await client.closeTab(newTab.id);
   ```
