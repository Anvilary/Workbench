#!/usr/bin/env python3
"""
CLI and client library for the Restricted Chromium DevTools Protocol (CDP) Controller.
"""

import argparse
import json
import os
import sys
import urllib.parse
import urllib.request

DEFAULT_CONTROLLER_URL = os.environ.get("NEKO_CONTROLLER_URL", "http://127.0.0.1:9223")
AUTH_TOKEN = os.environ.get("NEKO_CONTROLLER_TOKEN", "").strip()


class TabClient:
    def __init__(self, base_url: str = DEFAULT_CONTROLLER_URL, token: str = AUTH_TOKEN):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def _request(self, method: str, path: str, payload: dict = None):
        url = f"{self.base_url}{path}"
        headers = {}
        data = None
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read().decode("utf-8")
            if content:
                return json.loads(content)
            return None

    def health(self) -> dict:
        return self._request("GET", "/health")

    def list_tabs(self) -> list:
        res = self._request("GET", "/tabs")
        return res.get("tabs", [])

    def create_tab(self, url: str = "https://chatgpt.com") -> dict:
        return self._request("POST", "/tabs", {"url": url})

    def activate_tab(self, tab_id: str) -> dict:
        return self._request("POST", f"/tabs/{tab_id}/activate")

    def navigate_tab(self, tab_id: str, url: str) -> dict:
        return self._request("POST", f"/tabs/{tab_id}/navigate", {"url": url})

    def close_tab(self, tab_id: str) -> dict:
        return self._request("DELETE", f"/tabs/{tab_id}")


def main():
    parser = argparse.ArgumentParser(description="Restricted CDP Tab Controller CLI")
    parser.add_argument("--url", default=DEFAULT_CONTROLLER_URL, help="Base URL of controller")
    parser.add_argument("--token", default=AUTH_TOKEN, help="Auth token if enabled")

    subparsers = parser.add_subparsers(dest="command", required=True)

    # Health
    subparsers.add_parser("health", help="Check controller health and status")

    # List
    subparsers.add_parser("list", help="List all page tabs")

    # New
    new_parser = subparsers.add_parser("new", help="Create a new tab")
    new_parser.add_argument("url", nargs="?", default="https://chatgpt.com", help="Target URL")

    # Activate
    act_parser = subparsers.add_parser("activate", help="Activate/focus a tab")
    act_parser.add_argument("tab_id", help="Tab ID")

    # Navigate
    nav_parser = subparsers.add_parser("navigate", help="Navigate a tab")
    nav_parser.add_argument("tab_id", help="Tab ID")
    nav_parser.add_argument("url", help="Target URL")

    # Close
    close_parser = subparsers.add_parser("close", help="Close a tab")
    close_parser.add_argument("tab_id", help="Tab ID")

    args = parser.parse_args()
    client = TabClient(args.url, args.token)

    try:
        if args.command == "health":
            print(json.dumps(client.health(), indent=2))
        elif args.command == "list":
            tabs = client.list_tabs()
            print(json.dumps(tabs, indent=2))
        elif args.command == "new":
            print(json.dumps(client.create_tab(args.url), indent=2))
        elif args.command == "activate":
            print(json.dumps(client.activate_tab(args.tab_id), indent=2))
        elif args.command == "navigate":
            print(json.dumps(client.navigate_tab(args.tab_id, args.url), indent=2))
        elif args.command == "close":
            print(json.dumps(client.close_tab(args.tab_id), indent=2))
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
