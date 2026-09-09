#!/usr/bin/env python3
# Echo scan — is a show recording carrying a delayed duplicate of itself?
#
# Written for the 2026-09 "weird echo in the recordings" report: the gesture
# eye (a second god-mode Chrome window on the streaming box) played every
# guest a second time and OBS's system-audio capture streamed both copies.
# The signature is a strong autocorrelation peak at a FIXED lag (~25ms —
# two tabs' WebRTC jitter buffers) that holds across an hour of voice.
# Music also autocorrelates (beats/notes) but its lag wanders per track, and
# voice pitch lives under ~12ms, which the 14ms floor excludes.
#
#   # pull 60s mono samples off the prod box, several offsets per show:
#   ssh slopcomputer 'cd /home/ubuntu/recordings/live && for t in 00:25:00 00:40:00 00:55:00; do
#     nice -n 15 ffmpeg -hide_banner -loglevel error -y -ss $t -t 60 -i <FILE>.mp4 -vn -ac 1 -ar 16000 /tmp/smp_${t//:/}.wav; done'
#   scp 'slopcomputer:/tmp/smp_*.wav' /tmp/ && /usr/bin/python3 ops/probes/echo-scan.py /tmp/smp_*.wav
#
# Reading it: a clean show has <30% "echo-like" windows scattered at
# random lags. A doubled one has 80-100% at one lag (20-40ms bin), show after
# show. Needs numpy (the macOS system python3 has it).
import sys, wave, numpy as np
def load(p):
    w=wave.open(p); sr=w.getframerate(); n=w.getnframes()
    x=np.frombuffer(w.readframes(n),dtype=np.int16).astype(np.float64)/32768
    return sr,x
def scan(p, win_s=4.0, lo_ms=14, hi_ms=500, thr=0.25):
    sr,x=load(p)
    # high-pass ~150Hz via FFT to focus on voice/transients
    X=np.fft.rfft(x); f=np.fft.rfftfreq(len(x),1/sr); X[f<150]=0; x=np.fft.irfft(X,len(x))
    W=int(win_s*sr); lo=int(lo_ms*sr/1000); hi=int(hi_ms*sr/1000)
    hits=[]; total=0; quiet=0
    for i in range(0,len(x)-W,W):
        seg=x[i:i+W]; rms=np.sqrt(np.mean(seg**2))
        if rms<0.01: quiet+=1; continue
        total+=1
        seg=seg-seg.mean()
        n=1<<int(np.ceil(np.log2(2*W)))
        F=np.fft.rfft(seg,n); ac=np.fft.irfft(F*np.conj(F),n)[:W]; ac/=ac[0]
        # prominence: peak vs local median so periodic music doesn't dominate
        r=ac[lo:hi]; k=int(np.argmax(r)); v=r[k]; lag_ms=(k+lo)*1000/sr
        med=np.median(np.abs(r))
        if v>thr and v>4*med: hits.append((lag_ms,v))
    return total,quiet,hits
for p in sys.argv[1:]:
    total,quiet,hits=scan(p)
    name=p.split('/')[-1]
    print(f"\n{name}: windows w/ sound={total} quiet={quiet} echo-like={len(hits)} ({100*len(hits)/max(1,total):.0f}%)")
    if hits:
        lags=np.array([h[0] for h in hits]); vals=np.array([h[1] for h in hits])
        hist,edges=np.histogram(lags,bins=np.arange(0,520,20))
        print("  lag histogram (ms:count):", " ".join(f"{int(e)}:{c}" for e,c in zip(edges[:-1],hist) if c))
        print(f"  median lag {np.median(lags):.0f}ms, median peak {np.median(vals):.2f}, max peak {vals.max():.2f}")
