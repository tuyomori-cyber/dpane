"""Exercise the experimental PTY with a real interactive bash and temporary files."""
import base64
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from gi.repository import GLib
import terminal_pty


@unittest.skipUnless(Path('/bin/bash').is_file(), 'bash is required for this test')
class TerminalPTYTest(unittest.TestCase):
    def test_interactive_shell_input_completion_interrupt_and_resize(self):
        output = bytearray()
        context = GLib.MainContext.default()

        def receive(message):
            if 'data' in message:
                output.extend(base64.b64decode(message['data']))

        def wait_for(expected, timeout=5):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                while context.pending():
                    context.iteration(False)
                if expected in output:
                    return
                time.sleep(.01)
            self.fail(f'{expected!r} missing from terminal output: {bytes(output[-1000:])!r}')

        sessions = terminal_pty.TerminalSessions(receive)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'HOME': directory, 'HISTFILE': '/dev/null'}), \
                patch.object(terminal_pty.pwd, 'getpwuid') as user:
            user.return_value.pw_shell = '/bin/bash'
            Path(directory, 'uniqueprefix-result').touch()
            sessions.start('1', 'token', directory, 80, 24)
            try:
                wait_for(b'$ ')
                output.clear()
                sessions.input('1', 'token', 'printf ABCX\x7fD\\n\r')
                wait_for(b'ABCD')
                output.clear()
                sessions.input('1', 'token', 'echo uniquepre\t\r')
                wait_for(b'uniqueprefix-result')
                output.clear()
                sessions.input('1', 'token', 'sleep 20\r')
                wait_for(b'sleep 20')
                time.sleep(.2)
                sessions.input('1', 'token', '\x03')
                wait_for(b'$ ')
                output.clear()
                sessions.resize('1', 'token', 60, 12)
                sessions.input('1', 'token', 'stty size\r')
                wait_for(b'12 60')
            finally:
                sessions.shutdown()
                deadline = time.monotonic() + 1
                while time.monotonic() < deadline:
                    while context.pending():
                        context.iteration(False)
                    time.sleep(.01)


if __name__ == '__main__':
    unittest.main()
