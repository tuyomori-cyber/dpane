import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class ImmediateThread:
    def __init__(self, target, daemon):
        self.target = target

    def start(self):
        self.target()


class WorkflowSafetyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.src = self.root / "src"
        self.dst = self.root / "dst"
        self.src.mkdir()
        self.dst.mkdir()
        self.first = self.src / "first"
        self.second = self.src / "second"
        self.first.write_text("first data")
        self.second.write_text("second data")
        self.window = Mock()
        self.window.file_operation_busy = False
        self.window.file_clipboard = ([(p, app.file_operations.identity(p)) for p in (self.first, self.second)], True)
        self.request = Mock()
        self.request.get_js_value.return_value.to_json.return_value = json.dumps(
            {"paneId": "1", "action": "paste", "path": str(self.dst)})

    def test_later_collision_cancel_does_not_start_any_transfer(self):
        (self.dst / "first").write_text("old first")
        (self.dst / "second").write_text("old second")
        dialog = Mock()
        dialog.run.side_effect = [app.Gtk.ResponseType.YES, app.Gtk.ResponseType.CANCEL]
        original_clipboard = self.window.file_clipboard
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.file_operations, "transfer") as transfer:
            app.DirGroupWindow.on_file_operation_request(self.window, None, self.request)
        transfer.assert_not_called()
        self.assertEqual(self.window.file_clipboard, original_clipboard)
        self.assertEqual((self.dst / "first").read_text(), "old first")
        self.assertEqual((self.dst / "second").read_text(), "old second")
        self.assertEqual(self.first.read_text(), "first data")
        self.assertEqual(self.second.read_text(), "second data")

    def test_partial_cut_failure_retains_only_failed_source(self):
        real_transfer = app.file_operations.transfer
        def fail_second(source, *args):
            if source == self.second:
                raise OSError("simulated failure")
            return real_transfer(source, *args)
        with patch.object(app.threading, "Thread", ImmediateThread), patch.object(app.GLib, "idle_add") as idle, \
             patch.object(app.file_operations, "transfer", side_effect=fail_second):
            app.DirGroupWindow.on_file_operation_request(self.window, None, self.request)
        self.assertEqual((self.dst / "first").read_text(), "first data")
        self.assertFalse(self.first.exists())
        self.assertEqual(self.second.read_text(), "second data")
        self.assertFalse((self.dst / "second").exists())
        self.assertEqual([path for path, _ in self.window.file_clipboard[0]], [self.second])
        self.assertIn("1 件成功、1 件", idle.call_args.args[1]["error"])

    def test_trash_confirmation_cancel_never_invokes_trash(self):
        self.request.get_js_value.return_value.to_json.return_value = json.dumps(
            {"paneId": "1", "action": "trash", "paths": [str(self.first), str(self.second)]})
        dialog = Mock()
        dialog.run.return_value = app.Gtk.ResponseType.CANCEL
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.file_operations, "trash") as trash:
            app.DirGroupWindow.on_file_operation_request(self.window, None, self.request)
        trash.assert_not_called()
        self.assertEqual(self.first.read_text(), "first data")
        self.assertEqual(self.second.read_text(), "second data")
        dialog.set_default_response.assert_called_once_with(app.Gtk.ResponseType.CANCEL)


if __name__ == "__main__":
    unittest.main()
