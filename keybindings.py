"""Validated, user-editable keyboard shortcuts."""
import json
import os
import re
import tempfile
from pathlib import Path

DEFAULTS = {
    "splitRight": "Ctrl+Shift+L", "splitDown": "Ctrl+Shift+J", "closePane": "Ctrl+Shift+W",
    "toggleTimes": "Ctrl+T", "showShortcuts": "Ctrl+K", "nextPane": "Ctrl+Tab",
    "previousPane": "Ctrl+Shift+Tab",
    **{f"pane{number}": f"Alt+{number}" for number in range(1, 9)},
    "chooseApplication": "Ctrl+Shift+O", "execute": "Ctrl+Shift+E",
}


def normalize(value):
    if not isinstance(value, str):
        raise ValueError("キーの組み合わせは文字列で指定してください")
    parts = value.split("+")
    modifiers = [part.lower() for part in parts[:-1]]
    if len(set(modifiers)) != len(modifiers) or any(part not in ("ctrl", "shift", "alt", "meta") for part in modifiers):
        raise ValueError(f"修飾キーが不正です: {value}")
    key = parts[-1]
    if re.fullmatch(r"[a-zA-Z0-9]", key):
        key = key.upper()
    elif re.fullmatch(r"f([1-9]|1[0-2])", key.lower()):
        key = key.upper()
    elif key.lower() == "tab":
        key = "Tab"
    else:
        raise ValueError(f"使用できないキーです: {value}")
    if not modifiers:
        raise ValueError(f"修飾キーを指定してください: {value}")
    return "+".join([name for name in ("Ctrl", "Shift", "Alt", "Meta") if name.lower() in modifiers] + [key])


def load(path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return DEFAULTS.copy(), None
    except (OSError, ValueError, UnicodeError) as error:
        return DEFAULTS.copy(), f"ショートカット設定を読み込めません: {error}"
    try:
        if not isinstance(data, dict) or set(data) - DEFAULTS.keys():
            raise ValueError("未知の操作名または不正な形式です")
        bindings = {**DEFAULTS, **{name: normalize(value) for name, value in data.items()}}
        if len(set(bindings.values())) != len(bindings):
            raise ValueError("ショートカットが重複しています")
        if set(bindings.values()) & {"Ctrl+C", "Ctrl+X", "Ctrl+V", "Shift+Tab"}:
            raise ValueError("固定されたショートカットと重複しています")
        return bindings, None
    except ValueError as error:
        return DEFAULTS.copy(), f"ショートカット設定が不正です（初期値を使用）: {error}"


def reset(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".keybindings-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write("{}\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
