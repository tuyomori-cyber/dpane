"""Local file operations with explicit collision handling."""
from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

from gi.repository import Gio


def entry_path(value: object) -> Path:
    if not isinstance(value, str) or not value or not os.path.isabs(value):
        raise ValueError("絶対パスを指定してください。")
    path = Path(os.path.abspath(value))
    if path == path.parent:
        raise ValueError("ルートディレクトリは対象にできません。")
    # Resolve only the parent: operations on a symbolic link must not follow it.
    path = path.parent.resolve(strict=True) / path.name
    path.lstat()
    return path


def identity(path: Path) -> tuple[int, int, int]:
    info = path.lstat()
    return info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode)


def validate_name(name: object) -> str:
    if not isinstance(name, str) or not name.strip() or name in (".", "..") or "/" in name or "\0" in name:
        raise ValueError("空の名前、/ を含む名前、または . や .. は使えません。")
    return name


def create_entry(destination: object, name: object, directory: bool) -> Path:
    name = validate_name(name)
    if not isinstance(destination, str) or not os.path.isabs(destination):
        raise ValueError("作成先が不正です。")
    folder = Path(destination).resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("作成先はフォルダではありません。")
    target = folder / name
    file = Gio.File.new_for_path(str(target))
    if directory:
        file.make_directory(None)
    else:
        stream = file.create(Gio.FileCreateFlags.NONE, None)
        stream.close(None)
    return target


def rename_entry(source: Path, name: object, expected: tuple[int, int, int]) -> Path:
    name = validate_name(name)
    if identity(source) != expected:
        raise ValueError("確認後に対象が変更されました。もう一度操作してください。")
    target = source.parent / name
    if target == source:
        return source
    if os.path.lexists(target):
        raise ValueError("同じ名前の項目があります。上書きしません。")
    Gio.File.new_for_path(str(source)).move(
        Gio.File.new_for_path(str(target)), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
        None, None, None,
    )
    return target


def target_path(source: Path, destination: object) -> Path:
    target = paste_target(source, destination)
    if source == target or os.path.lexists(target):
        raise ValueError("貼り付け先に同名の項目があります。上書きしません。")
    return target


def paste_target(source: Path, destination: object) -> Path:
    if not isinstance(destination, str) or not os.path.isabs(destination):
        raise ValueError("貼り付け先が不正です。")
    folder = Path(destination).resolve(strict=True)
    if not folder.is_dir():
        raise ValueError("貼り付け先はフォルダではありません。")
    target = folder / source.name
    if stat.S_ISDIR(source.lstat().st_mode) and (folder == source or source in folder.parents):
        raise ValueError("フォルダ自身またはその中には貼り付けできません。")
    return target


def file_snapshot(path: Path) -> tuple[int, int, int, int, int, int]:
    info = path.lstat()
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def can_overwrite(source: Path, target: Path) -> bool:
    try:
        return (stat.S_ISREG(source.lstat().st_mode) and stat.S_ISREG(target.lstat().st_mode)
                and not os.path.samefile(source, target))
    except OSError:
        return False


def numbered_target(source: Path, target: Path) -> Path:
    is_dir = stat.S_ISDIR(source.lstat().st_mode)
    suffix = "" if is_dir else source.suffix
    stem = source.name[:-len(suffix)] if suffix else source.name
    number = 1
    while True:
        candidate = target.with_name(f"{stem} ({number}){suffix}")
        if not os.path.lexists(candidate):
            return candidate
        number += 1


def copy_entry(source: Path, target: Path) -> None:
    mode = source.lstat().st_mode
    if stat.S_ISDIR(mode):
        Gio.File.new_for_path(str(target)).make_directory(None)
        with os.scandir(source) as entries:
            for entry in entries:
                copy_entry(source / entry.name, target / entry.name)
    elif stat.S_ISREG(mode) or stat.S_ISLNK(mode):
        Gio.File.new_for_path(str(source)).copy(
            Gio.File.new_for_path(str(target)), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
            None, None, None,
        )
    else:
        raise ValueError(f"特殊ファイルはコピーできません: {source.name}")


def transfer(source: Path, destination: object, cut: bool, expected: tuple[int, int, int],
             mode: str = "reject", target_snapshot: tuple | None = None,
             source_snapshot: tuple | None = None) -> Path:
    if identity(source) != expected:
        raise ValueError("コピー元が変更されました。もう一度選択してください。")
    target = paste_target(source, destination)
    if cut and source == target:
        raise ValueError("同じフォルダには移動できません。")
    if mode == "numbered":
        target = numbered_target(source, target)
    elif mode == "overwrite":
        if source_snapshot is not None and file_snapshot(source) != source_snapshot:
            raise ValueError("コピー元が変更されました。もう一度操作してください。")
        if not can_overwrite(source, target) or target_snapshot is None or file_snapshot(target) != target_snapshot:
            raise ValueError("上書き対象が変更されたか、上書きできません。")
        if cut:
            # rename is atomic on the same filesystem and fails with EXDEV across filesystems.
            os.replace(source, target)
        else:
            fd, temp_name = tempfile.mkstemp(prefix=".dir-group-copy-", dir=target.parent)
            os.close(fd)
            try:
                Gio.File.new_for_path(str(source)).copy(
                    Gio.File.new_for_path(temp_name), Gio.FileCopyFlags.OVERWRITE,
                    None, None, None,
                )
                if (identity(source) != expected or (source_snapshot is not None and file_snapshot(source) != source_snapshot)
                        or not can_overwrite(source, target) or file_snapshot(target) != target_snapshot):
                    raise ValueError("コピー中に対象が変更されました。")
                os.replace(temp_name, target)
            finally:
                if os.path.lexists(temp_name):
                    os.unlink(temp_name)
        return target
    elif mode != "reject":
        raise ValueError("不明な同名処理です。")
    elif os.path.lexists(target):
        raise ValueError("貼り付け先に同名の項目があります。上書きしません。")
    if cut:
        try:
            Gio.File.new_for_path(str(source)).move(
                Gio.File.new_for_path(str(target)), Gio.FileCopyFlags.NOFOLLOW_SYMLINKS,
                None, None, None,
            )
        except Exception as error:
            if os.path.lexists(target):
                raise RuntimeError(f"移動に失敗しました。移動先を確認してください: {target}\n{error}") from error
            raise
    else:
        try:
            copy_entry(source, target)
        except Exception as error:
            if os.path.lexists(target):
                raise RuntimeError(f"コピーに失敗しました。途中のコピーが残っている可能性があります: {target}\n{error}") from error
            raise
    return target


def trash(source: Path, expected: tuple[int, int, int]) -> None:
    if identity(source) != expected:
        raise ValueError("確認後に対象が変更されました。もう一度操作してください。")
    if not Gio.File.new_for_path(str(source)).trash(None):
        raise RuntimeError("ゴミ箱へ移動できませんでした。")
