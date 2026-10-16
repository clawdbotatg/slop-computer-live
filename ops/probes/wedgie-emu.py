# Wedgie emulator: runs the REAL wedgie-safe app (safe.py, safe-17+) on CPython, with a
# software P-256 key in place of the secure chip and an automatic press.
# stdin/stdout: one JSON line each way, same as the device's USB serial.
# Run: python3 ops/probes/wedgie-emu.py <checkout of clawdbotatg/wedgie-safe> [yes|no]
#   yes (default) = the person presses green on every page, no = red.
#   WEDGIE_EMU_KEY=<hex scalar> keeps the same key across runs (else a new one each start).
# Driven by ops/probes/wedgie-safe-fork.mjs (slop's utils/wedgie.ts → this → a Base fork).
import sys, types, json, os
sys.path.insert(0, sys.argv[1])  # dir holding safe.py + safe_keccak.py + safe_read.py
press = (sys.argv[2] if len(sys.argv) > 2 else "yes") == "yes"
store = {}
sav = types.ModuleType("save")
sav.load = lambda k, d=None: store.get(k, d)
sav.store = lambda k, v: store.__setitem__(k, v)
sav.delete = lambda k: store.pop(k, None)
sys.modules["save"] = sav
sys.modules["lcd"] = types.ModuleType("lcd")
ui = types.ModuleType("ui")
for c in ("WHITE", "INK", "MUTED", "GREEN_D", "RED"):
    setattr(ui, c, 0)
ui.progress = lambda *a, **k: None
ui.COLS_BIG = ui.COLS_SMALL = 25
sys.modules["ui"] = ui
out = []
W = types.ModuleType("wedgie")
W.send = lambda m: out.append(m)
W.hello = lambda mid, **kw: {"id": mid, "type": "hello", **kw}
W.failed = lambda mid, e: out.append({"id": mid, "type": "error", "error": repr(e)})
sys.modules["wedgie"] = W
sys.print_exception = lambda e: print(repr(e), file=sys.stderr)
import safe
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives import hashes
seed = os.environ.get("WEDGIE_EMU_KEY")
priv = ec.derive_private_key(int(seed, 16), ec.SECP256R1()) if seed else ec.generate_private_key(ec.SECP256R1())
n = priv.public_key().public_numbers()
safe.key = {"x": "0x%064x" % n.x, "y": "0x%064x" % n.y, "chip": "ATECC608"}
safe.state = "ok"
safe.find_signer()  # the address the wedgie shows on its home screen
def chip_sign(digest):
    r, s = utils.decode_dss_signature(priv.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256()))))
    return r, (safe.N - s if s > safe.N // 2 else s)
safe.sign = chip_sign
def confirm(tx):
    # read the tx the way the screen does (safe_read decodes every page), then press
    import safe_read
    acts = safe_read.batch(tx)
    pages = [safe_read.describe(tx)] if acts is None else safe_read.fold(acts)
    print("pages: " + json.dumps([[h, [l[0] for l in ls]] for h, ls in pages]), file=sys.stderr, flush=True)
    del sys.modules["safe_read"]
    return press
safe.confirm = confirm
print(json.dumps(W.hello(None, type="ready", running="safe", app=safe.FW, safe=safe.key, signer=safe.signer,
                         safe_state=safe.state, safe_chunk=safe.CHUNK)), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    try:
        safe.handle(json.loads(line))
    except Exception as e:
        out.append({"type": "error", "error": repr(e)})
    while out:
        print(json.dumps(out.pop(0)), flush=True)
