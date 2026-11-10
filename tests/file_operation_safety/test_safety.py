import errno
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import file_operations as ops


class SafetyTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.src_dir = root / "source"
        self.dst_dir = root / "destination"
        self.src_dir.mkdir()
        self.dst_dir.mkdir()
        self.source = self.src_dir / "item.txt"
        self.target = self.dst_dir / self.source.name
        self.source.write_text("source data")
        self.target.write_text("destination data")
        self.identity = ops.identity(self.source)
        self.source_snapshot = ops.file_snapshot(self.source)
        self.target_snapshot = ops.file_snapshot(self.target)

    def overwrite(self, cut=False):
        return ops.transfer(self.source, str(self.dst_dir), cut, self.identity, "overwrite",
                            self.target_snapshot, self.source_snapshot)

    def assert_contents(self, source="source data", target="destination data"):
        self.assertEqual(self.source.read_text(), source)
        self.assertEqual(self.target.read_text(), target)
        self.assertEqual(sorted(path.name for path in self.dst_dir.iterdir()), ["item.txt"])

    def test_cross_device_move_overwrite_failure_keeps_both_files(self):
        with patch.object(ops.os, "replace", side_effect=OSError(errno.EXDEV, "cross-device")):
            with self.assertRaises(OSError) as error:
                self.overwrite(cut=True)
        self.assertEqual(error.exception.errno, errno.EXDEV)
        self.assert_contents()

    def test_partial_copy_to_temporary_file_is_removed_on_failure(self):
        fake_source = Mock()
        def fail_copy(target, *_args):
            Path(target.get_path()).write_text("partial data")
            raise OSError(errno.ENOSPC, "disk full")
        fake_source.copy.side_effect = fail_copy
        original = ops.Gio.File.new_for_path
        with patch.object(ops.Gio.File, "new_for_path", side_effect=lambda path: fake_source if path == str(self.source) else original(path)):
            with self.assertRaises(OSError):
                self.overwrite()
        self.assert_contents()

    def test_changes_during_copy_prevent_replace(self):
        for changed in ("source", "target"):
            with self.subTest(changed=changed):
                self.source.write_text("source data")
                self.target.write_text("destination data")
                self.identity = ops.identity(self.source)
                self.source_snapshot = ops.file_snapshot(self.source)
                self.target_snapshot = ops.file_snapshot(self.target)
                real_factory = ops.Gio.File.new_for_path
                real_source = real_factory(str(self.source))
                fake_source = Mock()
                def copy_then_change(target, *args):
                    real_source.copy(target, *args)
                    (self.source if changed == "source" else self.target).write_text("changed during copy")
                fake_source.copy.side_effect = copy_then_change
                with patch.object(ops.Gio.File, "new_for_path", side_effect=lambda path: fake_source if path == str(self.source) else real_factory(path)):
                    with self.assertRaises(ValueError):
                        self.overwrite()
                self.assert_contents("changed during copy" if changed == "source" else "source data",
                                     "changed during copy" if changed == "target" else "destination data")

    def test_numbered_destination_created_after_selection_is_not_overwritten(self):
        real_numbered = ops.numbered_target
        def concurrent_creation(source, target):
            result = real_numbered(source, target)
            result.write_text("concurrent data")
            return result
        with patch.object(ops, "numbered_target", side_effect=concurrent_creation):
            with self.assertRaises(Exception):
                ops.transfer(self.source, str(self.dst_dir), False, self.identity, "numbered")
        self.assertEqual(self.source.read_text(), "source data")
        self.assertEqual(self.target.read_text(), "destination data")
        self.assertEqual((self.dst_dir / "item (1).txt").read_text(), "concurrent data")

    def test_trash_rejects_replaced_object_without_calling_gio(self):
        replacement = self.src_dir / "replacement"
        replacement.write_text("replacement data")
        os.replace(replacement, self.source)
        with patch.object(ops.Gio.File, "new_for_path") as gio:
            with self.assertRaises(ValueError):
                ops.trash(self.source, self.identity)
        gio.assert_not_called()
        self.assertEqual(self.source.read_text(), "replacement data")

    def test_trash_exception_does_not_fall_back_to_delete(self):
        fake = Mock()
        fake.trash.side_effect = OSError("trash unavailable")
        with patch.object(ops.Gio.File, "new_for_path", return_value=fake):
            with self.assertRaises(OSError):
                ops.trash(self.source, self.identity)
        fake.delete.assert_not_called()
        self.assert_contents()


if __name__ == "__main__":
    unittest.main()
