import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import path_completion as completion


class PathCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "Documents").mkdir()
        (self.root / "Downloads").mkdir()
        (self.root / ".dot").mkdir()
        (self.root / "Document.txt").write_text("not a directory")

    def test_common_prefix_and_directory_filter(self):
        result = completion.complete_path(f"{self.root}/Do")
        self.assertEqual(result["candidates"], ["Documents", "Downloads"])
        self.assertEqual(result["common"], "Do")
        self.assertEqual(result["count"], 2)

    def test_single_candidate_and_hidden(self):
        result = completion.complete_path(f"{self.root}/Doc")
        self.assertEqual(result["common"], "Documents")
        self.assertEqual(result["count"], 1)
        self.assertNotIn(".dot", completion.complete_path(f"{self.root}/")["candidates"])
        self.assertEqual(completion.complete_path(f"{self.root}/.")["candidates"], [".dot"])

    def test_home_and_directory_symlink(self):
        (self.root / "DocsLink").symlink_to(self.root / "Documents", target_is_directory=True)
        with patch.dict(os.environ, {"HOME": str(self.root)}):
            result = completion.complete_path("~/Docs")
        self.assertEqual(result["candidates"], ["DocsLink"])

    def test_all_matches_contribute_to_common_prefix_when_truncated(self):
        for index in range(105):
            (self.root / f"test-a{index:03}").mkdir()
        (self.root / "test-z").mkdir()
        result = completion.complete_path(f"{self.root}/test")
        self.assertEqual(result["count"], 106)
        self.assertEqual(len(result["candidates"]), 100)
        self.assertEqual(result["common"], "test-")

    def test_invalid_missing_and_case_sensitive(self):
        for value in (None, "relative", "~other/a", f"{self.root}/missing/a", "bad\0name"):
            self.assertEqual(completion.complete_path(value)["count"], 0)
        self.assertEqual(completion.complete_path(f"{self.root}/doc")["count"], 0)


if __name__ == "__main__":
    unittest.main()
