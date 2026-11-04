#!/usr/bin/env python3
"""Dpaie: a local multi-pane file browser."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("GdkPixbuf", "2.0")
from gi.repository import GdkPixbuf, Gio, GLib, Gtk, WebKit2  # noqa: E402

import file_operations  # noqa: E402
import path_completion  # noqa: E402


APP_DIR = Path(__file__).resolve().parent
UI_FILE = APP_DIR / "ui" / "index.html"
ICON_FILE = APP_DIR / "icon" / "4つのフォルダー入りアイコン.png"
ICON_ZOOM = 1.3
MAX_ENTRIES = 1_000


def apply_window_icon(window: Gtk.Window) -> None:
    """Reduce horizontal margins to enlarge the artwork without distortion."""
    try:
        source = GdkPixbuf.Pixbuf.new_from_file(str(ICON_FILE))
        width, height = source.get_width(), source.get_height()
        cropped_width = min(width, max(height, round(width / ICON_ZOOM)))
        artwork = source.new_subpixbuf((width - cropped_width) // 2, 0, cropped_width, height)
        icons = []
        for size in (16, 32, 48, 64, 128):
            scale = size / max(cropped_width, height)
            icons.append(artwork.scale_simple(max(1, round(cropped_width * scale)),
                                             max(1, round(height * scale)), GdkPixbuf.InterpType.BILINEAR))
        window.set_icon_list(icons)
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


class DirGroupWindow(Gtk.ApplicationWindow):
    def __init__(self, application: Gtk.Application) -> None:
        super().__init__(application=application, title="Dpaie")
        self.set_default_size(1200, 760)
        apply_window_icon(self)
        self.file_clipboard = None
        self.file_operation_busy = False
        self.completion_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="path-completion")
        self.connect("delete-event", self.on_window_delete)

        manager = WebKit2.UserContentManager()
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

        self.web_view = WebKit2.WebView.new_with_user_content_manager(manager)
        settings = self.web_view.get_settings()
        settings.set_enable_developer_extras(True)
        settings.set_enable_write_console_messages_to_stdout(True)
        self.web_view.connect("decide-policy", self.on_decide_policy)
        self.add(self.web_view)
        self.web_view.load_uri(UI_FILE.as_uri())

    def on_decide_policy(self, _view, decision, decision_type) -> bool:
        """Keep the embedded UI local; it must not navigate to remote pages."""
        if decision_type != WebKit2.PolicyDecisionType.NAVIGATION_ACTION:
            return False
        request_uri = decision.get_request().get_uri()
        if request_uri == UI_FILE.as_uri():
            return False
        decision.ignore()
        return True

    def on_directory_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            pane_id = request.get("paneId")
            response = {"paneId": pane_id, **list_directory(request.get("path"))}
        except (TypeError, ValueError, AttributeError) as error:
            response = {"error": f"要求を解釈できません: {error}"}

        self.send_to_ui("receiveDirectory", response)

    def on_ui_scale_request(self, _manager, result) -> None:
        try:
            request = json.loads(result.get_js_value().to_json(0))
            percent = request.get("percent")
            if type(percent) is int and 70 <= percent <= 150 and percent % 10 == 0:
                self.web_view.set_zoom_level(percent / 100)
        except (TypeError, ValueError, AttributeError):
            return

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
            response = {"paneId": pane_id, **self.open_file(request.get("path"), request.get("choose") is True)}
        except (TypeError, ValueError, AttributeError) as error:
            response = {"error": f"要求を解釈できません: {error}"}
        self.send_to_ui("receiveOpenResult", response)

    def open_file(self, requested_path: object, choose: bool) -> dict[str, object]:
        path, error = resolve_file(requested_path)
        if error:
            return {"error": error}
        if not choose and is_executable_binary(path):
            return self.execute_file(str(path), auto=True)
        file = Gio.File.new_for_path(str(path))
        try:
            info = file.query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, None)
            content_type = info.get_content_type()
            default = Gio.AppInfo.get_default_for_type(content_type, False) if content_type else None
            if choose or default is None:
                return self.choose_app(file, path, content_type)
            if not Gio.AppInfo.launch_default_for_uri(file.get_uri(), None):
                return {"error": "既定アプリでファイルを開けません。"}
            return {"path": str(path), "message": "既定アプリに開くよう依頼しました"}
        except Exception as error:
            return {"error": f"ファイルを開けません: {error}"}

    def choose_app(self, file: Gio.File, path: Path, content_type: str | None) -> dict[str, object]:
        # Gtk.AppChooserDialog records a last-used association when accepted.
        # Embed its standard chooser widget directly to keep associations unchanged.
        dialog = Gtk.Dialog(title="アプリを選択", transient_for=self, modal=True)
        dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "開く", Gtk.ResponseType.OK)
        dialog.set_default_size(480, 400)
        area = dialog.get_content_area()
        label = Gtk.Label(label=f"「{path.name}」を開くアプリを選択してください。")
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
                path = file_operations.entry_path(request.get("path"))
                self.file_clipboard = (path, action == "cut", file_operations.identity(path))
                message = "切り取りを予約しました" if action == "cut" else "コピーを準備しました"
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
                path = file_operations.entry_path(request.get("path"))
                expected = file_operations.identity(path)
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
                message = f"名前を変更しました: {name}" if name != path.name else "名前は変更されませんでした。"
            elif action == "trash":
                path = file_operations.entry_path(request.get("path"))
                expected = file_operations.identity(path)
                dialog = Gtk.MessageDialog(transient_for=self, modal=True, message_type=Gtk.MessageType.QUESTION,
                                           buttons=Gtk.ButtonsType.NONE, text="ゴミ箱へ移動しますか？")
                dialog.format_secondary_text(str(path))
                dialog.add_buttons("キャンセル", Gtk.ResponseType.CANCEL, "ゴミ箱へ移動", Gtk.ResponseType.OK)
                dialog.set_default_response(Gtk.ResponseType.CANCEL)
                try:
                    confirmed = dialog.run() == Gtk.ResponseType.OK
                finally:
                    dialog.destroy()
                if not confirmed:
                    self.send_to_ui("receiveFileOperation", {"paneId": pane_id, "message": "操作をキャンセルしました。"})
                    return
                job = lambda: file_operations.trash(path, expected)
                message = "ゴミ箱へ移動しました。"
            elif action == "paste":
                if self.file_clipboard is None:
                    raise ValueError("コピーまたは切り取りの対象がありません。")
                path, cut, expected = self.file_clipboard
                destination = request.get("path")
                if file_operations.identity(path) != expected:
                    raise ValueError("コピー元が変更されました。もう一度選択してください。")
                target = file_operations.paste_target(path, destination)
                if cut and path == target:
                    raise ValueError("同じフォルダには移動できません。")
                mode = "reject"
                target_snapshot = None
                source_snapshot = None
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
                job = lambda: file_operations.transfer(path, destination, cut, expected, mode, target_snapshot, source_snapshot)
                message = "移動しました。" if cut else "コピーしました。"
            else:
                raise ValueError("不明なファイル操作です。")
            self.file_operation_busy = True
            def run_job():
                try:
                    result = job()
                    response = {"paneId": pane_id, "message": message, "refresh": True}
                    if action == "paste":
                        response["message"] = f"{'移動' if cut else 'コピー'}しました: {result.name}"
                    if action == "paste" and cut:
                        self.file_clipboard = None
                    if action == "rename":
                        response.update({"selectedName": result.name, "selectedDirectory": str(result.parent)})
                        if self.file_clipboard is not None:
                            old_path, is_cut, old_identity = self.file_clipboard
                            if old_path == path and old_identity == expected:
                                self.file_clipboard = (result, is_cut, expected)
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

    def send_to_ui(self, callback: str, response: dict[str, object]) -> None:
        payload = json.dumps(response, ensure_ascii=False).replace("</", "<\\/")
        self.web_view.run_javascript(
            f"window.dirGroup.{callback}({payload});", None, None, None
        )


class DirGroupApplication(Gtk.Application):
    def __init__(self) -> None:
        super().__init__(application_id="local.dirgroup.webui")

    def do_activate(self) -> None:
        window = self.props.active_window
        if window is None:
            window = DirGroupWindow(self)
        window.show_all()
        window.present()


def main() -> int:
    if not UI_FILE.is_file():
        sys.exit(f"UI file is missing: {UI_FILE}")
    GLib.set_application_name("Dpaie")
    return DirGroupApplication().run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
