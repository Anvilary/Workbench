#!/usr/bin/env python3
"""
Unit and functional tests for the Restricted Chromium CDP Tab Controller.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from tab_controller import SAFE_URL_PATTERN, TAB_ID_PATTERN


class TestRestrictedTabController(unittest.TestCase):
    def test_safe_url_pattern(self):
        # Permitted schemes
        self.assertTrue(SAFE_URL_PATTERN.match("https://chatgpt.com"))
        self.assertTrue(SAFE_URL_PATTERN.match("https://chatgpt.com/c/67890"))
        self.assertTrue(SAFE_URL_PATTERN.match("http://127.0.0.1:8080/"))
        self.assertTrue(SAFE_URL_PATTERN.match("about:blank"))
        self.assertTrue(SAFE_URL_PATTERN.match("HTTPS://EXAMPLE.COM/test"))

        # Blocked dangerous schemes
        self.assertFalse(SAFE_URL_PATTERN.match("file:///etc/passwd"))
        self.assertFalse(SAFE_URL_PATTERN.match("javascript:alert(1)"))
        self.assertFalse(SAFE_URL_PATTERN.match("data:text/html,<h1>Pwned</h1>"))
        self.assertFalse(SAFE_URL_PATTERN.match("chrome://policy"))
        self.assertFalse(SAFE_URL_PATTERN.match("chrome://flags"))
        self.assertFalse(SAFE_URL_PATTERN.match("gopher://evil.com"))
        self.assertFalse(SAFE_URL_PATTERN.match("ftp://ftp.is.co.za/rfc/rfc1807.txt"))

    def test_tab_id_pattern(self):
        # Valid IDs
        self.assertTrue(TAB_ID_PATTERN.match("C47A2F986A2EFD254707328A0003FBED"))
        self.assertTrue(TAB_ID_PATTERN.match("tab-123_456"))
        self.assertTrue(TAB_ID_PATTERN.match("abc-DEF-098"))

        # Path traversal and injection attacks
        self.assertFalse(TAB_ID_PATTERN.match("../../evil"))
        self.assertFalse(TAB_ID_PATTERN.match("id/with/slashes"))
        self.assertFalse(TAB_ID_PATTERN.match("id with spaces"))
        self.assertFalse(TAB_ID_PATTERN.match("id;rm -rf /"))
        self.assertFalse(TAB_ID_PATTERN.match("id\nnewline"))


if __name__ == "__main__":
    unittest.main()
