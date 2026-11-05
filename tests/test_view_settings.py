import json
import tempfile
import unittest
from pathlib import Path

import app


class ViewSettingsTests(unittest.TestCase):
    def test_save_and_load_all_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dpane" / "settings.json"
            settings = {"scale": 130, "showHiddenEntries": False, "showShortcutHints": False,
                        "startupPaneCount": 4}
            app.save_view_settings(path, settings)
            self.assertEqual(app.load_view_settings(path), settings)
            self.assertEqual(json.loads(path.read_text()), settings)

    def test_missing_corrupt_and_invalid_values_use_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            self.assertEqual(app.load_view_settings(path), app.DEFAULT_VIEW_SETTINGS)
            path.write_text("{invalid", encoding="utf-8")
            self.assertEqual(app.load_view_settings(path), app.DEFAULT_VIEW_SETTINGS)
            path.write_text(json.dumps({"scale": True, "showHiddenEntries": False,
                                        "showShortcutHints": "false", "startupPaneCount": 5}), encoding="utf-8")
            self.assertEqual(app.load_view_settings(path),
                             {"scale": 100, "showHiddenEntries": False, "showShortcutHints": True,
                              "startupPaneCount": 3})


if __name__ == "__main__":
    unittest.main()
