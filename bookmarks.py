"""Persistent directory bookmarks for the local application."""
import json
import os
import tempfile
from pathlib import Path


def load(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1 or not isinstance(data.get("bookmarks"), list):
            raise ValueError("ブックマークの形式が不正です。")
        paths = []
        for item in data["bookmarks"]:
            value = item.get("path") if isinstance(item, dict) else None
            if not isinstance(value, str) or not Path(value).is_absolute() or "\0" in value:
                raise ValueError("ブックマークのパスが不正です。")
            if value not in paths:
                paths.append(value)
        return paths
    except FileNotFoundError:
        return []


def save(path, paths):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".bookmarks-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump({"version": 1, "bookmarks": [{"path": value} for value in paths]}, stream, ensure_ascii=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def normalize(value):
    if not isinstance(value, str) or not value.startswith("/") or "\0" in value:
        raise ValueError("絶対パスを指定してください。")
    path = Path(value).resolve(strict=True)
    if not path.is_dir():
        raise ValueError("ディレクトリではありません。")
    return str(path)
