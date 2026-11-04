import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("dir_group_app", Path(__file__).resolve().parents[1] / "app.py")
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


class FileActionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "test program"
        self.path.write_text("test")
        self.path.chmod(0o755)

    def test_resolve_rejects_invalid_targets(self):
        for value in (None, "relative", self.temp.name, str(self.path / "missing")):
            self.assertIsNotNone(app.resolve_file(value)[1])

    def test_permissions_and_desktop_are_rejected(self):
        self.path.chmod(0o644)
        self.assertIsNotNone(app.executable_error(self.path))
        self.assertIsNotNone(app.executable_error(self.path.with_suffix(".desktop")))

    def test_executable_binary_detection(self):
        self.path.write_bytes(b"\x7fELF\x02\x01" + bytes(10) + b"\x02\x00")
        self.assertTrue(app.is_executable_binary(self.path))
        self.path.chmod(0o644)
        self.assertFalse(app.is_executable_binary(self.path))
        self.path.chmod(0o755)
        self.path.write_text("#!/bin/sh\nexit 0\n")
        self.assertFalse(app.is_executable_binary(self.path))
        self.path.write_text("%PDF-1.7")
        self.assertFalse(app.is_executable_binary(self.path))
        self.path.write_bytes(b"\x7fELF\x02\x01" + bytes(10) + b"\x01\x00")
        self.assertFalse(app.is_executable_binary(self.path))

    def test_default_open_runs_executable_binary_but_explicit_choice_does_not(self):
        self.path.write_bytes(b"\x7fELF\x02\x01" + bytes(10) + b"\x03\x00")
        window = Mock()
        window.execute_file.return_value = {"cancelled": True}
        result = app.DirGroupWindow.open_file(window, str(self.path), False)
        self.assertTrue(result["cancelled"])
        window.execute_file.assert_called_once_with(str(self.path), auto=True)
        window.choose_app.return_value = {"cancelled": True}
        app.DirGroupWindow.open_file(window, str(self.path), True)
        window.choose_app.assert_called_once()

    def test_changed_binary_is_not_executed_after_confirmation(self):
        self.path.write_bytes(b"\x7fELF\x02\x01" + bytes(10) + b"\x02\x00")
        dialog = Mock()
        def change():
            self.path.write_text("#!/bin/sh\n")
            return app.Gtk.ResponseType.OK
        dialog.run.side_effect = change
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.subprocess, "Popen") as popen:
            result = app.DirGroupWindow.execute_file(object(), str(self.path), auto=True)
        self.assertIn("error", result)
        popen.assert_not_called()

    def test_cancel_never_executes(self):
        dialog = Mock()
        dialog.run.return_value = app.Gtk.ResponseType.CANCEL
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.subprocess, "Popen") as popen:
            result = app.DirGroupWindow.execute_file(object(), str(self.path))
        self.assertTrue(result["cancelled"])
        popen.assert_not_called()
        dialog.destroy.assert_called_once()

    def test_accepted_execution_has_no_shell_or_arguments(self):
        dialog = Mock()
        dialog.run.return_value = app.Gtk.ResponseType.OK
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.subprocess, "Popen") as popen:
            result = app.DirGroupWindow.execute_file(object(), str(self.path))
        self.assertEqual(result["path"], str(self.path))
        args, kwargs = popen.call_args
        self.assertEqual(args, ([str(self.path)],))
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["cwd"], self.temp.name)

    def test_revalidate_after_confirmation(self):
        dialog = Mock()
        def revoke():
            self.path.chmod(0o644)
            return app.Gtk.ResponseType.OK
        dialog.run.side_effect = revoke
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.subprocess, "Popen") as popen:
            result = app.DirGroupWindow.execute_file(object(), str(self.path))
        self.assertIn("error", result)
        popen.assert_not_called()

    def test_launch_failure_is_reported(self):
        dialog = Mock()
        dialog.run.return_value = app.Gtk.ResponseType.OK
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.subprocess, "Popen", side_effect=OSError("failed")):
            result = app.DirGroupWindow.execute_file(object(), str(self.path))
        self.assertIn("failed", result["error"])

    def test_missing_default_uses_chooser(self):
        window = Mock()
        window.choose_app.return_value = {"cancelled": True}
        with patch.object(app.Gio.AppInfo, "get_default_for_type", return_value=None):
            result = app.DirGroupWindow.open_file(window, str(self.path), False)
        self.assertTrue(result["cancelled"])
        window.choose_app.assert_called_once()

    def test_explicit_choice_uses_chooser(self):
        window = Mock()
        window.choose_app.return_value = {"cancelled": True}
        with patch.object(app.Gio.AppInfo, "get_default_for_type", return_value=Mock()):
            app.DirGroupWindow.open_file(window, str(self.path), True)
        window.choose_app.assert_called_once()

    def test_chooser_cancellation_and_selected_app(self):
        dialog, chooser, selected = Mock(), Mock(), Mock()
        selected.launch.return_value = True
        chooser.get_app_info.return_value = selected
        file = app.Gio.File.new_for_path(str(self.path))
        with patch.object(app.Gtk, "Dialog", return_value=dialog), patch.object(app.Gtk, "Label", return_value=Mock()), patch.object(app.Gtk.AppChooserWidget, "new", return_value=chooser):
            dialog.run.return_value = app.Gtk.ResponseType.CANCEL
            result = app.DirGroupWindow.choose_app(object(), file, self.path, "text/plain")
            self.assertTrue(result["cancelled"])
            selected.launch.assert_not_called()
            dialog.run.return_value = app.Gtk.ResponseType.OK
            result = app.DirGroupWindow.choose_app(object(), file, self.path, "text/plain")
        self.assertEqual(result["path"], str(self.path))
        selected.launch.assert_called_once()
        selected.set_as_default_for_type.assert_not_called()
        selected.set_as_last_used_for_type.assert_not_called()

    def test_chooser_without_selection_reports_no_application(self):
        dialog, chooser = Mock(), Mock()
        dialog.run.return_value = app.Gtk.ResponseType.OK
        chooser.get_app_info.return_value = None
        with patch.object(app.Gtk, "Dialog", return_value=dialog), patch.object(app.Gtk, "Label", return_value=Mock()), patch.object(app.Gtk.AppChooserWidget, "new", return_value=chooser):
            result = app.DirGroupWindow.choose_app(object(), app.Gio.File.new_for_path(str(self.path)), self.path, "text/plain")
        self.assertIn("アプリ", result["error"])

    def test_new_file_cancel_does_not_create(self):
        window, dialog, entry, request = Mock(), Mock(), Mock(), Mock()
        window.file_operation_busy = False
        request.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": "1", "action": "new_file", "path": self.temp.name})
        dialog.run.return_value = app.Gtk.ResponseType.CANCEL
        with patch.object(app.Gtk, "Dialog", return_value=dialog), patch.object(app.Gtk, "Entry", return_value=entry), patch.object(app.file_operations, "create_entry") as create:
            app.DirGroupWindow.on_file_operation_request(window, None, request)
        create.assert_not_called()
        self.assertIn("キャンセル", window.send_to_ui.call_args.args[1]["message"])

    def test_multiple_copy_reservation_validates_every_selected_path(self):
        second = Path(self.temp.name) / "second"
        second.write_text("second")
        window, request = Mock(), Mock()
        window.file_operation_busy = False
        request.get_js_value.return_value.to_json.return_value = json.dumps(
            {"paneId": "1", "action": "copy", "paths": [str(self.path), str(second)]}
        )
        app.DirGroupWindow.on_file_operation_request(window, None, request)
        entries, cut = window.file_clipboard
        self.assertFalse(cut)
        self.assertEqual([path for path, _identity in entries], [self.path, second])
        self.assertIn("2 件", window.send_to_ui.call_args.args[1]["message"])

    def test_multiple_paste_copies_every_reserved_item(self):
        class ImmediateThread:
            def __init__(self, target, daemon):
                self.target = target
            def start(self):
                self.target()

        second = Path(self.temp.name) / "second"
        destination = Path(self.temp.name) / "destination"
        second.write_text("second")
        destination.mkdir()
        window, request = Mock(), Mock()
        window.file_operation_busy = False
        window.file_clipboard = ([(self.path, app.file_operations.identity(self.path)),
                                 (second, app.file_operations.identity(second))], False)
        request.get_js_value.return_value.to_json.return_value = json.dumps(
            {"paneId": "1", "action": "paste", "path": str(destination)}
        )
        with patch.object(app.threading, "Thread", ImmediateThread), patch.object(app.GLib, "idle_add"):
            app.DirGroupWindow.on_file_operation_request(window, None, request)
        self.assertEqual((destination / self.path.name).read_text(), "test")
        self.assertEqual((destination / second.name).read_text(), "second")

    def test_rename_updates_copy_and_cut_reservations(self):
        class ImmediateThread:
            def __init__(self, target, daemon):
                self.target = target
            def start(self):
                self.target()

        for cut in (False, True):
            with self.subTest(cut=cut):
                source = Path(self.temp.name) / ("cut" if cut else "copy")
                source.write_text("content")
                window, dialog, entry, request = Mock(), Mock(), Mock(), Mock()
                window.file_operation_busy = False
                expected = app.file_operations.identity(source)
                window.file_clipboard = ([(source, expected)], cut)
                request.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": "1", "action": "rename", "paths": [str(source)]})
                dialog.run.return_value = app.Gtk.ResponseType.OK
                entry.get_text.return_value = source.name + "-new"
                with patch.object(app.Gtk, "Dialog", return_value=dialog), patch.object(app.Gtk, "Entry", return_value=entry), patch.object(app.threading, "Thread", ImmediateThread), patch.object(app.GLib, "idle_add"):
                    app.DirGroupWindow.on_file_operation_request(window, None, request)
                renamed = source.with_name(source.name + "-new")
                self.assertEqual(window.file_clipboard, ([(renamed, expected)], cut))
                self.assertEqual(renamed.read_text(), "content")

    def test_paste_collision_cancel_preserves_cut_reservation(self):
        source = Path(self.temp.name) / "source" / "file"
        target = Path(self.temp.name) / "target" / "file"
        source.parent.mkdir()
        target.parent.mkdir()
        source.write_text("source")
        target.write_text("target")
        window, dialog, request = Mock(), Mock(), Mock()
        window.file_operation_busy = False
        window.file_clipboard = ([(source, app.file_operations.identity(source))], True)
        request.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": "1", "action": "paste", "path": str(target.parent)})
        dialog.run.return_value = app.Gtk.ResponseType.CANCEL
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog), patch.object(app.file_operations, "transfer") as transfer:
            app.DirGroupWindow.on_file_operation_request(window, None, request)
        transfer.assert_not_called()
        self.assertIsNotNone(window.file_clipboard)
        self.assertEqual(source.read_text(), "source")
        self.assertEqual(target.read_text(), "target")

    def test_folder_collision_does_not_offer_overwrite(self):
        source = Path(self.temp.name) / "source" / "folder"
        target = Path(self.temp.name) / "target" / "folder"
        source.mkdir(parents=True)
        target.mkdir(parents=True)
        window, dialog, request = Mock(), Mock(), Mock()
        window.file_operation_busy = False
        window.file_clipboard = ([(source, app.file_operations.identity(source))], False)
        request.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": "1", "action": "paste", "path": str(target.parent)})
        dialog.run.return_value = app.Gtk.ResponseType.CANCEL
        with patch.object(app.Gtk, "MessageDialog", return_value=dialog):
            app.DirGroupWindow.on_file_operation_request(window, None, request)
        labels = [call.args[0] for call in dialog.add_button.call_args_list]
        self.assertNotIn("上書き", labels)
        self.assertIn("連番を付ける", labels)


if __name__ == "__main__":
    unittest.main()
