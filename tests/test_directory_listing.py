import os
import tempfile
import unittest
from pathlib import Path

import app


class DirectoryListingTests(unittest.TestCase):
    def test_modification_times_for_files_and_folders(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            file = root / "file.txt"
            folder = root / "folder"
            file.write_text("content")
            folder.mkdir()
            os.utime(file, (1700000000, 1700000000))
            os.utime(folder, (1600000000, 1600000000))
            result = app.list_directory(str(root))
        entries = {entry["name"]: entry for entry in result["entries"]}
        self.assertEqual(entries["file.txt"]["modified"], 1700000000)
        self.assertEqual(entries["folder"]["modified"], 1600000000)
        self.assertTrue(entries["folder"]["directory"])


if __name__ == "__main__":
    unittest.main()
