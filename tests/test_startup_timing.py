import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class StartupTimingTests(unittest.TestCase):
    def test_elapsed_time_and_duplicate_marks(self):
        output = io.StringIO()
        timing = app.StartupTiming(10.0, True)
        with patch("sys.stderr", output):
            timing.mark("T1", "import完了", 10.125)
            timing.mark("T1", "重複", 10.2)
        self.assertEqual(output.getvalue(), "起動計測 T1: 125.0 ms  import完了\n")

    def test_disabled_does_not_print(self):
        output = io.StringIO()
        with patch("sys.stderr", output):
            app.StartupTiming(10.0, False).mark("T1", "import完了", 10.125)
        self.assertEqual(output.getvalue(), "")

    def test_summary_prints_only_t6(self):
        output = io.StringIO()
        timing = app.StartupTiming(10.0, True, summary=True)
        with patch("sys.stderr", output):
            timing.mark("T1", "import完了", 10.1)
            timing.detail("詳細", 10.2)
            timing.mark("T6", "初期描画", 10.3)
        self.assertEqual(output.getvalue(), "起動計測 T6: 300.0 ms  初期描画\n")

    def test_inline_page_uses_current_css_and_javascript(self):
        with tempfile.TemporaryDirectory() as directory:
            path = app.create_inline_ui(Path(directory))
            html = path.read_text(encoding="utf-8")
            self.assertNotIn('<link rel="stylesheet" href="style.css">', html)
            self.assertNotIn('<script src="app.js"></script>', html)
            self.assertIn((app.UI_FILE.parent / "style.css").read_text(encoding="utf-8"), html)
            self.assertIn((app.UI_FILE.parent / "app.js").read_text(encoding="utf-8"), html)

    def test_minimal_page_is_opt_in_and_only_for_timing(self):
        with patch.dict("os.environ", {"DPANE_STARTUP_MINIMAL": "1"}), patch.object(app.STARTUP_TIMING, "enabled", True):
            self.assertEqual(app.startup_ui_file(), app.MINIMAL_UI_FILE)
        with patch.dict("os.environ", {"DPANE_STARTUP_MINIMAL": "1"}), patch.object(app.STARTUP_TIMING, "enabled", False):
            self.assertEqual(app.startup_ui_file(), app.UI_FILE)
        with patch.dict("os.environ", {"DPANE_STARTUP_MINIMAL": "0"}), patch.object(app.STARTUP_TIMING, "enabled", True):
            self.assertEqual(app.startup_ui_file(), app.UI_FILE)

    def test_navigation_allows_only_selected_local_page(self):
        for page in (app.UI_FILE, app.MINIMAL_UI_FILE):
            window, decision = Mock(), Mock()
            window.ui_file = page
            decision.get_request.return_value.get_uri.return_value = page.as_uri()
            self.assertFalse(app.DirGroupWindow.on_decide_policy(window, None, decision, app.WebKit2.PolicyDecisionType.NAVIGATION_ACTION))
            decision.get_request.return_value.get_uri.return_value = "https://example.com/"
            self.assertTrue(app.DirGroupWindow.on_decide_policy(window, None, decision, app.WebKit2.PolicyDecisionType.NAVIGATION_ACTION))
            decision.ignore.assert_called_once()

    def test_initial_directory_records_duration_and_entry_count_once(self):
        window, result = Mock(), Mock()
        window.initial_listing_ids = set()
        result.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": "1", "path": "/tmp"})
        output = io.StringIO()
        timing = app.StartupTiming(10.0, True)
        with patch.object(app, "STARTUP_TIMING", timing), patch.object(app, "perf_counter", side_effect=[10.1, 10.125]), patch.object(app, "list_directory", return_value={"entries": [{"name": "one"}]}), patch("sys.stderr", output):
            app.DirGroupWindow.on_directory_request(window, None, result)
        self.assertIn("ペイン1 取得開始", output.getvalue())
        self.assertIn("1件 所要25.0 ms", output.getvalue())
        self.assertEqual(window.initial_listing_ids, {"1"})
        self.assertEqual(window.send_to_ui.call_args.args[1]["entries"], [{"name": "one"}])

    def test_javascript_detail_formats_valid_events(self):
        result = Mock()
        result.get_js_value.return_value.to_json.return_value = json.dumps(
            {"event": "list-render", "elapsed": 24.5, "paneId": "2", "count": 12, "duration": 4.5}
        )
        output = io.StringIO()
        with patch.object(app, "STARTUP_TIMING", app.StartupTiming(10.0, True)), patch.object(app, "perf_counter", return_value=10.1), patch("sys.stderr", output):
            app.DirGroupWindow.on_startup_detail(None, None, result)
        self.assertIn("ペイン2 一覧反映 12件 所要4.5 ms", output.getvalue())
        self.assertIn("JS開始から24.5 ms、Python受信時刻", output.getvalue())

    def test_initial_send_traces_javascript_request_and_completion(self):
        window = Mock()
        window.startup_script_traced = set()
        output = io.StringIO()
        timing = app.StartupTiming(10.0, True)
        with patch.object(app, "STARTUP_TIMING", timing), patch.object(app, "perf_counter", side_effect=[10.1, 10.175]), patch("sys.stderr", output):
            app.DirGroupWindow.send_to_ui(window, "receiveDirectory", {"paneId": "1", "entries": []})
            args = window.web_view.run_javascript.call_args.args
            self.assertIn("window.dirGroup.receiveDirectory", args[0])
            args[2](window.web_view, Mock(), None)
        window.web_view.run_javascript_finish.assert_called_once()
        self.assertIn("ペイン1 run_javascript要求", output.getvalue())
        self.assertIn("ペイン1 run_javascript 完了 要求から75.0 ms", output.getvalue())

    def test_resource_and_navigation_report_use_js_relative_times(self):
        result = Mock()
        output = io.StringIO()
        with patch.object(app, "STARTUP_TIMING", app.StartupTiming(10.0, True)), patch.object(app, "perf_counter", return_value=10.1), patch("sys.stderr", output):
            for data in (
                {"event": "resource", "elapsed": 20, "kind": "style.css", "start": -12, "end": -5, "duration": 7},
                {"event": "navigation", "elapsed": 21, "domStart": 4, "domEnd": 5, "loadStart": 80, "loadEnd": None},
            ):
                result.get_js_value.return_value.to_json.return_value = json.dumps(data)
                app.DirGroupWindow.on_startup_detail(None, None, result)
        self.assertIn("リソース style.css 開始=-12.0ms 応答終了=-5.0ms 所要=7.0ms", output.getvalue())
        self.assertIn("load開始=+80.0ms load終了=取得不可", output.getvalue())

    def test_batch_sends_once_after_page_and_all_initial_results(self):
        for page_loaded_first in (False, True):
            with self.subTest(page_loaded_first=page_loaded_first):
                window = Mock()
                window.startup_batch = True
                window.startup_page_loaded = page_loaded_first
                window.startup_responses = []
                window.initial_listing_ids = set()
                window.flush_initial_listings.side_effect = lambda: app.DirGroupWindow.flush_initial_listings(window)
                timing = Mock(enabled=True)
                with patch.object(app, "STARTUP_TIMING", timing), patch.object(app, "list_directory", side_effect=[{"entries": []}, {"error": "missing"}, {"entries": []}]):
                    for pane_id in ("1", "2", "3"):
                        result = Mock()
                        result.get_js_value.return_value.to_json.return_value = json.dumps({"paneId": pane_id, "path": "/tmp"})
                        app.DirGroupWindow.on_directory_request(window, None, result)
                    if not page_loaded_first:
                        window.send_to_ui.assert_not_called()
                        window.startup_page_loaded = True
                        app.DirGroupWindow.flush_initial_listings(window)
                    window.send_to_ui.assert_called_once_with("receiveDirectories", [
                        {"paneId": "1", "entries": []}, {"paneId": "2", "error": "missing"}, {"paneId": "3", "entries": []}
                    ])
                    app.DirGroupWindow.flush_initial_listings(window)
                    self.assertEqual(window.send_to_ui.call_count, 1)

    def test_reply_returns_listing_without_running_javascript(self):
        context = app.JavaScriptCore.Context.new()
        request = app.JavaScriptCore.Value.new_from_json(context, json.dumps({"paneId": "1", "path": "/tmp"}))
        window, reply = Mock(), Mock()
        window.initial_listing_ids = set()
        with patch.object(app, "STARTUP_TIMING", Mock(enabled=False)), patch.object(app, "list_directory", return_value={"path": "/tmp", "entries": [{"name": "one"}]}):
            app.DirGroupWindow.on_directory_request(window, None, request, reply)
        response = json.loads(reply.return_value.call_args.args[0].to_json(0))
        self.assertEqual(response, {"paneId": "1", "path": "/tmp", "entries": [{"name": "one"}]})
        window.send_to_ui.assert_not_called()
