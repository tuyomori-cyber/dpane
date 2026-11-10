import json
import tempfile
import unittest
from pathlib import Path

import keybindings


class KeybindingsTests(unittest.TestCase):
    def test_overrides_are_normalized_and_defaults_retained(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'keybindings.json'
            path.write_text(json.dumps({'splitRight': 'shift+ctrl+r', 'pane8': 'ctrl+8'}))
            bindings, error = keybindings.load(path)
            self.assertIsNone(error)
            self.assertEqual(bindings['splitRight'], 'Ctrl+Shift+R')
            self.assertEqual(bindings['splitDown'], keybindings.DEFAULTS['splitDown'])
            self.assertEqual(bindings['pane8'], 'Ctrl+8')
            self.assertEqual(bindings['pane7'], 'Alt+7')

    def test_invalid_and_conflicting_settings_fall_back(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'keybindings.json'
            for value in ('{', json.dumps({'splitRight': 'Ctrl+T'}), json.dumps({'splitRight': 'Ctrl+C'}),
                          json.dumps({'splitRight': 'A'}), json.dumps({'unknown': 'Ctrl+Q'})):
                with self.subTest(value=value):
                    path.write_text(value)
                    bindings, error = keybindings.load(path)
                    self.assertEqual(bindings, keybindings.DEFAULTS)
                    self.assertTrue(error)

    def test_reset_writes_empty_override(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config' / 'keybindings.json'
            keybindings.reset(path)
            self.assertEqual(json.loads(path.read_text()), {})
            self.assertEqual(keybindings.load(path), (keybindings.DEFAULTS, None))


if __name__ == '__main__':
    unittest.main()
