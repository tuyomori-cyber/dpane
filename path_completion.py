"""Directory-only completion for local absolute and current-user home paths."""
from __future__ import annotations

import heapq
import os
from pathlib import Path

from gi.repository import Gio


MAX_COMPLETIONS = 100


def complete_path(value: object) -> dict[str, object]:
    empty = {"candidates": [], "common": "", "count": 0}
    if not isinstance(value, str) or len(value) > 4096 or "\0" in value:
        return empty
    if not (value.startswith("/") or value.startswith("~/")):
        return empty
    parent, _, prefix = value.rpartition("/")
    parent = parent or "/"
    try:
        folder = Path(parent).expanduser()
        if not folder.is_absolute():
            return empty
        directory = Gio.File.new_for_path(str(folder))
        enumerator = directory.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, None)
        common = None
        count = 0
        candidates = []
        try:
            while True:
                info = enumerator.next_file(None)
                if info is None:
                    break
                name = info.get_name()
                if not name.startswith(prefix) or (name.startswith(".") and not prefix.startswith(".")):
                    continue
                file_type = info.get_file_type()
                if file_type == Gio.FileType.SYMBOLIC_LINK:
                    file_type = directory.get_child(name).query_file_type(Gio.FileQueryInfoFlags.NONE, None)
                if file_type != Gio.FileType.DIRECTORY:
                    continue
                count += 1
                common = name if common is None else os.path.commonprefix((common, name))
                # Keep only the first sorted names, while considering every match for common prefix.
                candidates.append(name)
                if len(candidates) > MAX_COMPLETIONS * 2:
                    candidates = heapq.nsmallest(MAX_COMPLETIONS, candidates)
        finally:
            enumerator.close(None)
        return {"candidates": heapq.nsmallest(MAX_COMPLETIONS, candidates), "common": common or "", "count": count}
    except Exception:
        return empty
