import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import bookmarks
import app


class BookmarkTests(unittest.TestCase):
    def test_round_trip_and_missing_directory_is_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'config' / 'bookmarks.json'
            self.assertEqual(bookmarks.load(path), [])
            values = [str(Path(temp) / 'missing'), '/']
            bookmarks.save(path, values)
            self.assertEqual(bookmarks.load(path), values)
            self.assertEqual(json.loads(path.read_text())['version'], 1)

    def test_normalizes_symlinks_and_rejects_relative_or_missing(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'directory'
            directory.mkdir()
            link = Path(temp) / 'link'
            link.symlink_to(directory)
            self.assertEqual(bookmarks.normalize(str(link)), str(directory))
            with self.assertRaises(ValueError):
                bookmarks.normalize('relative')
            with self.assertRaises(OSError):
                bookmarks.normalize(str(Path(temp) / 'missing'))

    def test_corrupt_data_does_not_silently_disappear(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'bookmarks.json'
            path.write_text('{broken')
            with self.assertRaises(ValueError):
                bookmarks.load(path)
            self.assertEqual(path.read_text(), '{broken')

    def test_failed_replace_preserves_old_file_and_cleans_temporary(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'bookmarks.json'
            bookmarks.save(path, ['/old'])
            with patch('bookmarks.os.replace', side_effect=OSError('failed')):
                with self.assertRaises(OSError):
                    bookmarks.save(path, ['/new'])
            self.assertEqual(bookmarks.load(path), ['/old'])
            self.assertEqual(list(Path(temp).glob('.bookmarks-*')), [])

    def test_handler_deduplicates_alias_and_reports_failed_open(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / 'directory'
            directory.mkdir()
            link = Path(temp) / 'link'
            link.symlink_to(directory)
            window = Mock(bookmark_path=Path(temp) / 'bookmarks.json', bookmark_error=None, bookmarks=[])

            def request(value):
                result = Mock()
                result.get_js_value.return_value.to_json.return_value = json.dumps(value)
                app.DirGroupWindow.on_bookmarks_request(window, None, result)
                return window.send_to_ui.call_args.args[1]

            request({'action': 'add', 'path': str(directory)})
            response = request({'action': 'add', 'path': str(link)})
            self.assertEqual(response['paths'], [str(directory)])
            response = request({'action': 'open', 'path': str(directory / 'missing'), 'paneId': '1', 'newPane': True})
            self.assertIn('error', response)
            self.assertEqual(bookmarks.load(window.bookmark_path), [str(directory)])


if __name__ == '__main__':
    unittest.main()
