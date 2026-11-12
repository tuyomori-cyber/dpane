"""Experimental, isolated kitty snapshot mirror; not a terminal implementation."""
import os
import subprocess
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor


class KittyMirror:
    def __init__(self, deliver):
        self.deliver = deliver
        self.sessions = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kitty-mirror")
        self.closed = False

    def submit(self, pane, action, **kwargs):
        if not self.closed:
            self.executor.submit(self._run, pane, action, kwargs)

    def _command(self, session, *args, data=None):
        return subprocess.run(["kitten", "@", "--to", session["address"], *args], input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3, check=True)

    def _run(self, pane, action, params):
        try:
            session = self.sessions.get(pane)
            if action == "start":
                if session:
                    return
                path = params.get("path")
                if not isinstance(path, str) or not os.path.isdir(path):
                    raise ValueError("開始フォルダがありません")
                directory = tempfile.TemporaryDirectory(prefix="dpane-kitty-")
                address = "unix:" + os.path.join(directory.name, "socket")
                try:
                    process = subprocess.Popen(["kitty", "--config", "NONE", "--session", "none",
                        "--start-as", "minimized", "-o", "allow_remote_control=socket-only",
                        "--listen-on", address, "--directory", path],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception:
                    directory.cleanup()
                    raise
                session = {"directory": directory, "address": address, "process": process}
                self.sessions[pane] = session
                for _ in range(50):
                    if process.poll() is not None:
                        raise RuntimeError("kitty の起動に失敗しました")
                    if os.path.exists(address[5:]):
                        break
                    time.sleep(.1)
                else:
                    raise RuntimeError("kitty の接続がタイムアウトしました")
                self.deliver({"paneId": pane, "started": True})
            elif action == "close":
                self._close(pane)
                return
            elif not session:
                return
            elif action == "input":
                data = params.get("data", "")
                if isinstance(data, str) and len(data) <= 4096:
                    self._command(session, "send-text", "--stdin", data=data.encode("utf-8"))
            elif action == "resize":
                cols, rows = params.get("cols"), params.get("rows")
                if type(cols) is int and type(rows) is int and 10 <= cols <= 300 and 3 <= rows <= 150:
                    self._command(session, "resize-os-window", "--unit", "cells", "--width", str(cols), "--height", str(rows))
            elif action == "poll":
                if session["process"].poll() is not None:
                    raise RuntimeError("kitty が終了しました")
                result = self._command(session, "get-text", "--extent", "screen")
                self.deliver({"paneId": pane, "text": result.stdout.decode("utf-8", "replace")})
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            self._close(pane)
            self.deliver({"paneId": pane, "error": str(error)})

    def _close(self, pane):
        session = self.sessions.pop(pane, None)
        if session:
            process = session["process"]
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            session["directory"].cleanup()

    def shutdown(self):
        self.closed = True
        def cleanup():
            for pane in list(self.sessions):
                self._close(pane)
        self.executor.submit(cleanup)
        self.executor.shutdown(wait=False)
