import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import file_operations as ops


class FileOperationsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source_dir = self.base / "source"
        self.destination = self.base / "destination"
        self.source_dir.mkdir()
        self.destination.mkdir()

    def test_copy_file_and_collision(self):
        source = self.source_dir / "file.txt"
        source.write_text("content")
        target = ops.transfer(source, str(self.destination), False, ops.identity(source))
        self.assertEqual(target.read_text(), "content")
        self.assertEqual(source.read_text(), "content")
        with self.assertRaises(ValueError):
            ops.transfer(source, str(self.destination), False, ops.identity(source))
        self.assertEqual(target.read_text(), "content")

    def test_numbered_copy_and_cut(self):
        source = self.source_dir / "file.txt"
        source.write_text("new")
        (self.destination / "file.txt").write_text("original")
        (self.destination / "file (1).txt").write_text("first")
        expected = ops.identity(source)
        copied = ops.transfer(source, str(self.destination), False, expected, "numbered")
        self.assertEqual(copied.name, "file (2).txt")
        self.assertEqual(copied.read_text(), "new")
        moved = ops.transfer(source, str(self.destination), True, expected, "numbered")
        self.assertEqual(moved.name, "file (3).txt")
        self.assertFalse(source.exists())
        self.assertEqual((self.destination / "file.txt").read_text(), "original")

    def test_numbering_folders_extensions_hidden_and_same_folder(self):
        for name, expected in (("archive.tar.gz", "archive.tar (1).gz"), (".env", ".env (1)"), ("plain", "plain (1)")):
            source = self.source_dir / name
            source.write_text("test")
            result = ops.transfer(source, str(self.source_dir), False, ops.identity(source), "numbered")
            self.assertEqual(result.name, expected)
        folder = self.source_dir / "folder.ext"
        folder.mkdir()
        result = ops.transfer(folder, str(self.source_dir), False, ops.identity(folder), "numbered")
        self.assertEqual(result.name, "folder.ext (1)")

    def test_overwrite_copy_and_move(self):
        for cut in (False, True):
            with self.subTest(cut=cut):
                source = self.source_dir / ("cut" if cut else "copy")
                target = self.destination / source.name
                source.write_text("new")
                target.write_text("old")
                self.assertTrue(ops.can_overwrite(source, target))
                result = ops.transfer(source, str(self.destination), cut, ops.identity(source), "overwrite", ops.file_snapshot(target))
                self.assertEqual(result.read_text(), "new")
                self.assertEqual(source.exists(), not cut)

    def test_overwrite_rejects_changed_targets_and_special_types(self):
        source = self.source_dir / "file"
        target = self.destination / "file"
        source.write_text("new")
        target.write_text("old")
        snapshot = ops.file_snapshot(target)
        target.write_text("changed")
        with self.assertRaises(ValueError):
            ops.transfer(source, str(self.destination), False, ops.identity(source), "overwrite", snapshot)
        self.assertEqual(target.read_text(), "changed")
        self.assertFalse(ops.can_overwrite(source, source))
        link = self.source_dir / "link"
        link.symlink_to(source)
        self.assertFalse(ops.can_overwrite(link, target))
        self.assertFalse(ops.can_overwrite(source, self.destination))

    def test_overwrite_rejects_changed_source(self):
        source = self.source_dir / "file"
        target = self.destination / "file"
        source.write_text("new")
        target.write_text("old")
        expected = ops.identity(source)
        source_snapshot = ops.file_snapshot(source)
        target_snapshot = ops.file_snapshot(target)
        source.write_text("changed")
        with self.assertRaises(ValueError):
            ops.transfer(source, str(self.destination), True, expected, "overwrite", target_snapshot, source_snapshot)
        self.assertEqual(target.read_text(), "old")
        self.assertEqual(source.read_text(), "changed")

    def test_failed_overwrite_preserves_existing_file(self):
        source = self.source_dir / "file"
        target = self.destination / "file"
        source.write_text("new")
        target.write_text("old")
        snapshot = ops.file_snapshot(target)
        with patch.object(ops.os, "replace", side_effect=OSError("failed")):
            with self.assertRaises(OSError):
                ops.transfer(source, str(self.destination), False, ops.identity(source), "overwrite", snapshot)
        self.assertEqual(target.read_text(), "old")
        self.assertEqual(source.read_text(), "new")
        self.assertEqual(sorted(p.name for p in self.destination.iterdir()), ["file"])

    def test_same_folder_cut_is_rejected(self):
        source = self.source_dir / "file"
        source.write_text("keep")
        with self.assertRaises(ValueError):
            ops.transfer(source, str(self.source_dir), True, ops.identity(source), "numbered")
        self.assertEqual(source.read_text(), "keep")

    def test_cut_moves_and_rejects_changed_source(self):
        source = self.source_dir / "file.txt"
        source.write_text("content")
        expected = ops.identity(source)
        with self.assertRaises(ValueError):
            ops.transfer(source, str(self.destination), True, (0, 0, 0))
        target = ops.transfer(source, str(self.destination), True, expected)
        self.assertFalse(source.exists())
        self.assertEqual(target.read_text(), "content")

    def test_copy_directory_and_symbolic_links_without_following(self):
        source = self.source_dir / "folder"
        source.mkdir()
        (source / "file").write_text("data")
        (source / "link").symlink_to(self.source_dir, target_is_directory=True)
        target = ops.transfer(source, str(self.destination), False, ops.identity(source))
        self.assertEqual((target / "file").read_text(), "data")
        self.assertTrue((target / "link").is_symlink())
        self.assertEqual(os.readlink(target / "link"), str(self.source_dir))

    def test_directory_cannot_be_copied_into_itself(self):
        source = self.source_dir / "folder"
        child = source / "child"
        child.mkdir(parents=True)
        for dest in (source, child):
            with self.assertRaises(ValueError):
                ops.transfer(source, str(dest), False, ops.identity(source))

    def test_top_level_link_is_not_resolved(self):
        source = self.source_dir / "link"
        source.symlink_to(self.destination, target_is_directory=True)
        self.assertEqual(ops.entry_path(str(source)), source)
        target = ops.transfer(source, str(self.destination), False, ops.identity(source))
        self.assertTrue(target.is_symlink())

    def test_copy_partial_failure_reports_remaining_target(self):
        source = self.source_dir / "folder"
        source.mkdir()
        (source / "pipe").touch()
        with patch.object(ops, "copy_entry", side_effect=lambda source, target: (target.mkdir(), (_ for _ in ()).throw(ValueError("failed")))):
            with self.assertRaisesRegex(RuntimeError, "途中のコピー"):
                ops.transfer(source, str(self.destination), False, ops.identity(source))

    def test_trash_uses_gio_and_never_permanently_deletes(self):
        source = self.source_dir / "file"
        source.touch()
        fake = Mock()
        fake.trash.return_value = False
        with patch.object(ops.Gio.File, "new_for_path", return_value=fake):
            with self.assertRaises(RuntimeError):
                ops.trash(source, ops.identity(source))
        self.assertTrue(source.exists())
        fake.delete.assert_not_called()

    def test_invalid_paths(self):
        for value in (None, "relative", "/", str(self.source_dir / "missing")):
            with self.assertRaises((ValueError, OSError)):
                ops.entry_path(value)

    def test_create_empty_file_and_directory(self):
        file = ops.create_entry(str(self.destination), "テスト file.txt", False)
        folder = ops.create_entry(str(self.destination), "テスト folder", True)
        self.assertEqual(file.read_bytes(), b"")
        self.assertTrue(folder.is_dir())

    def test_create_never_overwrites_existing_entry(self):
        file = self.destination / "existing"
        file.write_text("keep")
        for directory in (True, False):
            with self.assertRaises(Exception):
                ops.create_entry(str(self.destination), "existing", directory)
        self.assertEqual(file.read_text(), "keep")

    def test_create_rejects_invalid_names_and_destination(self):
        for name in (None, "", "   ", ".", "..", "a/b", "a\0b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ops.create_entry(str(self.destination), name, False)
        for destination in (None, "relative", str(self.base / "missing")):
            with self.subTest(destination=destination), self.assertRaises((ValueError, OSError)):
                ops.create_entry(destination, "new", False)

    def test_create_rejects_existing_dangling_link(self):
        link = self.destination / "dangling"
        link.symlink_to(self.base / "missing")
        with self.assertRaises(Exception):
            ops.create_entry(str(self.destination), "dangling", False)
        self.assertTrue(link.is_symlink())

    def test_rename_file_and_directory(self):
        source = self.source_dir / "old.txt"
        source.write_text("keep")
        target = ops.rename_entry(source, "new.txt", ops.identity(source))
        self.assertFalse(source.exists())
        self.assertEqual(target.read_text(), "keep")
        folder = self.source_dir / "old folder"
        folder.mkdir()
        (folder / "child").write_text("child")
        renamed = ops.rename_entry(folder, "new folder", ops.identity(folder))
        self.assertEqual((renamed / "child").read_text(), "child")

    def test_rename_symlink_preserves_target(self):
        original = self.source_dir / "original"
        original.write_text("keep")
        link = self.source_dir / "link"
        link.symlink_to(original)
        renamed = ops.rename_entry(link, "new link", ops.identity(link))
        self.assertTrue(renamed.is_symlink())
        self.assertEqual(original.read_text(), "keep")
        self.assertEqual(os.readlink(renamed), str(original))

    def test_rename_rejects_collision_invalid_and_stale_source(self):
        source = self.source_dir / "old"
        source.write_text("source")
        existing = self.source_dir / "existing"
        existing.write_text("keep")
        expected = ops.identity(source)
        for name in ("existing", "", "..", "folder/item"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ops.rename_entry(source, name, expected)
        with self.assertRaises(ValueError):
            ops.rename_entry(source, "new", (0, 0, 0))
        self.assertEqual(ops.rename_entry(source, "old", expected), source)
        self.assertEqual(source.read_text(), "source")
        self.assertEqual(existing.read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
