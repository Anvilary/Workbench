import json
import os
import tempfile
import unittest

from ownership_registry import OwnershipError, OwnershipRegistry


OWNER_A = {"workspaceId": "00000000-0000-4000-8000-000000000001", "tabId": "00000000-0000-4000-8000-000000000010"}
OWNER_B = {"workspaceId": "00000000-0000-4000-8000-000000000002", "tabId": "00000000-0000-4000-8000-000000000020"}


class FakeBrowser:
    def __init__(self):
        self.instance = "browser-a"
        self.targets = {}
        self.opens = 0
        self.closes = []
        self.lose_create_response = False
        self.fail_close = False
        self.lose_close_response = False

    def __call__(self, path, method="GET"):
        if path == "/json/version":
            return {"webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/" + self.instance}
        if path == "/json/list":
            return list(self.targets.values())
        if path.startswith("/json/new?"):
            self.opens += 1
            target = "target-" + str(self.opens)
            self.targets[target] = {"id": target, "type": "page", "url": "https://chatgpt.com/"}
            if self.lose_create_response:
                raise TimeoutError("Simulated lost CDP response")
            return self.targets[target]
        if path.startswith("/json/close/"):
            target = path.rsplit("/", 1)[1]
            self.closes.append(target)
            if self.fail_close:
                raise TimeoutError("Simulated unavailable browser")
            self.targets.pop(target, None)
            if self.lose_close_response:
                raise TimeoutError("Simulated lost close response")
            return "Target is closing"
        raise AssertionError(path)


class TestOwnershipRegistry(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="maw-ownership-test-")
        self.addCleanup(self.directory.cleanup)
        self.file = os.path.join(self.directory.name, "ownership.json")
        self.browser = FakeBrowser()
        self.registry = OwnershipRegistry(self.file, self.browser)

    def test_controller_restart_reuses_durable_receipt_without_navigation(self):
        first = self.registry.open("https://chatgpt.com/", OWNER_A)
        restarted = OwnershipRegistry(self.file, self.browser)
        self.assertTrue(restarted.verify(first["id"], OWNER_A)["verified"])
        second = restarted.open("https://chatgpt.com/c/a-different-url", OWNER_A)
        self.assertEqual(first["id"], second["id"])
        self.assertTrue(second["reused"])
        self.assertEqual(self.browser.opens, 1)
        self.assertEqual(os.stat(self.file).st_mode & 0o777, 0o600)
        self.assertEqual(restarted.find(OWNER_A), {"id": first["id"], "found": True})
        self.assertEqual(restarted.find(OWNER_B), {"id": None, "found": False})

    def test_identical_urls_are_separate_and_foreign_ownership_is_rejected(self):
        first = self.registry.open("https://chatgpt.com/", OWNER_A)
        second = self.registry.open("https://chatgpt.com/", OWNER_B)
        self.assertNotEqual(first["id"], second["id"])
        self.assertFalse(self.registry.verify(first["id"], OWNER_B)["verified"])
        with self.assertRaises(OwnershipError):
            self.registry.close(first["id"], OWNER_B)
        with self.assertRaises(OwnershipError):
            self.registry.execute(first["id"], OWNER_B, lambda: self.fail("Foreign action executed"))
        with self.assertRaises(OwnershipError):
            self.registry.reject_unscoped(first["id"])
        self.assertEqual(self.browser.closes, [])

    def test_uncertain_receipt_lookup_does_not_claim_an_arbitrary_page(self):
        self.browser.lose_create_response = True
        with self.assertRaises(OwnershipError):
            self.registry.open("https://chatgpt.com/", OWNER_A)
        with self.assertRaises(OwnershipError) as caught:
            self.registry.find(OWNER_A)
        self.assertEqual(caught.exception.status, 409)

    def test_browser_restart_invalidates_receipts_even_if_target_id_is_reused(self):
        first = self.registry.open("https://chatgpt.com/", OWNER_A)
        self.browser.instance = "browser-b"
        # An unrelated target can reuse the old runtime handle.
        self.assertFalse(self.registry.verify(first["id"], OWNER_A)["verified"])
        with self.assertRaises(OwnershipError):
            self.registry.close(first["id"], OWNER_A)
        replacement = self.registry.open("https://chatgpt.com/", OWNER_A)
        self.assertNotEqual(replacement["id"], first["id"])
        self.assertEqual(self.browser.closes, [])

    def test_lost_create_response_is_uncertain_and_never_silently_duplicates(self):
        self.browser.lose_create_response = True
        with self.assertRaises(OwnershipError):
            self.registry.open("https://chatgpt.com/", OWNER_A)
        restarted = OwnershipRegistry(self.file, self.browser)
        self.browser.lose_create_response = False
        with self.assertRaises(OwnershipError) as caught:
            restarted.open("https://chatgpt.com/", OWNER_A)
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.browser.opens, 1)
        self.assertEqual(self.browser.closes, [])

    def test_crash_after_intent_keeps_pending_create_blocked(self):
        self.registry._sync()
        self.registry.state["operations"][self.registry._key(OWNER_A)] = {"owner": OWNER_A, "state": "pending", "targetRef": None}
        self.registry._save()
        with self.assertRaises(OwnershipError):
            OwnershipRegistry(self.file, self.browser).open("https://chatgpt.com/", OWNER_A)
        self.assertEqual(self.browser.opens, 0)

    def test_failed_close_survives_restart_then_only_closes_owned_target(self):
        first = self.registry.open("https://chatgpt.com/", OWNER_A)
        sibling = self.registry.open("https://chatgpt.com/", OWNER_B)
        self.browser.fail_close = True
        with self.assertRaises(TimeoutError):
            self.registry.close(first["id"], OWNER_A)
        self.browser.fail_close = False
        restarted = OwnershipRegistry(self.file, self.browser)
        self.assertTrue(restarted.verify(first["id"], OWNER_A)["verified"])
        self.assertTrue(restarted.close(first["id"], OWNER_A)["closed"])
        self.assertTrue(restarted.close(first["id"], OWNER_A)["closed"])
        self.assertIn(sibling["id"], self.browser.targets)

    def test_lost_close_response_is_confirmed_by_target_absence(self):
        target = self.registry.open("https://chatgpt.com/", OWNER_A)
        self.browser.lose_close_response = True
        self.assertTrue(self.registry.close(target["id"], OWNER_A)["closed"])
        self.assertFalse(self.registry.verify(target["id"], OWNER_A)["verified"])

    def test_corrupt_registry_does_not_claim_or_mutate_existing_targets(self):
        self.registry.open("https://chatgpt.com/", OWNER_A)
        with open(self.file, "w") as stream:
            stream.write("{corrupt")
        with self.assertRaises(OwnershipError):
            OwnershipRegistry(self.file, self.browser).open("https://chatgpt.com/", OWNER_A)
        self.assertEqual(self.browser.opens, 1)

    def test_receipts_do_not_contain_browser_endpoint_or_page_content(self):
        self.registry.open("https://chatgpt.com/", OWNER_A)
        with open(self.file) as stream:
            state = json.load(stream)
        self.assertNotIn("ws://", json.dumps(state))
        self.assertNotIn("https://", json.dumps(state))


if __name__ == "__main__":
    unittest.main()
