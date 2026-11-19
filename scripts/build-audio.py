#!/usr/bin/env python3
"""ASMR audio engine: .events.json -> stereo 48 kHz 16-bit WAV. Pure standard library.

Uses the live samples public/audio/{chop,crackle,whoosh}.wav (soft synthesis only as a fallback if a file is missing).
  * slice rounds: pitched-up chop + sub punch + crackle crunch; dt-adaptive envelope (short tail + high-pass + micro-clicks)
    for dense hits; delayed shard clatter after phase-B cuts; real 3.5-7.5 kHz hiss for the thermal blade.
    dt crossfade: dt >= 90 ms full chop.wav; below it the chop share falls to 0.15 (0 under 45 ms) and is replaced by
    12-22 ms jittered crackle grains (HP 900 Hz, pitch 0.95-1.25, random pan) -> glass/stone scatter, no tonal buzz.
  * pour rounds (R4/R5): chop.wav is DISABLED; layered stereo crackle stream (coarse/fine by round) + quiet blade hum
    at -20 dB, hard 120 ms fade at pour_end.
  * mastering: soft limiter + peak normalise to -1.0 dBFS.
"""
import argparse
import json
import math
import os
import random
import struct
import wave

SR = 48000
PEAK_DBFS = -1.0
TAU = 2.0 * math.pi
AUDIO_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'audio')
POUR_FADE = 0.12


class Mix:
    def __init__(self, seconds):
        self.n = int(seconds * SR) + 1
        self.L = [0.0] * self.n
        self.R = [0.0] * self.n

    def add(self, t, samples, gain=1.0, pan=0.0):
        """Mix mono samples at time t. pan: -1 (L) .. 1 (R), constant-power."""
        i0 = int(t * SR)
        if i0 < 0 or i0 >= self.n or gain == 0.0:
            return
        a = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4.0
        gl, gr = math.cos(a) * gain, math.sin(a) * gain
        end = min(self.n, i0 + len(samples))
        L, R = self.L, self.R
        for k in range(end - i0):
            s = samples[k]
            L[i0 + k] += s * gl
            R[i0 + k] += s * gr


# ---- sample bank ------------------------------------------------------------------------------------
BANK = {}


