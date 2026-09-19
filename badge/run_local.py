"""Execute the real Lua apps and local transport checks (no badge required)."""
from pathlib import Path
import os
import sys

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".tools" / "python"))
try:
    from lupa.lua54 import LuaRuntime
except ImportError:
    raise SystemExit("Install the test runtime: python -m pip install --target .tools/python lupa==2.8")

if __name__ == "__main__":
    os.chdir(ROOT)
    lua = LuaRuntime(unpack_returned_tuples=True)
    lua.execute('dofile("badge/tests/local_slice.lua")')
    lua.execute('dofile("badge/tests/gateway_slice.lua")')
