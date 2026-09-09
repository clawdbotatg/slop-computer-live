#!/usr/bin/env python3
# De-echo a show recording's audio — undo the 2026-09 "second god-mode tab"
# doubling (docs/BROADCAST-AUDIO-ROUTING.md, "Echo"). Model: y = x + sum_j
# a_j·x(t-d_j), one delay per speaker (each peer has its own jitter buffer in
# each tab), drifting slowly. Inverse is the recursion x = y - sum a_j·x(t-d_j).
#
# Per second: autocorrelation peaks in 14-60ms are candidate delays. A real
# copy is SAMPLE-EXACT stable second to second (±0.15ms) and recurs for
# minutes; voice pitch harmonics and sustained bass notes also peak in that
# range but wander, and they carry peaks at d/2 or 2d — those are rejected.
# Untreated seconds pass through untouched. Each tap's level is solved by
# bisection so the residual autocorrelation at d nulls. Sum of levels is
# capped at 0.85 (stability); any second that ends louder than 2x its input
# reverts to the original.
#
# Usage (from the prod box's recordings, run on a Mac with numpy):
#   ssh slopcomputer 'ffmpeg -i /home/ubuntu/recordings/live/<F>.mp4 -vn -c:a copy /tmp/<F>.m4a'
#   scp slopcomputer:/tmp/<F>.m4a . && ffmpeg -i <F>.m4a -ac 2 -ar 48000 <F>.wav
#   /usr/bin/python3 ops/probes/deecho.py <F>.wav <F>_clean.wav 1.0        # strength 0..1
#   /usr/bin/python3 ops/probes/deecho.py <F>.wav /dev/null 1.0 --analyze # treated% per 5min, no output
#   ffmpeg -i <F>_clean.wav -c:a aac -b:a 192k <F>_deecho.m4a
#   # mux back on prod, video copied, originals untouched:
#   ffmpeg -i <F>.mp4 -i <F>_deecho.m4a -map 0:v -map 1:a -c copy -movflags +faststart <F>_deecho.mp4
# Verify with ops/probes/echo-scan.py on 60s cuts before and after.
# Validated 2026-09-08: clean show (08-25) treated 0% throughout; echoed shows
# (09-01, 09-08) 40-80% of seconds; 09-03 had no echo (its late hit was a bass note).
import sys, wave, numpy as np
inp, outp = sys.argv[1], sys.argv[2]
STRENGTH = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
ANALYZE = "--analyze" in sys.argv
import os
R_MIN = float(os.environ.get("R_MIN", "0.2"))
VOTES = int(os.environ.get("VOTES", "1"))
D_TOL_MS = float(os.environ.get("D_TOL_MS", "0.15"))
LO_MS, HI_MS = 14, 60
MAX_TAPS = 3
SEP_MS = 1.0        # distinct peaks must be this far apart
XF_MS = 20
A_MAX = 0.9
A_SUM_MAX = 0.85

w = wave.open(inp); sr = w.getframerate(); ch = w.getnchannels(); n = w.getnframes()
raw = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, ch); w.close()
mono = raw.mean(axis=1).astype(np.float32) / 32768.0
W = sr; lo, hi = int(LO_MS*sr/1000), int(HI_MS*sr/1000); nw = n // W
M = 1 << int(np.ceil(np.log2(2*W)))

def acorr(seg):
    seg = seg - seg.mean(); F = np.fft.rfft(seg, M); ac = np.fft.irfft(F*np.conj(F), M)[:W]
    return ac / max(ac[0], 1e-9)
def inverse(seg, taps):
    """x[n] = seg[n] - sum a*x[n-d]; block size = min d so blocks only read finished output."""
    if not taps: return seg.copy()
    dmin = min(d for d, _ in taps); x = np.zeros(W+hi, dtype=np.float32)
    for s0 in range(0, W, dmin):
        e0 = min(W, s0+dmin); t = np.zeros(e0-s0, dtype=np.float32)
        for d, a in taps: t += a * x[hi+s0-d:hi+e0-d]
        x[hi+s0:hi+e0] = seg[s0:e0] - t
    return x[hi:]