def load_sample(name):
    path = os.path.join(AUDIO_DIR, name)
    if not os.path.isfile(path):
        return None
    try:
        with wave.open(path, 'rb') as w:
            ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(n)
        if sw == 2:
            vals = [v / 32768.0 for v in struct.unpack('<%dh' % (len(raw) // 2), raw)]
        elif sw == 1:
            vals = [(b - 128) / 128.0 for b in raw]
        else:
            return None
        mono = [sum(vals[i:i + ch]) / ch for i in range(0, len(vals) - ch + 1, ch)]
        peak = max(1e-9, max(abs(v) for v in mono))
        return {'data': [v / peak for v in mono], 'sr': sr, 'path': path}
    except (wave.Error, OSError, struct.error):
        return None


def play(smp, pitch=1.0, offset=0.0, dur=None):
    """Linear-interpolated resample of a sample segment. pitch > 1 = higher/shorter. offset/dur in output seconds."""
    d, step = smp['data'], pitch * smp['sr'] / SR
    j0 = offset * smp['sr']
    avail = int((len(d) - 2 - j0) / step)
    n = avail if dur is None else min(avail, int(dur * SR))
    out = [0.0] * max(0, n)
    for i in range(len(out)):
        p = j0 + i * step
        j = int(p)
        f = p - j
        out[i] = d[j] * (1.0 - f) + d[j + 1] * f
    return out


def grain(smp, rnd, dur, pitch, fade=0.3):
    """Random window of a sample with Hann-ish edges (fade = fraction of length used for in/out ramps)."""
    seg = len(smp['data']) / smp['sr'] / pitch
    off = rnd.uniform(0.0, max(0.0, seg - dur - 0.01)) * pitch
    x = play(smp, pitch, off, dur)
    n = len(x)
    r = max(1, int(n * fade))
    for i in range(min(r, n)):
        w = 0.5 - 0.5 * math.cos(math.pi * i / r)
        x[i] *= w
        x[n - 1 - i] *= w
    return x


# ---- filters / primitives ---------------------------------------------------------------------------
def biquad(x, kind, f0, q=0.707):
    """RBJ biquad: kind in lp, hp, bp."""
    w0 = TAU * f0 / SR
    c, s = math.cos(w0), math.sin(w0)
    alpha = s / (2.0 * q)
    if kind == 'lp':
        b0, b1, b2 = (1 - c) / 2, 1 - c, (1 - c) / 2
    elif kind == 'hp':
        b0, b1, b2 = (1 + c) / 2, -(1 + c), (1 + c) / 2
    else:
        b0, b1, b2 = alpha, 0.0, -alpha
    a0, a1, a2 = 1 + alpha, -2 * c, 1 - alpha
    b0, b1, b2, a1, a2 = b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0
    x1 = x2 = y1 = y2 = 0.0
    out = [0.0] * len(x)
    for i, v in enumerate(x):
        y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        x2, x1, y2, y1 = x1, v, y1, y
        out[i] = y
    return out


def sweep_sine(f0, f1, dur, rate=6.0, decay=6.0, attack=24):
    """Sine with exponential pitch drop f0 -> f1 and exponential decay."""
    n = int(dur * SR)
    out, ph = [0.0] * n, 0.0
    for i in range(n):
        u = i / n
        ph += TAU * (f1 + (f0 - f1) * math.exp(-u * rate)) / SR
        out[i] = math.sin(ph) * math.exp(-u * decay) * min(1.0, i / attack)
    return out


def noise(n, rnd):
    return [rnd.random() * 2 - 1 for _ in range(n)]


def shape_tail(x, decay):
    """Keep the transient, raised-cosine fade from 0.3*decay to decay, truncate."""
    n = min(len(x), int(decay * SR))
    k0 = int(0.3 * decay * SR)
    out = x[:n]
    for i in range(k0, n):
        out[i] *= 0.5 + 0.5 * math.cos(math.pi * (i - k0) / max(1, n - k0))
    return out


def fade_out(x, sec=0.03):
    n = len(x)
    r = min(n, int(sec * SR))
    for i in range(r):
        x[n - 1 - i] *= i / r
    return x


def vary(rnd, amount=0.08):
    return 1.0 + rnd.uniform(-amount, amount)


# ---- fallback synthesis (only if a sample file is missing) ------------------------------------------
def synth_crackle(rnd, dur):
    n = int(dur * SR)
    x = [(rnd.random() * 2 - 1) * math.exp(-(i / n) * 5.0) for i in range(n)]
    return biquad(x, 'bp', rnd.uniform(1800.0, 4500.0), 1.2)


def crackle(rnd, dur, pitch=1.0):
    if BANK.get('crackle'):
        return grain(BANK['crackle'], rnd, dur, pitch, 0.25)
    return synth_crackle(rnd, dur)


# ---- event voices ----------------------------------------------------------------------------------
STATS = {'chop_played': 0, 'chop_replaced': 0, 'glass_grains': 0, 'chop_skipped_pour': 0, 'clatter': 0, 'hiss': 0, 'dense': 0, 'pour_grains': 0}


def voice_drop(mix, t, inten, rnd):
    """Heavy deep landing: 80 -> 30 Hz sub + short stony contact click."""
    mix.add(t, sweep_sine(80.0, 30.0, 0.7, rate=5.0, decay=5.5), 1.0 * inten)
    click = biquad(crackle(rnd, 0.018, 1.1), 'hp', 1500.0)
    mix.add(t + 0.001, fade_out(click, 0.006), 0.55 * inten, rnd.uniform(-0.15, 0.15))
    if BANK.get('chop'):  # low knock body of the contact
        mix.add(t, shape_tail(play(BANK['chop'], 0.8), 0.09), 0.3 * inten)


CHOP_FULL_DT = 0.09   # dt >= this: chop.wav at full share
CHOP_OFF_DT = 0.045   # dt < this: chop.wav removed entirely
CHOP_MIN_SHARE = 0.15  # share just above CHOP_OFF_DT


def chop_share(dt):
    """Crossfade weight of chop.wav vs. the non-tonal crackle grains, by inter-cut interval."""
    if dt >= CHOP_FULL_DT:
        return 1.0
    if dt < CHOP_OFF_DT:
        return 0.0
    return CHOP_MIN_SHARE + (1.0 - CHOP_MIN_SHARE) * (dt - CHOP_OFF_DT) / (CHOP_FULL_DT - CHOP_OFF_DT)


def glass_grains(mix, t, dt, gain, rnd):
    """Shattering-glass scatter: 2-4 ultra-short (12-22 ms) random crackle windows, HP 900 Hz, pitch 0.95-1.25,
    random pan, timing jittered across the interval so dense runs never form a periodic (pitched) buzz."""
    span = max(0.012, dt) * 1.1
    for _ in range(rnd.randint(2, 4)):
        x = biquad(crackle(rnd, rnd.uniform(0.012, 0.022), rnd.uniform(0.95, 1.25)), 'hp', 900.0)
        mix.add(t + rnd.uniform(-0.15, 1.0) * span, x, gain * rnd.uniform(0.45, 1.0), rnd.uniform(-0.7, 0.7))
        STATS['glass_grains'] += 1


def voice_chop(mix, t, inten, tool, dt, phase, rnd):
    pan = rnd.uniform(-0.25, 0.25)
    stone = tool in ('STEEL', '1000°C THERMAL')
    pitch = rnd.uniform(1.12, 1.25) if stone else rnd.uniform(1.2, 1.38)
    dense = dt < 0.14
    g = inten * vary(rnd, 0.07) * (math.sqrt(max(dt, 0.02) / 0.14) if dense else 1.0)
    w = chop_share(dt)
    if BANK.get('chop') and w > 0.0:
        x = play(BANK['chop'], pitch)
        if dense:  # crisp crunchy roll instead of resonant quacking; HP rises through the crossfade to strip the ~470 Hz body
            x = biquad(shape_tail(x, max(0.02, min(0.14, dt * 1.1))), 'hp', 420.0 + 680.0 * (1.0 - w))
            if w < 1.0:
                x = biquad(x, 'hp', 420.0 + 680.0 * (1.0 - w))
            STATS['dense'] += 1
        else:
            x = fade_out(x, 0.06)
        mix.add(t, x, 0.8 * g * w, pan)
        STATS['chop_played'] += 1
    if w < 1.0:  # replaces the tonal chop body with a non-tonal glass/stone scatter
        glass_grains(mix, t, dt, 0.75 * g * (1.0 - w), rnd)
        if w == 0.0:
            STATS['chop_replaced'] += 1
    if stone:  # hard stone/glass snap: sub punch (only while chop.wav dominates: stacked sines would buzz) + crackle crunch
        if w > 0.5:
            mix.add(t, sweep_sine(75.0, 35.0, 0.09 if not dense else 0.05, rate=4.0, decay=5.0), 0.55 * g * w * w)
        mix.add(t + 0.0015 + rnd.uniform(0.0, 0.004) * (1.0 - w), biquad(crackle(rnd, 0.02, rnd.uniform(1.0, 1.2)), 'hp', 900.0), 0.5 * g, pan)
    if dense:  # micro-clicks, jittered
        for _ in range(1 + (dt < 0.07)):
            mix.add(t + rnd.uniform(0.0, max(0.006, dt * 0.8)), biquad(crackle(rnd, rnd.uniform(0.005, 0.009), rnd.uniform(1.0, 1.3)), 'hp', 1200.0), 0.35 * g, rnd.uniform(-0.5, 0.5))
    if tool == '1000°C THERMAL':  # real high hiss: band 3.5-7.5 kHz, 100 ms, -15 dB
        n = int(0.1 * SR)
        h = biquad(biquad(noise(n, rnd), 'hp', 3500.0, 0.7), 'lp', 7500.0, 0.7)
        for i in range(n):
            u = i / n
            h[i] *= min(1.0, i / 120.0) * math.exp(-u * 3.0)
        mix.add(t + 0.002, h, 10 ** (-15 / 20) * 2.2 * g, -pan)
        STATS['hiss'] += 1
    if phase == 'b':  # delayed fall + rattle of shards on the table
        k = 1 if dt < 0.1 else rnd.randint(2, 3)
        for _ in range(k):
            mix.add(t + rnd.uniform(0.09, 0.24), fade_out(crackle(rnd, rnd.uniform(0.025, 0.045), rnd.uniform(0.95, 1.25)), 0.01),
                    rnd.uniform(0.1, 0.2) * (0.6 if dt < 0.1 else 1.0), rnd.uniform(-0.75, 0.75))
            STATS['clatter'] += 1


def voice_pour(mix, t0, t1, round_idx, marks, rnd):
    """Layered stereo crackle stream (no chop.wav) + quiet blade hum at -20 dB; hard 120 ms fade after t1."""
    fine = round_idx >= 4
    end = t1 + POUR_FADE
    n = int((end - t0) * SR) + 1
    L, R = [0.0] * n, [0.0] * n

    def put(off, x, g, pan):
        i0 = int(off * SR)
        a = (pan + 1.0) * math.pi / 4.0
        gl, gr = math.cos(a) * g, math.sin(a) * g
        for k in range(min(len(x), n - i0)):
            L[i0 + k] += x[k] * gl
            R[i0 + k] += x[k] * gr

    def density(tt):  # cut-marker activity around tt (0..1)
        c = sum(m[1] for m in marks if abs(m[0] - tt) < 0.12)
        return min(1.0, 0.35 + c / 4.0)

    t, side = t0, 1.0
    base_dt = 0.018 if fine else 0.03
    while t < t1:
        d = density(t)
        pitch = rnd.uniform(1.15, 1.32) if fine else rnd.uniform(0.85, 0.98)
        dur = rnd.uniform(0.05, 0.11) if fine else rnd.uniform(0.08, 0.16)
        x = crackle(rnd, dur, pitch)
        if fine:
            x = biquad(x, 'hp', 1800.0)  # silky fine sand
        side = -side
        put(t - t0, x, (0.16 if fine else 0.24) * (0.55 + 0.45 * d) * vary(rnd, 0.2), side * rnd.uniform(0.25, 0.9))
        STATS['pour_grains'] += 1
        t += base_dt * rnd.uniform(0.6, 1.4) / (0.6 + 0.6 * d)

    rms = math.sqrt(sum(v * v for v in L[:int((t1 - t0) * SR)]) / max(1, int((t1 - t0) * SR))) or 1e-3
    # noble hi-tech blade hum/shimmer: soft harmonic drone + airy band noise, normalised to -20 dB vs the stream
    hn = int((t1 - t0) * SR)
    hum, ph = [0.0] * hn, 0.0
    f0 = 165.0 if fine else 120.0
    for i in range(hn):
        u = i / SR
        ph += TAU * f0 * (1 + 0.004 * math.sin(TAU * 5.5 * u)) / SR
        hum[i] = math.sin(ph) + 0.45 * math.sin(2 * ph) + 0.2 * math.sin(3 * ph + 0.3)
    air = biquad(noise(hn, rnd), 'bp', 2800.0 if fine else 2200.0, 0.8)
    for i in range(hn):
        hum[i] = hum[i] * 0.6 + air[i] * 2.0
    for i in range(min(hn, int(0.15 * SR))):
        hum[i] *= i / (0.15 * SR)
    hrms = math.sqrt(sum(v * v for v in hum) / max(1, hn)) or 1e-3
    hg = rms * 10 ** (-20 / 20) / hrms
    for i in range(hn):
        L[i] += hum[i] * hg * 0.7
        R[i] += hum[i] * hg * 0.7
    # 40 ms fade in; hard clean 120 ms fade out starting at pour_end, then silence
    for i in range(min(n, int(0.04 * SR))):
        w = i / (0.04 * SR)
        L[i] *= w
        R[i] *= w
    k1, kf = int((t1 - t0) * SR), int(POUR_FADE * SR)
    for i in range(k1, n):
        w = max(0.0, 1.0 - (i - k1) / kf)
        w = w * w
        L[i] *= w
        R[i] *= w
    i0 = int(t0 * SR)
    for k in range(min(n, mix.n - i0)):
        mix.L[i0 + k] += L[k]
        mix.R[i0 + k] += R[k]


def voice_whoosh(mix, t, dur, inten, rnd):
    if BANK.get('whoosh'):
        mix.add(t, play(BANK['whoosh'], vary(rnd, 0.07)), 0.4 * inten, rnd.uniform(-0.4, 0.4))
    else:
        x = biquad(noise(int(dur * SR), rnd), 'lp', 800.0)
        n = len(x)
        mix.add(t, [x[i] * math.sin(math.pi * i / n) ** 2 * 2.0 for i in range(n)], 0.22 * inten)


# ---- mastering -------------------------------------------------------------------------------------
def master(mix):
    """Soft limiter (tanh above knee) then peak-normalise to PEAK_DBFS."""
    target = 10 ** (PEAK_DBFS / 20.0)
    peak = max(max(map(abs, mix.L), default=0.0), max(map(abs, mix.R), default=0.0), 1e-9)
    knee, pre = 0.7, 1.25 / peak
    for ch in (mix.L, mix.R):
        for i, s in enumerate(ch):
            x = s * pre
            a = abs(x)
            if a > knee:
                x = math.copysign(knee + (1 - knee) * math.tanh((a - knee) / (1 - knee)), x)
            ch[i] = x
    peak = max(max(map(abs, mix.L)), max(map(abs, mix.R)), 1e-9)
    k = target / peak
    for ch in (mix.L, mix.R):
        for i in range(len(ch)):
            ch[i] *= k


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('events', help='path to .events.json')
    ap.add_argument('out', help='output .wav')
    ap.add_argument('--tail', type=float, default=1.0, help='extra seconds after last event')
    ap.add_argument('--duration', type=float, default=None, help='force total length in seconds')
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()

    with open(a.events, encoding='utf-8') as f:
        events = sorted(json.load(f), key=lambda e: e['time'])
    rnd = random.Random(a.seed)
    for key in ('chop', 'crackle', 'whoosh'):
        BANK[key] = load_sample(key + '.wav')
    print('samples: ' + ', '.join(f'{k}={"live " + os.path.basename(v["path"]) if v else "synth fallback"}' for k, v in BANK.items()))
    total = a.duration if a.duration else (max((e['time'] for e in events), default=0.0) + a.tail + 0.6)
    mix = Mix(total)

    # pour windows (chop.wav disabled inside) and per-round chop times (for dt-adaptive envelopes)
    windows, opened = {}, {}
    for e in events:
        if e['type'] == 'pour_start':
            opened[e['round']] = e['time']
        elif e['type'] == 'pour_end':
            windows[e['round']] = (opened.pop(e['round'], e['time'] - 1.0), e['time'])
    chops = {}
    for e in events:
        if e['type'] == 'chop':
            chops.setdefault(e['round'], []).append(e['time'])

    def in_pour(e):
        w = windows.get(e['round'])
        return e.get('phase') == 'pour' or (w is not None and w[0] - 0.05 <= e['time'] <= w[1] + POUR_FADE)

    for e in events:
        t, ty, inten, tool = e['time'], e['type'], float(e.get('intensity', 1.0)), e.get('tool', '')
        if ty == 'drop':
            voice_drop(mix, t, inten, rnd)
        elif ty == 'chop':
            if in_pour(e):
                STATS['chop_skipped_pour'] += 1
                continue
            ts = chops[e['round']]
            i = ts.index(t)
            gaps = [ts[i] - ts[i - 1]] if i > 0 else []
            if i + 1 < len(ts):
                gaps.append(ts[i + 1] - ts[i])
            dt = min(gaps) if gaps else 1.0
            voice_chop(mix, t, inten, tool, dt, e.get('phase', ''), rnd)
        elif ty == 'pour_end':
            r = e['round']
            t0, t1 = windows[r]
            marks = [(m['time'], float(m.get('intensity', 0.5))) for m in events if m['type'] == 'chop' and m['round'] == r]
            voice_pour(mix, t0, t1, r, marks, rnd)
        elif ty == 'rotate':
            voice_whoosh(mix, t, 0.4, inten, rnd)
        elif ty == 'sweep':
            voice_whoosh(mix, t, 0.55, inten, rnd)

    master(mix)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    clipped = 0
    with wave.open(a.out, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        buf = bytearray()
        for l, r in zip(mix.L, mix.R):
            if abs(l) >= 1.0 or abs(r) >= 1.0:
                clipped += 1
            buf += struct.pack('<hh', int(max(-1.0, min(1.0, l)) * 32767), int(max(-1.0, min(1.0, r)) * 32767))
        w.writeframes(bytes(buf))
    pk = max(max(map(abs, mix.L)), max(map(abs, mix.R)))
    print('voices: ' + ', '.join(f'{k}={v}' for k, v in STATS.items()))
    print('pour windows (chop.wav off): ' + ', '.join(f'R{r + 1} {w[0]:.2f}-{w[1]:.2f}s' for r, w in sorted(windows.items())))
    print(f'audio: {a.out} ({total:.2f}s, {len(events)} events, peak {20 * math.log10(max(pk, 1e-9)):.2f} dBFS, clipped {clipped})')


if __name__ == '__main__':
    main()
