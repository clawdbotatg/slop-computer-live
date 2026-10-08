# Wedgie emulator: runs the REAL wedgie-safe firmware (safe.py) on CPython, with a
# software P-256 key in place of the Trust M chip and an automatic "A press".
# stdin/stdout: one JSON line each way, same as the device's USB serial.
# Run: python3 ops/probes/wedgie-emu.py <checkout of clawdbotatg/wedgie-safe>
# 2026-10-07 the Bank UI was driven against it through a fake navigator.serial
# port (headless Chrome): Add wedgie → sign with wedgie + passkey → executed on a
# Base fork. Proves the firmware's WebAuthn envelope verifies in our signer proxy.
import sys, types, json
sys.path.insert(0, sys.argv[1])  # dir holding safe.py + safe_keccak.py
for name in ("lcd", "save"):
    sys.modules[name] = types.ModuleType(name)
ui = types.ModuleType("ui")
for c in ("WHITE", "INK", "MUTED", "GREEN_D", "RED"):
    setattr(ui, c, 0)
ui.progress = lambda *a, **k: None
sys.modules["ui"] = ui
out = []
W = types.ModuleType("wedgie")
W.send = lambda m: out.append(m)
W.hello = lambda mid, **kw: {"id": mid, "type": "hello", **kw}
sys.modules["wedgie"] = W
sys.modules["save"].store = lambda *a: None
import safe
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives import hashes
priv = ec.generate_private_key(ec.SECP256R1())
n = priv.public_key().public_numbers()
safe.key = {"x": "0x%064x" % n.x, "y": "0x%064x" % n.y}
def chip_sign(digest):
    der = priv.sign(digest, ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    return utils.decode_dss_signature(der)
safe.sign = chip_sign
safe.confirm = lambda tx, h: True   # the human pressed A
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("{"):
        continue
    safe.handle(json.loads(line))
    while out:
        print(json.dumps(out.pop(0)), flush=True)
