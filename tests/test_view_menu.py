import json
import unittest
from unittest.mock import Mock

import app


class ViewMenuTests(unittest.TestCase):
    def test_zoom_accepts_only_supported_values(self):
        window, result = Mock(), Mock()
        for percent in (70, 100, 130, 150):
            result.get_js_value.return_value.to_json.return_value = json.dumps({"percent": percent})
            app.DirGroupWindow.on_ui_scale_request(window, None, result)
        self.assertEqual([call.args[0] for call in window.web_view.set_zoom_level.call_args_list], [0.7, 1.0, 1.3, 1.5])
        for percent in (True, 0, 69, 71, 151, "100", None):
            result.get_js_value.return_value.to_json.return_value = json.dumps({"percent": percent})
            app.DirGroupWindow.on_ui_scale_request(window, None, result)
        self.assertEqual(window.web_view.set_zoom_level.call_count, 4)


if __name__ == "__main__":
    unittest.main()
