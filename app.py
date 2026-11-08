#!/usr/bin/env python3
"""Dpaie: a local multi-pane file browser."""

from __future__ import annotations

from time import perf_counter

_IMPORT_START = perf_counter()
import json
import os
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("JavaScriptCore", "4.1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, JavaScriptCore, WebKit2  # noqa: E402

import file_operations  # noqa: E402
import path_completion  # noqa: E402
import bookmarks  # noqa: E402

_IMPORT_END = perf_counter()


class StartupTiming:
    """Optional elapsed times from Python entry; each milestone is recorded once."""

    def __init__(self, start: float, enabled: bool, summary: bool = False) -> None:
        self.start = start
        self.enabled = enabled
        self.summary = summary
        self.seen = set()

    def mark(self, name: str, description: str, timestamp: float | None = None) -> None:
        if not self.enabled or name in self.seen or (self.summary and name != "T6"):
            return
        self.seen.add(name)
        elapsed = ((perf_counter() if timestamp is None else timestamp) - self.start) * 1000
        print(f"起動計測 {name}: {elapsed:.1f} ms  {description}", file=sys.stderr, flush=True)

    def detail(self, description: str, timestamp: float | None = None) -> None:
        if self.enabled and not self.summary:
            elapsed = ((perf_counter() if timestamp is None else timestamp) - self.start) * 1000
            print(f"起動詳細 +{elapsed:.1f} ms  {description}", file=sys.stderr, flush=True)


STARTUP_TIMING = StartupTiming(
    getattr(sys.modules.get("__main__"), "DPANE_PROCESS_START", _IMPORT_START),
    os.environ.get("DPANE_STARTUP_TIMING") == "1",
    os.environ.get("DPANE_STARTUP_COMPARE") == "1",
)
STARTUP_TIMING.mark("T0", "Pythonエントリーポイント", STARTUP_TIMING.start)
STARTUP_TIMING.mark("T1", "import完了", _IMPORT_END)


APP_DIR = Path(__file__).resolve().parent
UI_FILE = APP_DIR / "ui" / "index.html"
MINIMAL_UI_FILE = APP_DIR / "ui" / "startup-minimal.html"
_inline_ui_file = None
ICON_FILES = tuple(APP_DIR / "icon" / f"window-{size}.png" for size in (16, 32, 48, 64, 128))
MAX_ENTRIES = 1_000
DEFAULT_VIEW_SETTINGS = {"scale": 100, "showHiddenEntries": True, "showShortcutHints": True,
                         "startupPaneCount": 3}
DEFAULT_INITIAL_PANE_IDS = {"1", "2", "3"}


def startup_ui_file() -> Path:
    if _inline_ui_file is not None:
        return _inline_ui_file
    if STARTUP_TIMING.enabled and not STARTUP_TIMING.summary and os.environ.get("DPANE_STARTUP_MINIMAL") == "1":
        return MINIMAL_UI_FILE
    return UI_FILE


def create_inline_ui(directory: Path) -> Path:
    html = UI_FILE.read_text(encoding="utf-8")
    css = (UI_FILE.parent / "style.css").read_text(encoding="utf-8")
    js = (UI_FILE.parent / "app.js").read_text(encoding="utf-8")
    css_tag = '<link rel="stylesheet" href="style.css">'
    js_tag = '<script src="app.js"></script>'
    if html.count(css_tag) != 1 or html.count(js_tag) != 1 or "</style" in css.lower() or "</script" in js.lower():
        raise ValueError("インライン比較用HTMLを安全に作成できません。")
    html = html.replace(css_tag, f"<style>\n{css}\n</style>", 1)
    html = html.replace(js_tag, f"<script>\n{js}\n</script>", 1)
    target = directory / "startup-inline.html"
    target.write_text(html, encoding="utf-8")
    return target


def validate_view_settings(value: object) -> dict[str, object]:
    settings = DEFAULT_VIEW_SETTINGS.copy()
    if not isinstance(value, dict):
        return settings
    scale = value.get("scale")
    if type(scale) is int and 70 <= scale <= 150 and scale % 10 == 0:
        settings["scale"] = scale
    for key in ("showHiddenEntries", "showShortcutHints"):
        if type(value.get(key)) is bool:
            settings[key] = value[key]
    startup_pane_count = value.get("startupPaneCount")
    if type(startup_pane_count) is int and 1 <= startup_pane_count <= 4:
        settings["startupPaneCount"] = startup_pane_count
    return settings


def settings_path() -> Path:
    return Path(GLib.get_user_config_dir()) / "dpane" / "settings.json"


def initial_pane_ids(window: object) -> set[str]:
    """Return the validated initial pane IDs, including for lightweight test doubles."""
    value = getattr(window, "initial_pane_ids", None)
    return value if isinstance(value, set) and value else DEFAULT_INITIAL_PANE_IDS


def load_view_settings(path: Path) -> dict[str, object]:
    try:
        return validate_view_settings(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, UnicodeError):
        return DEFAULT_VIEW_SETTINGS.copy()


def save_view_settings(path: Path, settings: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=".settings-", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(validate_view_settings(settings), stream, ensure_ascii=False)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def apply_window_icon(window: Gtk.Window) -> None:
    """Load pre-sized window icons without processing the original artwork."""
    try:
        window.set_icon_list([GdkPixbuf.Pixbuf.new_from_file(str(path)) for path in ICON_FILES])
    except GLib.Error as error:
        print(f"ウィンドウアイコンを読み込めません: {error}", file=sys.stderr)


def list_directory(requested_path: object) -> dict[str, object]:
    """Return safe, read-only directory metadata for the embedded UI."""
    if not isinstance(requested_path, str):
        return {"error": "パスが不正です。"}

    path = Path(requested_path).expanduser()
    if not path.is_absolute():
        return {"error": "絶対パスを指定してください。"}

    try:
        path = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return {"error": "指定したフォルダを確認できません。"}

    if not path.is_dir():
        return {"error": "ディレクトリではありません。"}

    entries: list[dict[str, object]] = []
    try:
        directory = Gio.File.new_for_path(str(path))
        enumerator = directory.enumerate_children(
            "standard::name,standard::type,standard::size,time::modified",
            Gio.FileQueryInfoFlags.NONE,
            None,
        )
        while len(entries) < MAX_ENTRIES:
            info = enumerator.next_file(None)
            if info is None:
                break
            file_type = info.get_file_type()
            entries.append(
                {
                    "name": info.get_name(),
                    "directory": file_type == Gio.FileType.DIRECTORY,
                    "size": info.get_size(),
                    "modified": info.get_attribute_uint64("time::modified") if info.has_attribute("time::modified") else None,
                }
            )
        enumerator.close(None)
    except Exception as error:  # GIO reports permission and I/O errors here.
        return {"error": f"一覧を取得できません: {error}"}

    entries.sort(key=lambda entry: (not entry["directory"], str(entry["name"]).casefold()))
    return {
        "path": str(path),
        "entries": entries,
        "truncated": len(entries) == MAX_ENTRIES,
    }


def resolve_file(requested_path: object) -> tuple[Path | None, str | None]:
    """Validate a local regular file without accepting relative paths."""
    if not isinstance(requested_path, str):
        return None, "パスが不正です。"

    path = Path(requested_path).expanduser()
    if not path.is_absolute():
        return None, "絶対パスを指定してください。"

    try:
        path = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "指定したファイルを確認できません。"

    if not path.is_file():
        return None, "通常のファイルではありません。"
    return path, None


def executable_error(path: Path) -> str | None:
    if path.suffix.lower() == ".desktop":
        return ".desktop ランチャーの直接実行には対応していません。"
    if not os.access(path, os.X_OK):
        return "このファイルには実行権限がありません。"
    return None


def is_executable_binary(path: Path) -> bool:
    """Recognize executable ELF files without treating scripts or documents as programs."""
    if executable_error(path):
        return False
    try:
        with path.open("rb") as stream:
            header = stream.read(18)
    except OSError:
        return False
    if len(header) < 18 or header[:4] != b"\x7fELF" or header[4] not in (1, 2):
        return False
    byte_order = {1: "little", 2: "big"}.get(header[5])
    return byte_order is not None and int.from_bytes(header[16:18], byte_order) in (2, 3)


def selected_entries(value: object) -> list[tuple[Path, tuple[int, int, int]]]:
    """Validate an unbounded, non-empty selection without trusting UI paths."""
    if not isinstance(value, list) or not value:
        raise ValueError("操作する項目を選択してください。")
    entries = []
    seen = set()
    for item in value:
        path = file_operations.entry_path(item)
        if path in seen:
            raise ValueError("同じ項目が重複しています。")
        seen.add(path)
        entries.append((path, file_operations.identity(path)))
    return entries


class DirGroupWindow(Gtk.ApplicationWindow):
    def __init__(self, application: Gtk.Application) -> None:
        super().__init__(application=application, title="Dpaie")
        self.ui_file = startup_ui_file()
        self.startup_reply = (STARTUP_TIMING.enabled and not STARTUP_TIMING.summary and self.ui_file == UI_FILE
                              and os.environ.get("DPANE_STARTUP_REPLY") == "1")
        self.startup_batch = (STARTUP_TIMING.enabled and not STARTUP_TIMING.summary and self.ui_file == UI_FILE
                              and not self.startup_reply and os.environ.get("DPANE_STARTUP_BATCH") == "1")
        self.startup_page_loaded = False
        self.startup_responses = []
        if STARTUP_TIMING.enabled and not STARTUP_TIMING.summary:
            print(f"起動計測 HTML: {'最小' if self.ui_file == MINIMAL_UI_FILE else '通常'} (load_uri)",
                  file=sys.stderr, flush=True)
            if self.ui_file == UI_FILE:
                mode = "応答付きメッセージ" if self.startup_reply else ("読み込み完了後に一括" if self.startup_batch else "取得ごと")
                print(f"起動計測 一覧送信: {mode}",
                      file=sys.stderr, flush=True)
        self.set_default_size(1200, 760)
        apply_window_icon(self)
        self.file_clipboard = None
        self.file_operation_busy = False
        self.completion_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="path-completion")
        self.initial_listing_ids = set()
        self.startup_script_traced = set()
        self.connect("delete-event", self.on_window_delete)

        manager = WebKit2.UserContentManager()
        if self.startup_reply:
            if not manager.register_script_message_handler_with_reply("initialDirectoryReply", None):
                raise RuntimeError("応答付きメッセージを登録できません。")
            manager.connect("script-message-with-reply-received::initialDirectoryReply", self.on_initial_directory_reply)
        view_settings = load_view_settings(settings_path())
        self.bookmark_path = settings_path().parent / "bookmarks.json"
        self.bookmark_error = None
        try:
            self.bookmarks = bookmarks.load(self.bookmark_path)
        except (OSError, ValueError, UnicodeError) as error:
            self.bookmarks = []
            self.bookmark_error = f"ブックマークを読み込めません: {error}"
        self.initial_pane_ids = {str(index) for index in range(1, view_settings["startupPaneCount"] + 1)}
        manager.add_script(WebKit2.UserScript.new(
            "window.dpaneInitialViewSettings = " + json.dumps(view_settings) + ";"
            + "window.dpaneInitialBookmarks = " + json.dumps({"paths": self.bookmarks, "error": self.bookmark_error}, ensure_ascii=True) + ";"
            + ("window.dpaneStartupTiming = true;" if STARTUP_TIMING.enabled else "")
            + ("window.dpaneStartupSummary = true;" if STARTUP_TIMING.enabled and STARTUP_TIMING.summary else "")
            + ("window.dpaneStartupReply = true;" if self.startup_reply else ""),
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START, None, None,
        ))
        manager.register_script_message_handler("directoryListing")
        manager.connect("script-message-received::directoryListing", self.on_directory_request)
        manager.register_script_message_handler("fileOpen")
        manager.connect("script-message-received::fileOpen", self.on_file_open_request)
        manager.register_script_message_handler("fileExecute")
        manager.connect("script-message-received::fileExecute", self.on_file_execute_request)
        manager.register_script_message_handler("closeWindow")
        manager.connect("script-message-received::closeWindow", self.on_close_request)
        manager.register_script_message_handler("fileOperation")
        manager.connect("script-message-received::fileOperation", self.on_file_operation_request)
        manager.register_script_message_handler("pathCompletion")
        manager.connect("script-message-received::pathCompletion", self.on_path_completion_request)
        manager.register_script_message_handler("uiScale")
        manager.connect("script-message-received::uiScale", self.on_ui_scale_request)
        manager.register_script_message_handler("saveViewSettings")
        manager.connect("script-message-received::saveViewSettings", self.on_save_view_settings)
        manager.register_script_message_handler("bookmarks")
        manager.connect("script-message-received::bookmarks", self.on_bookmarks_request)
        if STARTUP_TIMING.enabled:
            manager.register_script_message_handler("startupPaint")
            manager.connect("script-message-received::startupPaint", self.on_startup_paint)
            manager.register_script_message_handler("startupDetail")
            manager.connect("script-message-received::startupDetail", self.on_startup_detail)

        self.web_view = WebKit2.WebView.new_with_user_content_manager(manager)
        STARTUP_TIMING.mark("T3", "WebView生成完了")
        background = Gdk.RGBA()
        background.parse("#171a20")
        self.web_view.set_background_color(background)
        self.web_view.set_zoom_level(view_settings["scale"] / 100)
        settings = self.web_view.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_write_console_messages_to_stdout(True)
        self.web_view.connect("decide-policy", self.on_decide_policy)
        if STARTUP_TIMING.enabled:
            self.web_view.connect("load-changed", self.on_startup_load_changed)
        self.add(self.web_view)
        self.web_view.load_uri(self.ui_file.as_uri())

    def on_decide_policy(self, _view, decision, decision_type) -> bool:
        """Keep the embedded UI local; it must not navigate to remote pages."""
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        request_uri = decision.get_request().get_uri()
        if request_uri == self.ui_file.as_uri():
            return False
        decision.ignore()
        return True

    def on_directory_request(self, _manager, result, reply=None) -> None:
        initial = False
        try:
            value = result if reply is not None else result.get_js_value()
            request = json.loads(value.to_json(0))
            pane_id = request.get("paneId")
            initial_ids = initial_pane_ids(self)
            initial = STARTUP_TIMING.enabled and pane_id in initial_ids and pane_id not in self.initial_listing_ids
            started = perf_counter() if initial else None
            if initial:
                STARTUP_TIMING.detail(f"一覧 ペイン{pane_id} 取得開始", started)
            response = {"paneId": pane_id, **list_directory(request.get("path"))}
            if type(request.get("requestId")) is int:
                response["requestId"] = request["requestId"]
            if initial:
                finished = perf_counter()
                count = len(response.get("entries", []))
                status = "エラー" if "error" in response else f"{count}件"
                STARTUP_TIMING.detail(f"一覧 ペイン{pane_id} 取得終了 {status} 所要{(finished - started) * 1000:.1f} ms", finished)
            if STARTUP_TIMING.enabled and pane_id in initial_ids:
                self.initial_listing_ids.add(pane_id)
                if self.initial_listing_ids == initial_ids:
                    STARTUP_TIMING.mark("T5", f"初期{len(initial_ids)}ペインの一覧取得終了（エラー含む）")
        except (TypeError, ValueError, AttributeError) as error:
            if reply is not None:
                reply.return_error_message(f"要求を解釈できません: {error}")
                return
            response = {"error": f"要求を解釈できません: {error}"}

        if reply is not None:
            reply.return_value(JavaScriptCore.Value.new_from_json(value.get_context(), json.dumps(response, ensure_ascii=False)))
            return
        if initial and getattr(self, "startup_batch", False) is True:
            self.startup_responses.append(response)
            self.flush_initial_listings()
            return
        self.send_to_ui("receiveDirectory", response)

    def on_initial_directory_reply(self, manager, value, reply) -> bool:
        self.on_directory_request(manager, value, reply)
        return True

    def flush_initial_listings(self) -> None:
        initial_pane_count = len(initial_pane_ids(self))
        if not self.startup_page_loaded or len(self.startup_responses) != initial_pane_count:
            return
        responses, self.startup_responses = self.startup_responses, []
        STARTUP_TIMING.detail(f"初期{initial_pane_count}ペインの一覧を一括送信")
        self.send_to_ui("receiveDirectories", responses)

    def on_startup_load_changed(self, _view, event) -> None:
        labels = {
            WebKit2.LoadEvent.STARTED: "WebKit 読み込み開始",
            WebKit2.LoadEvent.REDIRECTED: "WebKit リダイレクト",
            WebKit2.LoadEvent.COMMITTED: "WebKit 読み込み確定（表示内容を受信）",
            WebKit2.LoadEvent.FINISHED: "WebKit 読み込み終了",
        }
        if event in labels:
            STARTUP_TIMING.detail(labels[event])
        if event == WebKit2.LoadEvent.FINISHED:
            STARTUP_TIMING.mark("T4", "HTML読み込み完了")
            if self.startup_batch:
                self.startup_page_loaded = True
                self.flush_initial_listings()

    def on_startup_paint(self, _manager, _result) -> None:
        STARTUP_TIMING.mark("T6", "初期一覧反映後の2描画フレーム（描画完了の近似）")

    def on_startup_detail(self, _manager, result) -> None:
        try:
            data = json.loads(result.get_js_value().to_json(0))
            event = data.get("event")
            elapsed = data.get("elapsed")
            if event not in ("js-start", "initial-layout", "list-render", "list-receive", "dom-content-loaded", "window-load", "dom-already", "load-already", "performance-unavailable", "navigation-unavailable", "resource-summary", "resource", "navigation") or type(elapsed) not in (int, float):
                return
            if not 0 <= elapsed <= 3600000:
                return
            if STARTUP_TIMING.summary:
                if event in ("dom-content-loaded", "window-load", "dom-already", "load-already"):
                    label = {"dom-content-loaded": "DOMContentLoaded", "window-load": "window.onload",
                             "dom-already": "DOMContentLoaded（すでに発生）", "load-already": "window.onload（すでに発生）"}[event]
                    received = (perf_counter() - STARTUP_TIMING.start) * 1000
                    print(f"起動計測 {label}: JS開始から {elapsed:.1f} ms（Python受信 T0+{received:.1f} ms）", file=sys.stderr, flush=True)
                return
            def time_value(value):
                if value is None:
                    return "取得不可"
                if type(value) not in (int, float) or not -3600000 <= value <= 3600000:
                    raise ValueError("計測値が不正です")
                return f"{value:+.1f}ms"
            if event == "js-start":
                description = "JS 実行開始"
            elif event == "initial-layout":
                description = f"JS 初期ペイン・レイアウト構築完了 所要{elapsed:.1f} ms"
            elif event in ("dom-content-loaded", "window-load", "dom-already", "load-already"):
                description = {
                    "dom-content-loaded": "JS DOMContentLoaded発生",
                    "window-load": "JS window.onload発生",
                    "dom-already": "JS 開始時点でDOMContentLoaded後（発生時刻不明）",
                    "load-already": "JS 開始時点でwindow.onload後（発生時刻不明）",
                }[event]
            elif event == "list-receive":
                pane_id, ready = data.get("paneId"), data.get("readyState")
                if pane_id not in initial_pane_ids(self) or ready not in ("loading", "interactive", "complete"):
                    return
                description = f"JS ペイン{pane_id} 一覧受信開始 readyState={ready}"
            elif event in ("performance-unavailable", "navigation-unavailable"):
                description = "JS " + ("Performance APIが利用不可" if event == "performance-unavailable" else "ナビゲーション時刻が取得不可")
            elif event == "resource-summary":
                count = data.get("count")
                if type(count) is not int or not 0 <= count <= 100000:
                    return
                description = f"JS リソース計測 {count}件（最大30件表示）"
            elif event == "resource":
                kind, duration = data.get("kind"), data.get("duration")
                if kind not in ("style.css", "app.js", "other") or type(duration) not in (int, float) or not 0 <= duration <= 3600000:
                    return
                description = (f"JS リソース {kind} 開始={time_value(data.get('start'))} "
                               f"応答終了={time_value(data.get('end'))} 所要={duration:.1f}ms（時刻はJS開始基準）")
            elif event == "navigation":
                description = (f"JS ナビゲーション DOM開始={time_value(data.get('domStart'))} "
                               f"DOM終了={time_value(data.get('domEnd'))} load開始={time_value(data.get('loadStart'))} "
                               f"load終了={time_value(data.get('loadEnd'))}（時刻はJS開始基準）")
            else:
                pane_id, count, duration = data.get("paneId"), data.get("count"), data.get("duration")
                if pane_id not in initial_pane_ids(self) or type(count) is not int or not 0 <= count <= MAX_ENTRIES:
                    return
                if type(duration) not in (int, float) or not 0 <= duration <= 3600000:
                    return
                description = f"JS ペイン{pane_id} 一覧反映 {count}件 所要{duration:.1f} ms"
            STARTUP_TIMING.detail(f"{description}（JS開始から{elapsed:.1f} ms、Python受信時刻）")
        except (TypeError, ValueError, AttributeError):
            return

    def on_ui_scale_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            percent = request.get("percent")
            if type(percent) is int and 70 <= percent <= 150 and percent % 10 == 0:
                self.web_view.set_zoom_level(percent / 100)
        except (TypeError, ValueError, AttributeError):
            return

    def on_save_view_settings(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            save_view_settings(settings_path(), validate_view_settings(request))
        except (OSError, TypeError, ValueError, AttributeError) as error:
            print(f"表示設定を保存できません: {error}", file=sys.stderr)

    def on_bookmarks_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            action = request.get("action")
            if action == "open":
                response = {"action": action, "paneId": request.get("paneId"), "newPane": request.get("newPane") is True,
                            **list_directory(request.get("path"))}
                if type(request.get("requestId")) is int:
                    response["requestId"] = request["requestId"]
            elif action in ("add", "remove"):
                if self.bookmark_error:
                    raise ValueError(self.bookmark_error)
                value = request.get("path")
                if action == "add":
                    value = bookmarks.normalize(value)
                    updated = self.bookmarks if value in self.bookmarks else [*self.bookmarks, value]
                else:
                    if not isinstance(value, str) or value not in self.bookmarks:
                        raise ValueError("ブックマークが見つかりません。")
                    updated = [item for item in self.bookmarks if item != value]
                bookmarks.save(self.bookmark_path, updated)
                self.bookmarks = updated
                response = {"action": action, "paths": updated}
            else:
                return
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError) as error:
            response = {"error": f"ブックマーク操作に失敗しました: {error}"}
        self.send_to_ui("receiveBookmarks", response)

    def on_path_completion_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            pane_id = request.get("paneId")
            request_id = request.get("requestId")
            value = request.get("path")
            if not isinstance(pane_id, str) or not isinstance(request_id, int):
                return
            future = self.completion_executor.submit(path_completion.complete_path, value)
            def finish(completed):
                response = {"paneId": pane_id, "requestId": request_id, **completed.result()}
                GLib.idle_add(self.send_to_ui, "receivePathCompletion", response)
            future.add_done_callback(finish)
        except (TypeError, ValueError, AttributeError, RuntimeError):
            return

    def on_file_open_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            pane_id = request.get("paneId")
            if request.get("setDefault") is True:
                response = {"paneId": pane_id, **self.open_file(request.get("path"), True, set_default=True)}
            else:
                response = {"paneId": pane_id, **self.open_file(request.get("path"), request.get("choose") is True)}
        except (TypeError, ValueError, AttributeError) as error:
            response = {"error": f"要求を解釈できません: {error}"}
        self.send_to_ui("receiveOpenResult", response)

    def open_file(self, requested_path: object, choose: bool, set_default: bool = False) -> dict[str, object]:
        path, error = resolve_file(requested_path)
        if error:
            return {"error": error}
        if not choose and is_executable_binary(path):
            return self.execute_file(str(path), auto=True)
        file = Gio.File.new_for_path(str(path))
        try:
            info = file.query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, None)
            content_type = info.get_content_type()
            if set_default:
                if not content_type:
                    return {"error": "ファイルの種類を判定できません。"}
                return self.choose_app(file, path, content_type, set_default=True)
            default = Gio.AppInfo.get_default_for_type(content_type, False) if content_type else None
            if choose or default is None:
                return self.choose_app(file, path, content_type)
            if not Gio.AppInfo.launch_default_for_uri(file.get_uri(), None):
                return {"error": "既定アプリでファイルを開けません。"}
            return {"path": str(path), "message": "既定アプリに開くよう依頼しました"}
        except Exception as error:
            return {"error": f"ファイルを開けません: {error}"}

    def choose_app(self, file: Gio.File, path: Path, content_type: str | None, set_default: bool = False) -> dict[str, object]:
        # Gtk.AppChooserDialog records a last-used association when accepted.
        # Use the widget directly; update the association only when explicitly requested.
        dialog = Gtk.Dialog(title="既定のアプリを変更" if set_default else "アプリを選択", transient_for=self, modal=True)
        dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "既定に設定" if set_default else "開く", Gtk.ResponseType.OK)
        dialog.set_default_size(480, 400)
        area = dialog.get_content_area()
        label = Gtk.Label(label=(f"{content_type} の既定アプリを変更します。\n他のアプリにも反映されます。" if set_default
                                 else f"「{path.name}」を開くアプリを選択してください。"))
        area.pack_start(label, False, False, 8)
        chooser = Gtk.AppChooserWidget.new(content_type or "application/octet-stream")
        chooser.set_show_other(True)
        chooser.set_default_text("対応するアプリが見つかりません。")
        chooser.connect("application-activated", lambda *_args: dialog.response(Gtk.ResponseType.OK))
        area.pack_start(chooser, True, True, 0)
        dialog.show_all()
        try:
            response = dialog.run()
            app = chooser.get_app_info() if response == Gtk.ResponseType.OK else None
        finally:
            dialog.destroy()
        if response != Gtk.ResponseType.OK:
            return {"cancelled": True}
        if app is None:
            return {"error": "対応するアプリが見つかりません。"}
        # Check again after the modal dialog, since the file may have changed.
        checked, error = resolve_file(str(path))
        if error:
            return {"error": error}
        if set_default:
            current = Gio.File.new_for_path(str(checked)).query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, None).get_content_type()
            if current != content_type:
                return {"error": "ファイルの種類が変更されたため設定を中止しました。"}
            if not app.set_as_default_for_type(content_type):
                return {"error": "既定のアプリを設定できません。"}
            return {"path": str(checked), "message": f"{content_type} の既定アプリを変更しました"}
        if not app.launch([Gio.File.new_for_path(str(checked))], None):
            return {"error": "選択したアプリでファイルを開けません。"}
        return {"path": str(checked), "message": "選択したアプリに開くよう依頼しました"}

    def on_file_execute_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            pane_id = request.get("paneId")
            response = {"paneId": pane_id, **self.execute_file(request.get("path"))}
        except (TypeError, ValueError, AttributeError) as error:
            response = {"error": f"要求を解釈できません: {error}"}
        self.send_to_ui("receiveOpenResult", response)

    def execute_file(self, requested_path: object, auto: bool = False) -> dict[str, object]:
        path, error = resolve_file(requested_path)
        if error:
            return {"error": error}
        error = executable_error(path)
        if error:
            return {"error": error}
        if auto and not is_executable_binary(path):
            return {"error": "ファイルの種類が変更されました。もう一度操作してください。"}
        try:
            before = path.stat()
        except OSError:
            return {"error": "指定したファイルを確認できません。"}
        dialog = Gtk.MessageDialog(
            transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION,
            buttons=Gtk.ButtonsType.NONE, text="このファイルを実行しますか？",
        )
        dialog.format_secondary_text(str(path))
        dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "実行", Gtk.ResponseType.OK)
        dialog.set_default_response(Gtk.ResponseType.CANCEL)
        try:
            response = dialog.run()
        finally:
            dialog.destroy()
        if response != Gtk.ResponseType.OK:
            return {"cancelled": True}
        checked, error = resolve_file(str(path))
        if error:
            return {"error": error}
        error = executable_error(checked)
        if error:
            return {"error": error}
        if auto and not is_executable_binary(checked):
            return {"error": "確認後にファイルの種類が変更されました。もう一度操作してください。"}
        try:
            after = checked.stat()
            before_identity = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            if checked != path or before_identity != after_identity:
                return {"error": "確認後にファイルが変更されました。もう一度操作してください。"}
            subprocess.Popen([str(checked)], cwd=str(checked.parent), stdin=subprocess.DEVNULL,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        except (OSError, ValueError) as error:
            return {"error": f"実行できません: {error}"}
        return {"path": str(checked), "message": "実行を開始しました"}

    def on_close_request(self, _manager, _result) -> None:
        self.close()

    def on_window_delete(self, _window, _event) -> bool:
        if self.file_operation_busy:
            dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.INFO,
                                       buttons=Gtk.ButtonsType.OK, text="ファイル操作が完了するまでお待ちください。")
            dialog.run()
            dialog.destroy()
            return True
        return False

    def on_file_operation_request(self, _manager, result) -> None:
        pane_id = None
        try:
            request = json.loads(result.get_js_value().to_json(0))
            pane_id = request.get("paneId")
            action = request.get("action")
            if self.file_operation_busy:
                raise ValueError("別のファイル操作が進行中です。")
            if action in ("copy", "cut"):
                entries = selected_entries(request.get("paths"))
                self.file_clipboard = (entries, action == "cut")
                message = f"{'切り取りを予約しました' if action == 'cut' else 'コピーを準備しました'}: {len(entries)} 件"
                self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": message})
                return
            if action in ("new_folder", "new_file"):
                destination = request.get("path")
                is_folder = action == "new_folder"
                title = "新しいフォルダ" if is_folder else "新しいファイル"
                dialog = Gtk.Dialog(title=title, transient_for=self, modal=True)
                dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "作成", Gtk.ResponseType.OK)
                dialog.set_default_response(Gtk.ResponseType.OK)
                entry = Gtk.Entry()
                entry.set_activates_default(True)
                entry.set_placeholder_text("名前を入力")
                dialog.get_content_area().pack_start(entry, True, True, 12)
                dialog.show_all()
                entry.grab_focus()
                try:
                    confirmed = dialog.run() == Gtk.ResponseType.OK
                    name = entry.get_text()
                finally:
                    dialog.destroy()
                if not confirmed:
                    self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": "操作をキャンセルしました。"})
                    return
                job = lambda: file_operations.create_entry(destination, name, is_folder)
                message = f"{title}を作成しました: {name}"
            elif action == "rename":
                [(path, expected)] = selected_entries(request.get("paths"))
                dialog = Gtk.Dialog(title="名前を変更", transient_for=self, modal=True)
                dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "変更", Gtk.ResponseType.OK)
                dialog.set_default_response(Gtk.ResponseType.OK)
                entry = Gtk.Entry()
                entry.set_text(path.name)
                entry.set_activates_default(True)
                dialog.get_content_area().pack_start(entry, True, True, 12)
                dialog.show_all()
                entry.grab_focus()
                entry.select_region(0, -1)
                try:
                    confirmed = dialog.run() == Gtk.ResponseType.OK
                    name = entry.get_text()
                finally:
                    dialog.destroy()
                if not confirmed:
                    self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": "操作をキャンセルしました。"})
                    return
                job = lambda: file_operations.rename_entry(path, name, expected)
                renamed_source, renamed_identity = path, expected
                message = f"名前を変更しました: {name}" if name != path.name else "名前は変更されませんでした。"
            elif action == "trash":
                entries = selected_entries(request.get("paths"))
                dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION,
                                           buttons=Gtk.ButtonsType.NONE, text=f"{len(entries)} 件をゴミ箱へ移動しますか？")
                preview = "\n".join(str(path) for path, _expected in entries[:10])
                if len(entries) > 10:
                    preview += f"\n…ほか {len(entries) - 10} 件"
                dialog.format_secondary_text(preview)
                dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "ゴミ箱へ移動", Gtk.ResponseType.OK)
                dialog.set_default_response(Gtk.ResponseType.CANCEL)
                try:
                    confirmed = dialog.run() == Gtk.ResponseType.OK
                finally:
                    dialog.destroy()
                if not confirmed:
                    self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": "操作をキャンセルしました。"})
                    return
                def job():
                    completed, failures = [], []
                    for path, expected in entries:
                        try:
                            file_operations.trash(path, expected)
                            completed.append(path)
                        except Exception as error:
                            failures.append((path, error))
                    return completed, failures
                message = f"ゴミ箱へ移動しました: {len(entries)} 件"
            elif action == "paste":
                if self.file_clipboard is None:
                    raise ValueError("コピーまたは切り取りの対象がありません。")
                entries, cut = self.file_clipboard
                destination = request.get("path")
                plans = []
                for path, expected in entries:
                    if file_operations.identity(path) != expected:
                        raise ValueError("コピー元が変更されました。もう一度選択してください。")
                    target = file_operations.paste_target(path, destination)
                    if cut and path == target:
                        raise ValueError("同じフォルダには移動できません。")
                    mode, target_snapshot, source_snapshot = "reject", None, None
                    if os.path.lexists(target):
                        overwrite_allowed = file_operations.can_overwrite(path, target)
                        target_snapshot = file_operations.file_snapshot(target)
                        source_snapshot = file_operations.file_snapshot(path)
                        dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION,
                                                   buttons=Gtk.ButtonsType.NONE, text="同じ名前の項目があります。")
                        detail = f"{target}\n連番を付けるか、操作をキャンセルできます。"
                        if overwrite_allowed:
                            detail += "\n上書きすると既存ファイルが置き換わります（元に戻せません）。"
                        dialog.format_secondary_text(detail)
                        dialog.add_button("キャンセル", Gtk.ResponseType.CANCEL)
                        dialog.add_button("連番を付ける", Gtk.ResponseType.ACCEPT)
                        if overwrite_allowed:
                            dialog.add_button("上書き", Gtk.ResponseType.YES)
                        dialog.set_default_response(Gtk.ResponseType.CANCEL)
                        try:
                            choice = dialog.run()
                        finally:
                            dialog.destroy()
                        if choice == Gtk.ResponseType.ACCEPT:
                            mode = "numbered"
                        elif choice == Gtk.ResponseType.YES and overwrite_allowed:
                            mode = "overwrite"
                        else:
                            self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": "操作をキャンセルしました。"})
                            return
                    plans.append((path, expected, mode, target_snapshot, source_snapshot))
                def job():
                    completed, failures = [], []
                    for path, expected, mode, target_snapshot, source_snapshot in plans:
                        try:
                            completed.append(file_operations.transfer(path, destination, cut, expected, mode, target_snapshot, source_snapshot))
                        except Exception as error:
                            failures.append((path, error))
                    return completed, failures
                message = f"{'移動' if cut else 'コピー'}しました: {len(plans)} 件"
            else:
                raise ValueError("不明なファイル操作です。")
            self.file_operation_busy = True
            def run_job():
                try:
                    result = job()
                    response = {"paneId": pane_id, "message": message, "refresh": True}
                    if action == "paste":
                        completed, failures = result
                        response["message"] = f"{'移動' if cut else 'コピー'}しました: {len(completed)} 件"
                        if failures:
                            names = ", ".join(path.name for path, _error in failures[:3])
                            response["error"] = f"{len(completed)} 件成功、{len(failures)} 件の操作に失敗しました: {names}"
                        if cut:
                            remaining = [(path, expected) for path, expected, _mode, _target, _source in plans
                                         if all(path != done for done in completed)]
                            self.file_clipboard = (remaining, True) if remaining else None
                    if action == "trash":
                        completed, failures = result
                        response["message"] = f"ゴミ箱へ移動しました: {len(completed)} 件"
                        if failures:
                            names = ", ".join(path.name for path, _error in failures[:3])
                            response["error"] = f"{len(completed)} 件成功、{len(failures)} 件の操作に失敗しました: {names}"
                    if action == "rename":
                        response.update({"selectedNames": [result.name], "selectedDirectory": str(result.parent)})
                        if self.file_clipboard is not None:
                            entries, is_cut = self.file_clipboard
                            self.file_clipboard = ([(result if old_path == renamed_source and old_identity == renamed_identity else old_path,
                                                     old_identity) for old_path, old_identity in entries], is_cut)
                except Exception as error:
                    response = {"paneId": pane_id, "error": f"ファイル操作に失敗しました: {error}", "refresh": True}
                GLib.idle_add(self.finish_file_operation, response)
            threading.Thread(target=run_job, daemon=True).start()
        except Exception as error:
            self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "error": str(error)})

    def finish_file_operation(self, response: dict[str, object]) -> bool:
        self.file_operation_busy = False
        self.send_to_ui("receiveFileOperation", response)
        return False

    def send_to_ui(self, callback: str, response: object) -> None:
        payload = json.dumps(response, ensure_ascii=False).replace("</", "<\\/")
        trace = None
        if STARTUP_TIMING.enabled and not STARTUP_TIMING.summary and callback == "receiveDirectory" and isinstance(response, dict):
            pane_id = response.get("paneId")
            if pane_id in initial_pane_ids(self) and pane_id not in self.startup_script_traced:
                self.startup_script_traced.add(pane_id)
                trace = f"ペイン{pane_id}"
        elif STARTUP_TIMING.enabled and not STARTUP_TIMING.summary and callback == "receiveDirectories" and "batch" not in self.startup_script_traced:
            self.startup_script_traced.add("batch")
            trace = "初期一覧一括"
        if trace:
            submitted = perf_counter()
            STARTUP_TIMING.detail(f"Python→JS {trace} run_javascript要求", submitted)
            def finished(view, result, _data):
                try:
                    view.run_javascript_finish(result)
                    status = "完了"
                except GLib.Error:
                    status = "エラー"
                completed = perf_counter()
                STARTUP_TIMING.detail(f"Python→JS {trace} run_javascript {status} 要求から{(completed - submitted) * 1000:.1f} ms", completed)
            self.web_view.run_javascript(f"window.dirGroup.{callback}({payload});", None, finished, None)
            return
        self.web_view.run_javascript(
            f"window.dirGroup.{callback}({payload});", None, None, None
        )


class DirGroupApplication(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="local.dirgroup.webui")

    def do_startup(self) -> None:
        Gtk.Application.do_startup(self)
        STARTUP_TIMING.mark("T2", "GTKアプリケーションstartup完了")

    def do_activate(self) -> None:
        window = self.props.active_window
        if window is None:
            window = DirGroupWindow(self)
        window.show_all()
        window.present()


def main() -> int:
    global _inline_ui_file
    if STARTUP_TIMING.enabled and STARTUP_TIMING.summary and os.environ.get("DPANE_STARTUP_INLINE") == "1":
        with tempfile.TemporaryDirectory(prefix="dpane-inline-") as directory:
            _inline_ui_file = create_inline_ui(Path(directory))
            try:
                GLib.set_application_name("Dpaie")
                return DirGroupApplication().run(sys.argv)
            finally:
                _inline_ui_file = None
    ui_file = startup_ui_file()
    if not ui_file.is_file():
        sys.exit(f"UI file is missing: {ui_file}")
    GLib.set_application_name("Dpaie")
    return DirGroupApplication().run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
