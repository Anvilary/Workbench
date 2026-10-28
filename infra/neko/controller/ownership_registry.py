"""Durable ownership receipts for managed browser targets. No page content is read.

The browser instance identity comes from its internal CDP browser endpoint, never
from a page URL/title or a client supplied target hint. A controller restart keeps
receipts; a browser restart invalidates them. An interrupted create remains
uncertain and cannot silently create a duplicate on retry.
"""

import hashlib
import json
import os
import re
import tempfile
import threading
import time
import urllib.parse


class OwnershipError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
TARGET = re.compile(r"^[A-Za-z0-9_-]+$")


def validate_owner(owner):
    if not isinstance(owner, dict) or any(
        not isinstance(owner.get(key), str) or not UUID.fullmatch(owner[key])
        for key in ("tabId", "workspaceId")
    ):
        raise OwnershipError(400, "Valid tabId and workspaceId ownership metadata are required")
    return {"tabId": owner["tabId"], "workspaceId": owner["workspaceId"]}


class OwnershipRegistry:
    def __init__(self, file_path, cdp):
        self.file_path = file_path
        self.cdp = cdp
        self.lock = threading.RLock()
        self.state = None

    def _save(self):
        directory = os.path.dirname(os.path.abspath(self.file_path))
        os.makedirs(directory, mode=0o700, exist_ok=True)
        handle, temporary = tempfile.mkstemp(prefix=".ownership-", dir=directory)
        try:
            with os.fdopen(handle, "w") as stream:
                json.dump(self.state, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.file_path)
            directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _load(self):
        if self.state is not None:
            return
        try:
            with open(self.file_path) as stream:
                state = json.load(stream)
        except FileNotFoundError:
            state = {"version": 1, "browserInstanceId": None, "operations": {}}
        except (ValueError, OSError) as error:
            raise OwnershipError(503, "Ownership registry cannot be read safely") from error
        if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("operations"), dict):
            raise OwnershipError(503, "Ownership registry is invalid")
        for key, record in state["operations"].items():
            if not isinstance(record, dict):
                raise OwnershipError(503, "Ownership registry has an invalid record")
            try:
                owner = validate_owner(record.get("owner"))
            except OwnershipError as error:
                raise OwnershipError(503, "Ownership registry has invalid ownership") from error
            if key != self._key(owner) or record.get("state") not in ("pending", "open", "closing", "closed", "uncertain"):
                raise OwnershipError(503, "Ownership registry has an invalid operation")
            target = record.get("targetRef")
            if target is not None and (not isinstance(target, str) or not TARGET.fullmatch(target)):
                raise OwnershipError(503, "Ownership registry has an invalid target")
        self.state = state

    def _sync(self):
        self._load()
        version = self.cdp("/json/version")
        endpoint = version.get("webSocketDebuggerUrl") if isinstance(version, dict) else None
        if not isinstance(endpoint, str) or "/devtools/browser/" not in endpoint:
            raise OwnershipError(503, "Browser instance identity is unavailable")
        instance = hashlib.sha256(endpoint.encode()).hexdigest()
        if instance != self.state["browserInstanceId"]:
            self.state = {"version": 1, "browserInstanceId": instance, "operations": {}}
            self._save()
        targets = self.cdp("/json/list")
        if not isinstance(targets, list):
            raise OwnershipError(503, "Browser target inventory is unavailable")
        return {target["id"]: target for target in targets if isinstance(target, dict) and target.get("type") == "page" and isinstance(target.get("id"), str)}

    @staticmethod
    def _key(owner):
        return owner["workspaceId"] + ":" + owner["tabId"]

    def _record(self, target, owner):
        record = self.state["operations"].get(self._key(owner))
        return record if record and record.get("targetRef") == target and record["state"] in ("open", "closing", "closed") else None

    def open(self, url, owner):
        owner = validate_owner(owner)
        with self.lock:
            targets = self._sync()
            key = self._key(owner)
            record = self.state["operations"].get(key)
            if record:
                if record["state"] in ("pending", "uncertain"):
                    raise OwnershipError(409, "Previous target creation is uncertain; automatic retry is blocked")
                if record["state"] == "closing":
                    raise OwnershipError(409, "Target closure is still pending")
                if record["state"] == "closed":
                    raise OwnershipError(409, "This logical tab has already been closed")
                if record.get("targetRef") in targets:
                    # A prior response may have been lost. Do not navigate or reopen.
                    self._save()
                    return {"id": record["targetRef"], "created": False, "reused": True}
            record = {"owner": owner, "state": "pending", "targetRef": None}
            self.state["operations"][key] = record
            self._save()  # Persist intent before the browser side effect.
            try:
                result = self.cdp("/json/new?" + urllib.parse.quote(url, safe=""), method="PUT")
                target = result.get("id") if isinstance(result, dict) else None
                if not isinstance(target, str) or not TARGET.fullmatch(target):
                    raise OwnershipError(502, "Browser returned an invalid target receipt")
                record.update(state="open", targetRef=target)
                self._save()  # No success response before the receipt is durable.
                return {"id": target, "created": True, "reused": False}
            except Exception as error:
                # If CDP created a page but its response was lost we cannot prove
                # which page it was. Never guess by URL/title or create another.
                if record.get("targetRef") is None:
                    record["state"] = "uncertain"
                try:
                    self._save()
                except OSError:
                    pass  # The durable pending intent still prevents unsafe retry.
                raise OwnershipError(503, "Target creation could not be confirmed safely") from error

    def verify(self, target, owner):
        owner = validate_owner(owner)
        with self.lock:
            targets = self._sync()
            record = self._record(target, owner)
            verified = bool(record and record["state"] != "closed" and target in targets)
            return {"id": target, "verified": verified, "browserInstanceId": self.state["browserInstanceId"], "url": targets[target].get("url") if verified else None}

    def reject_unscoped(self, target):
        """Legacy callers cannot bypass ownership on a managed target."""
        with self.lock:
            self._sync()
            if any(record.get("targetRef") == target for record in self.state["operations"].values()):
                raise OwnershipError(409, "Managed targets require the managed ownership API")

    def find(self, owner):
        owner = validate_owner(owner)
        with self.lock:
            targets = self._sync()
            record = self.state["operations"].get(self._key(owner))
            if record and record["state"] in ("pending", "uncertain"):
                raise OwnershipError(409, "Target creation remains uncertain")
            target = record.get("targetRef") if record and record["state"] in ("open", "closing") else None
            if target not in targets:
                target = None
            return {"id": target, "found": target is not None}

    def execute(self, target, owner, action):
        owner = validate_owner(owner)
        with self.lock:
            targets = self._sync()
            record = self._record(target, owner)
            if not record or record["state"] != "open":
                raise OwnershipError(409, "Target ownership does not match an open logical tab")
            if target not in targets:
                raise OwnershipError(404, "Owned browser target is no longer alive")
            return action()

    def close(self, target, owner):
        owner = validate_owner(owner)
        with self.lock:
            targets = self._sync()
            record = self._record(target, owner)
            if not record:
                raise OwnershipError(409, "Target ownership does not match")
            if target in targets:
                record["state"] = "closing"
                self._save()
                try:
                    self.cdp("/json/close/" + target, method="PUT")
                except Exception:
                    # A close response can be lost even when destruction succeeds.
                    if target in self._sync():
                        raise
                deadline = time.monotonic() + 2
                while target in self._sync():
                    if time.monotonic() >= deadline:
                        raise OwnershipError(503, "Browser target destruction is still pending")
                    time.sleep(0.05)
            record["state"] = "closed"
            self._save()
            return {"id": target, "closed": True}