PROM = float(os.environ.get("PROM", "3.0"))      # peak must beat the median |ac| over the range by this
SUBH = float(os.environ.get("SUBH", "0.6"))      # reject if ac at d/2 or d/3 is this fraction of the peak (pitch harmonic)
def peaks(ac):
    r = ac[lo:hi]; sep = int(SEP_MS*sr/1000); out = []
    floor = np.median(np.abs(r)) * PROM
    cand = np.argsort(r)[::-1]
    for k in cand:
        if r[k] < R_MIN or r[k] < floor: break
        if k > 0 and k < len(r)-1 and not (r[k] >= r[k-1] and r[k] >= r[k+1]): continue
        d = k + lo
        # a voice's pitch comb has a stronger peak at d/2 (and d/3); a real echo doesn't
        if ac[d//2-2:d//2+3].max() > SUBH*r[k] or ac[d//3-2:d//3+3].max() > SUBH*r[k]: continue
        # a sustained note (bass at 40-70Hz) also peaks at 2d, 3d; a single delayed copy does not
        if 2*d+3 < W and ac[2*d-3:2*d+4].max() > 0.5*r[k]: continue
        if all(abs(k-o) >= sep for o, _ in out): out.append((k, r[k]))
        if len(out) >= MAX_TAPS: break
    return [(k+lo, v) for k, v in out]

# pass 1: candidate taps per window
cands = [[] for _ in range(nw)]
for i in range(nw):
    seg = mono[i*W:(i+1)*W]
    if np.sqrt(np.mean(seg*seg)) < 0.005: continue
    cands[i] = peaks(acorr(seg))
# show-wide prior: a real echo lag recurs for minutes (one per speaker); a voice's
# own correlations wander. Histogram every candidate lag in 0.5ms bins and keep
# bins that hold at least GLOBAL_MIN% of all windows (neighbouring bins merged).
GLOBAL_MIN = float(os.environ.get("GLOBAL_MIN", "1.5"))
binw = max(1, int(float(os.environ.get("BIN_MS", "0.1"))/1000*sr))
counts = {}
for c in cands:
    for d, v in c: counts[d//binw] = counts.get(d//binw, 0) + 1
accepted = set()
for b, cnt in counts.items():
    if (cnt + counts.get(b-1, 0) + counts.get(b+1, 0)) * 100.0 / nw >= GLOBAL_MIN: accepted.add(b)
print("accepted lag bins (ms):", sorted(round(b*binw/sr*1000, 1) for b in accepted))
# local gate: near an accepted lag AND echoed in >=VOTES of the 10 neighbouring windows
tol = D_TOL_MS*sr/1000
sched = [[] for _ in range(nw)]
for i in range(nw):
    if not cands[i]: continue
    keep = []
    for d, v in cands[i]:
        if not any(abs(d//binw - b) <= 1 for b in accepted): continue
        votes = 0
        for j in range(max(0, i-5), min(nw, i+6)):
            if j != i and any(abs(d-dj) <= tol for dj, _ in cands[j]): votes += 1
        if votes >= VOTES: keep.append(d)
    if not keep: continue
    if ANALYZE: sched[i] = [(d, 0.5) for d in keep]; continue
    # solve levels jointly: coordinate descent, each tap bisected to null its residual peak
    seg = mono[i*W:(i+1)*W]; seg = seg - seg.mean()
    taps = [(d, 0.0) for d in keep]
    for _ in range(2):
        for ti in range(len(taps)):
            d = taps[ti][0]
            def resid(a):
                tt = list(taps); tt[ti] = (d, a); ac = acorr(inverse(seg, tt)); return ac[d-3:d+4].max()
            alo, ahi = 0.0, A_MAX
            if resid(ahi) > 0: a = ahi
            else:
                for _ in range(6):
                    am = (alo+ahi)/2
                    if resid(am) > 0: alo = am
                    else: ahi = am
                a = (alo+ahi)/2
            taps[ti] = (d, a)
    taps = [(d, min(A_MAX, STRENGTH*a)) for d, a in taps if a > 0.03]
    # stability: the recursion x = y - sum a_j x(t-d_j) is safe when sum|a_j| < 1
    tot = sum(a for _, a in taps)
    if tot > A_SUM_MAX: taps = [(d, a*A_SUM_MAX/tot) for d, a in taps]
    sched[i] = taps
# fill single-window gaps
for i in range(1, nw-1):
    if not sched[i] and sched[i-1] and sched[i+1]: sched[i] = sched[i-1]
treated = sum(1 for s in sched if s)/nw*100
alld = [d for s in sched for d, _ in s]; alla = [a for s in sched for _, a in s]
if ANALYZE:
    B = 300
    print("treated% per 5min:", " ".join(f"{sum(1 for s in sched[b:b+B] if s)*100//max(1,len(sched[b:b+B]))}" for b in range(0, nw, B)))
    sys.exit(0)
print(f"windows={nw} treated={treated:.0f}% taps/window={np.mean([len(s) for s in sched if s]) if alld else 0:.2f} "
      f"delay median={np.median(alld)/sr*1000 if alld else 0:.1f}ms a median={np.median(alla) if alla else 0:.2f}")

# apply: per-channel recursion, whole tap set crossfaded over XF_MS at window changes
y = raw.astype(np.float32)/32768.0
x = np.zeros((n+hi, ch), dtype=np.float32)
xf = int(XF_MS*sr/1000); step = lo; pos = 0; last_wi = -1; prev = []
def term_for(taps, i0, i1):
    t = np.zeros((i1-i0, ch), dtype=np.float32)
    for d, a in taps: t += a * x[hi+i0-d:hi+i1-d]
    return t
while pos < n:
    e = min(n, pos+step); wi = min(nw-1, pos//W)
    if wi != last_wi:
        prev = sched[last_wi] if last_wi >= 0 else []; last_wi = wi
    cur = sched[wi]; win_start = wi*W
    t = term_for(cur, pos, e)
    if prev != cur and pos - win_start < xf:
        tp = term_for(prev, pos, e)
        wgt = np.clip((np.arange(pos, e) - win_start)/xf, 0, 1)[:, None]
        t = (1-wgt)*tp + wgt*t
    x[hi+pos:hi+e] = y[pos:e] - t
    pos = e
out = x[hi:hi+n]
bad = ~np.isfinite(out).all(axis=1)
# blow-up guard: any second whose output is >2x louder than its input, or non-finite, reverts to the input
blown = 0
for i in range(nw):
    a0, a1 = i*W, (i+1)*W
    if bad[a0:a1].any() or np.sqrt(np.mean(out[a0:a1]**2)) > 2*np.sqrt(np.mean(y[a0:a1]**2)) + 1e-4:
        out[a0:a1] = y[a0:a1]; blown += 1
print(f"blown-up seconds reverted to original: {blown}")
peak = np.abs(out).max()
if peak > 0.99: out = out/peak*0.99
wo = wave.open(outp, 'wb'); wo.setnchannels(ch); wo.setsampwidth(2); wo.setframerate(sr)
wo.writeframes((out*32767).astype(np.int16).tobytes()); wo.close(); print("wrote", outp)
