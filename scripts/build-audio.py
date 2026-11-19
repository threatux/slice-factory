#!/usr/bin/env python3
"""ASMR audio engine: .events.json -> stereo 48 kHz 16-bit WAV. Pure standard library."""
import argparse
import json
import math
import os
import random
import struct
import wave

SR = 48000
PEAK_DBFS = -1.5
TAU = 2.0 * math.pi


class Mix:
    def __init__(self, seconds):
        self.n = int(seconds * SR) + 1
        self.L = [0.0] * self.n
        self.R = [0.0] * self.n

    def add(self, t, samples, gain=1.0, pan=0.0):
        """Mix mono samples at time t. pan: -1 (L) .. 1 (R), constant-power."""
        i0 = int(t * SR)
        if i0 < 0 or i0 >= self.n:
            return
        a = (pan + 1.0) * math.pi / 4.0
        gl, gr = math.cos(a) * gain, math.sin(a) * gain
        end = min(self.n, i0 + len(samples))
        L, R = self.L, self.R
        for k in range(end - i0):
            s = samples[k]
            L[i0 + k] += s * gl
            R[i0 + k] += s * gr


# ---- synth primitives (mono sample lists) ---------------------------------------------------------
def thump(f0, f1, dur, rnd):
    """Sine with exponential pitch drop f0->f1 and exponential decay."""
    n = int(dur * SR)
    out, ph = [0.0] * n, 0.0
    for i in range(n):
        u = i / n
        f = f1 + (f0 - f1) * math.exp(-u * 6.0)
        ph += TAU * f / SR
        env = math.exp(-u * 5.0) * min(1.0, i / 24.0)
        out[i] = math.sin(ph) * env
    return out


def click(freq, dur, noise_mix, decay, rnd):
    """Short decaying tone + noise burst."""
    n = max(8, int(dur * SR))
    out, ph = [0.0] * n, rnd.random() * TAU
    for i in range(n):
        u = i / n
        env = math.exp(-u * decay) * min(1.0, i / 6.0)
        ph += TAU * freq / SR
        out[i] = (math.sin(ph) * (1.0 - noise_mix) + (rnd.random() * 2 - 1) * noise_mix) * env
    return out


def hp_noise(dur, decay, rnd, hp=0.9):
    """High-passed white noise burst (one-pole HP, coefficient hp)."""
    n = int(dur * SR)
    out, px, py = [0.0] * n, 0.0, 0.0
    for i in range(n):
        x = rnd.random() * 2 - 1
        py = hp * (py + x - px)
        px = x
        out[i] = py * math.exp(-(i / n) * decay) * min(1.0, i / 12.0)
    return out


def air_whoosh(dur, rnd, f_lo=500.0, f_hi=3200.0):
    """Band-limited noise with a swelling/fading envelope and sweeping cutoff (soft air whistle)."""
    n = int(dur * SR)
    out, lp1, lp2 = [0.0] * n, 0.0, 0.0
    for i in range(n):
        u = i / n
        fc = f_lo + (f_hi - f_lo) * math.sin(math.pi * u)
        a = 1.0 - math.exp(-TAU * fc / SR)
        x = rnd.random() * 2 - 1
        lp1 += a * (x - lp1)
        lp2 += a * (lp1 - lp2)
        env = math.sin(math.pi * u) ** 2
        out[i] = (lp1 - lp2) * 6.0 * env
    return out


def vary(rnd, amount=0.08):
    return 1.0 + rnd.uniform(-amount, amount)


# ---- event voices ----------------------------------------------------------------------------------
def voice_drop(mix, t, inten, rnd):
    mix.add(t, thump(65.0, 28.0, 0.55, rnd), 0.9 * inten)
    mix.add(t, click(3800.0, 0.012, 0.35, 5.0, rnd), 0.35 * inten, rnd.uniform(-0.2, 0.2))


