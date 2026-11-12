"""Small, local PTY bridge for the isolated xterm experiment."""
import base64
import errno
import fcntl
import os
import pwd
import signal
import struct
import subprocess
import sys
import termios
from pathlib import Path

from gi.repository import GLib


class TerminalSessions:
    def __init__(self, deliver):
        self.sessions = {}
        self.deliver = deliver

    def start(self, pane, token, path, cols, rows):
        if pane in self.sessions:
            self.close(pane)
        if not isinstance(path, str) or not os.path.isdir(path):
            raise ValueError("開始フォルダを開けません")
        self._validate_size(cols, rows)
        master, slave = os.openpty()
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
            env = os.environ.copy()
            env["TERM"] = "xterm-256color"
            proc = subprocess.Popen([sys.executable, str(Path(__file__).with_name("terminal_spawn.py")), shell],
                                    stdin=slave, stdout=slave, stderr=slave, cwd=path, env=env, close_fds=True)
        except Exception:
            os.close(master)
            raise
        finally:
            os.close(slave)
        os.set_blocking(master, False)
        session = {"fd": master, "process": proc, "token": token, "queue": bytearray(), "out_watch": 0}
        self.sessions[pane] = session
        session["in_watch"] = GLib.io_add_watch(master, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR,
                                                self._read, pane, session)
        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, proc.pid, self._child_exit, pane, session)

    @staticmethod
    def _validate_size(cols, rows):
        if type(cols) is not int or type(rows) is not int or not (2 <= cols <= 500 and 2 <= rows <= 300):
            raise ValueError("端末サイズが不正です")

    def input(self, pane, token, data):
        session = self.sessions.get(pane)
        if not session or session["token"] != token or not isinstance(data, str):
            return
        encoded = data.encode("utf-8")
        if len(session["queue"]) + len(encoded) > 1024 * 1024:
            raise ValueError("端末入力が多すぎます")
        session["queue"].extend(encoded)
        if session["queue"] and not session["out_watch"]:
            session["out_watch"] = GLib.io_add_watch(session["fd"], GLib.IO_OUT | GLib.IO_HUP | GLib.IO_ERR,
                                                       self._write, pane, session)

    def resize(self, pane, token, cols, rows):
        self._validate_size(cols, rows)
        session = self.sessions.get(pane)
        if session and session["token"] == token:
            fcntl.ioctl(session["fd"], termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _read(self, fd, condition, pane, session):
        try:
            data = os.read(fd, 32768)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                return True
            data = b""
        if data:
            self.deliver({"paneId": pane, "token": session["token"], "data": base64.b64encode(data).decode("ascii")})
            return True
        session["in_watch"] = 0
        self.close(pane, session)
        self.deliver({"paneId": pane, "token": session["token"], "exited": True})
        return False

    def _write(self, fd, condition, pane, session):
        try:
            written = os.write(fd, session["queue"])
            del session["queue"][:written]
        except OSError as error:
            if error.errno not in (errno.EAGAIN, errno.EWOULDBLOCK):
                session["out_watch"] = 0
                return False
        if session["queue"]:
            return True
        session["out_watch"] = 0
        return False

    def _child_exit(self, pid, status, pane, session):
        session["process"].returncode = os.waitstatus_to_exitcode(status)

    def close(self, pane, expected=None):
        session = self.sessions.get(pane)
        if not session or (expected is not None and session is not expected):
            return
        del self.sessions[pane]
        for watch in (session["in_watch"], session["out_watch"]):
            if watch:
                GLib.source_remove(watch)
        os.close(session["fd"])
        # Closing the PTY hangs up its foreground process group; also signal the shell.
        try:
            os.kill(session["process"].pid, signal.SIGHUP)
        except ProcessLookupError:
            pass

    def shutdown(self):
        for pane in list(self.sessions):
            self.close(pane)
