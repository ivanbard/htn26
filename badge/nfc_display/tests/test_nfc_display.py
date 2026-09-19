import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / "nfc_display"
MANIFEST = APP / "manifest.cfg"
MAIN = APP / "main.lua"
README = APP / "README.md"


class NFCDisplayStaticTests(unittest.TestCase):
    def test_app_bundle_and_manifest(self):
        self.assertTrue(MANIFEST.is_file())
        self.assertTrue(MAIN.is_file())
        self.assertTrue(README.is_file())
        values = {}
        for line in MANIFEST.read_text().splitlines():
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                values[key] = value
        self.assertEqual(values["slug"], APP.name)
        self.assertEqual(values["api"], "2")
        self.assertEqual(values["heap_kb"], "48")

    def test_lua_syntax(self):
        result = subprocess.run(
            ["luac", "-p", str(MAIN)], capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_documented_nfc_lifecycle_is_present(self):
        source = MAIN.read_text()
        for call in (
            "badge.nfc.enable()",
            "badge.nfc.card()",
            "badge.nfc.read_text()",
            "badge.nfc.clear()",
            "badge.nfc.disable()",
        ):
            self.assertIn(call, source)
        for callback in ("function on_enter", "function on_tick", "function on_button", "function on_exit"):
            self.assertIn(callback, source)
        self.assertIn("NO TAG", source)
        self.assertIn("READ FAILED", source)
        self.assertIn("NDEF TEXT:", source)

    def test_host_smoke_flow(self):
        result = subprocess.run(
            ["lua", str(APP / "tests" / "runtime_test.lua")],
            cwd=Path(__file__).resolve().parents[3],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PASS: NFC display host smoke flow", result.stdout)


if __name__ == "__main__":
    unittest.main()
