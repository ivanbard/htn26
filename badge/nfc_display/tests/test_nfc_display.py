import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT.parent / ".tools" / "python"))
from lupa.lua54 import LuaRuntime

APP = ROOT / "nfc_display"
MANIFEST = APP / "manifest.cfg"
MAIN = APP / "main.lua"
README = APP / "README.md"
RUNTIME_TEST = APP / "tests" / "runtime_test.lua"


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
        LuaRuntime().compile(MAIN.read_text(encoding="utf-8"))

    def test_host_smoke_flow(self):
        LuaRuntime().execute(RUNTIME_TEST.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
