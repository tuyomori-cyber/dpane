import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import app


class AppIconTests(unittest.TestCase):
    def test_supplied_image_is_loaded_at_window_icon_sizes(self):
        window = Mock()
        app.apply_window_icon(window)
        icons = window.set_icon_list.call_args.args[0]
        self.assertEqual(len(icons), 5)
        self.assertEqual([icon.get_width() for icon in icons], [16, 32, 48, 64, 128])
        self.assertTrue(all(icon.get_height() < icon.get_width() for icon in icons))
        # At the largest size the original was 128×85; reduced margins yield about 130%.
        self.assertAlmostEqual(icons[-1].get_height() / 85, 1.3, delta=0.02)

    def test_missing_icon_keeps_application_startable(self):
        window = Mock()
        with patch.object(app, "ICON_FILE", Path("/nonexistent/dir-group-icon.png")), patch("sys.stderr"):
            app.apply_window_icon(window)
        window.set_icon_list.assert_not_called()


if __name__ == "__main__":
    unittest.main()