def voice_chop(mix, t, inten, tool, rnd):
    v, pv = vary(rnd), vary(rnd)  # +-8% volume / pitch micro-variation
    g = inten * v
    pan = rnd.uniform(-0.25, 0.25)
    if tool == 'STEEL':
        mix.add(t, thump(190.0 * pv, 70.0 * pv, 0.12, rnd), 0.8 * g, pan)
        mix.add(t + 0.004, click(2900.0 * pv, 0.09, 0.45, 5.5, rnd), 0.45 * g, pan)
        mix.add(t + 0.006, click(4700.0 * pv, 0.07, 0.25, 7.0, rnd), 0.3 * g, pan)
    elif tool == '1000°C THERMAL':
        mix.add(t, thump(160.0 * pv, 60.0 * pv, 0.1, rnd), 0.6 * g, pan)
        mix.add(t + 0.003, hp_noise(0.12, 4.0, rnd, 0.85), 0.55 * g, pan)
    elif tool == 'ULTRASONIC':
        mix.add(t, click(6200.0 * pv, 0.018, 0.2, 4.0, rnd), 0.55 * g, pan)
        mix.add(t, click(3100.0 * pv, 0.12, 0.02, 4.5, rnd), 0.22 * g, pan)  # harmonic resonance
        mix.add(t, click(9300.0 * pv, 0.08, 0.02, 6.0, rnd), 0.12 * g, pan)
    else:  # PLASMA / HYPER-SLICE: dense micro-clicks
        k = 1 + int(inten * 3)
        for j in range(k):
            mix.add(t + j * rnd.uniform(0.0015, 0.007), click(rnd.uniform(2400, 5200) * pv, 0.006, 0.5, 6.0, rnd),
                    0.22 * g, rnd.uniform(-0.5, 0.5))


def voice_pour(mix, t0, t1, tool, rnd):
    """Cascade of crumb micro-clicks + low rumble whose pitch rises with pile growth."""
    dur = max(0.1, t1 - t0)
    n_clicks = int(dur * 70)
    for _ in range(n_clicks):  # "hundreds" of micro-clicks over the pour
        u = rnd.random()
        t = t0 + u * dur
        f = rnd.uniform(1800, 6500) * (1.0 + 0.35 * u)
        mix.add(t, click(f, rnd.uniform(0.003, 0.009), 0.55, 6.0, rnd), rnd.uniform(0.04, 0.14) * (0.5 + 0.7 * u), rnd.uniform(-0.8, 0.8))
    # rumble: filtered noise + sine whose pitch rises 55 -> 110 Hz
    n = int(dur * SR)
    out, ph, lp = [0.0] * n, 0.0, 0.0
    for i in range(n):
        u = i / n
        ph += TAU * (55.0 + 55.0 * u) / SR
        lp += 0.02 * ((rnd.random() * 2 - 1) - lp)
        env = min(1.0, u * 8.0, (1.0 - u) * 6.0)
        out[i] = (math.sin(ph) * 0.5 + lp * 5.0) * env
    mix.add(t0, out, 0.22)


def voice_whoosh(mix, t, dur, inten, rnd):
    mix.add(t, air_whoosh(dur, rnd), 0.25 * inten, rnd.uniform(-0.3, 0.3))


# ---- mastering -------------------------------------------------------------------------------------
def master(mix):
    """Soft limiter (tanh above knee) then peak-normalise to PEAK_DBFS."""
    target = 10 ** (PEAK_DBFS / 20.0)
    peak = max(max(map(abs, mix.L), default=0.0), max(map(abs, mix.R), default=0.0), 1e-9)
    knee = 0.6
    pre = 1.0 / peak  # bring to full scale first, then squash transients above the knee
    for ch in (mix.L, mix.R):
        for i, s in enumerate(ch):
            x = s * pre * 1.6
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
        events = json.load(f)
    rnd = random.Random(a.seed)
    total = a.duration if a.duration else (max((e['time'] for e in events), default=0.0) + a.tail + 0.6)
    mix = Mix(total)

    pour_open = {}
    for e in sorted(events, key=lambda e: e['time']):
        t, ty, inten, tool = e['time'], e['type'], float(e.get('intensity', 1.0)), e.get('tool', '')
        if ty == 'drop':
            voice_drop(mix, t, inten, rnd)
        elif ty == 'chop':
            voice_chop(mix, t, inten, tool, rnd)
        elif ty == 'pour_start':
            pour_open[e.get('round')] = t
        elif ty == 'pour_end':
            voice_pour(mix, pour_open.pop(e.get('round'), t - 1.0), t, tool, rnd)
        elif ty == 'rotate':
            voice_whoosh(mix, t, 0.4, inten, rnd)
        elif ty == 'sweep':
            voice_whoosh(mix, t, 0.55, inten, rnd)

    master(mix)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with wave.open(a.out, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        buf = bytearray()
        for l, r in zip(mix.L, mix.R):
            buf += struct.pack('<hh', int(max(-1.0, min(1.0, l)) * 32767), int(max(-1.0, min(1.0, r)) * 32767))
        w.writeframes(bytes(buf))
    print(f'audio: {a.out} ({total:.2f}s, {len(events)} events)')


if __name__ == '__main__':
    main()
