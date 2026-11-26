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
  * "slizzy_metal" / "slizzy_obsidian": v2.0 engine voices (obsidian = deeper stone sub 75->24 Hz, chop.wav 0.78-0.92x, HP 2.8 kHz
    glass crack from crackle.wav, 400-900 Hz fire whoosh + heat crackle, stone clatter R1-R3 / glass scree R4-R6).
  * "slizzy_earth" (Planet Earth): tectonic sub 60->22 Hz, heavy stone split (chop.wav 0.72-0.86x, LP), dense magma hiss +
    falling-rock crackle (crackle.wav), deep 'energy' whoosh fans (whoosh.wav 0.74-0.98x, 220-950 Hz body). slizzy_metal /
    slizzy_obsidian code paths are untouched (EARTH branches only).
  * "slizzy_ice" (Cryo Ice Sphere): dense dry ice-block impact (sub 85->28 Hz + chop.wav 1.04-1.16x LP + crisp glass-ice split
    from crackle.wav HP 2.4 kHz 1.12-1.30x), frosty slashes (whoosh.wav 1.0-2.4 kHz body + 15-22 ms crackle.wav freeze click),
    ringing ice-chunk clatter R1-R3 / crisp ice-crumb scree R4-R6. ICE branches only: metal / obsidian / earth paths untouched.
  * "slizzy_plastic" (Rubik's cube / LEGO ABS): short dry springy punch = noise through a 105 -> 36 Hz sweeping SVF low-pass
    (no sine oscillator, no stone rumble) + snappy plastic click (chop.wav 1.18-1.35x, HP, short tail) + fast hard-plastic
    rattle cascade (crackle.wav band-passed 1.4-5.8 kHz, 1.10-1.35x); slashes = whoosh.wav 1.2-3.0 kHz body + 12-18 ms micro
    click; juicy LEGO-chip clatter R1-R3 / plastic-bead scree R4-R6. PLASTIC branches only: metal / obsidian / earth / ice untouched.
  * "slizzy_nuclear" (U-235 fuel rod, titanium capsule): massive metal sub = noise through a 72 -> 26 Hz sweeping SVF low-pass
    (no sine oscillator) + heavy resonant titanium knock (chop.wav 0.86-1.02x) + dry Geiger-like static fission crackle
    (crackle.wav HP 3.0 kHz, 1.15-1.45x, irregular burst); slashes = ionised energy whoosh (whoosh.wav 500-1800 Hz body) +
    15-20 ms electric click; ringing-heavy shell-casing / uranium-crystal clatter R1-R3 and scree R4-R6. NUC branches only:
    the 5 earlier profiles are untouched.
  * "slizzy_glass" (v3 Crystal Glass Apple, thin-walled crystal): knife = silky glassy whistle (whoosh.wav band 2.0-6.5 kHz) +
    dry 18 ms glass nick (crackle.wav band 4-8 kHz); impact_shatter = dense springy sub punch (noise through an 88 -> 32 Hz
    sweeping SVF low-pass, no oscillator) + crunchy glass break (chop.wav 1.35-1.60x) + bright shower of fine glass
    (multi-layer crackle.wav micro transients band 2.8-9.5 kHz); R4-R5 = sparkling cascade of glass shards on stone, dead silence
    in the tension pauses, clean reverse at the end. GLASS branches only: the 6 earlier profiles are untouched.
  * "slizzy_juicy_glass" (v3.1 Crystal Glass Watermelon): the slizzy_glass voice set (GLASS = True) plus JUICY-only layers:
    a crunchier, juicier first fracture (extra low-pitched chop.wav break 1.18-1.32x + a dense 0.3 s crackle.wav 'crunch'
    burst band 1.2-6.5 kHz) and a sparkling marble scatter in R4-R5 (denser cascade + bright 5-11 kHz glass ticks bouncing on
    stone). Noise / sample based only (no oscillators); every earlier profile, slizzy_glass included, renders bit-identically.
  * --audio-profile (recipe.audioProfile): "obsidian" (default, unchanged) | "metal_crystal" (gold bar / emerald core):
    R1-R2 heavy chop.wav (pitch 0.96-1.08, 120-260 Hz body accent) + dry emerald chip from crackle.wav (15-28 ms, HP 2.4 kHz, -8 dB);
    dense runs crossfade into HP 2.4 kHz crystal crumb (no synthetic sines anywhere); pour R4 pitch 0.98-1.10, R5 pitch 1.22-1.40 + 5-9 kHz accent;
    drop = pure sub punch 85 -> 30 Hz + 12 ms muffled chop.wav tick (LP 1.8 kHz).
    All v8 protections (dt crossfade, chop.wav off in pour, 120 ms pour_end fade, -1.0 dBFS, no clipping) apply to both profiles.
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
PROFILE = 'obsidian'  # set from --audio-profile
OBS = False  # True for 'slizzy_obsidian' (volcanic glass + stone timbre of the v2 engine)
EARTH = False  # True for 'slizzy_earth' (tectonic planet split + magma)
ICE = False  # True for 'slizzy_ice' (cryo ice sphere: dry ice block + glassy ice crunch)
PLASTIC = False  # True for 'slizzy_plastic' (Rubik's cube: hard ABS clicks + LEGO rattle)
NUC = False  # True for 'slizzy_nuclear' (uranium fuel rod: titanium knock + Geiger crackle)
GLASS = False  # True for 'slizzy_glass' (v3 crystal glass apple: crystal whistle + glass shatter)
JUICY = False  # True for 'slizzy_juicy_glass' (v3.1 crystal watermelon: slizzy_glass + juicy crunch + marble sparkle); implies GLASS


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


def voice_drop_metal(mix, t, inten, rnd):
    """Massive dull thud of a gold ingot on the table: pure sub punch 85 -> 30 Hz (fast decay, no sustained tone)
    + a 12 ms muffled contact tick from chop.wav (low-pass 1.8 kHz). No synthetic bell/ring."""
    mix.add(t, sweep_sine(85.0, 30.0, 0.4, rate=6.0, decay=9.0), 1.0 * inten)
    if BANK.get('chop'):
        tick = biquad(play(BANK['chop'], 0.9, 0.0, 0.012), 'lp', 1800.0)
        mix.add(t, fade_out(tick, 0.004), 0.5 * inten)


def voice_drop(mix, t, inten, rnd):
    if PROFILE == 'metal_crystal':
        return voice_drop_metal(mix, t, inten, rnd)
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
        if PROFILE == 'metal_crystal':  # dry crystalline emerald crumb: HP 2.4 kHz, pitch 1.15-1.35, no tonal content
            x = biquad(crackle(rnd, rnd.uniform(0.012, 0.022), rnd.uniform(1.15, 1.35)), 'hp', 2400.0)
        else:
            x = biquad(crackle(rnd, rnd.uniform(0.012, 0.022), rnd.uniform(0.95, 1.25)), 'hp', 900.0)
        mix.add(t + rnd.uniform(-0.15, 1.0) * span, x, gain * rnd.uniform(0.45, 1.0), rnd.uniform(-0.7, 0.7))
        STATS['glass_grains'] += 1


def voice_chop(mix, t, inten, tool, dt, phase, rnd, round_idx=0):
    pan = rnd.uniform(-0.25, 0.25)
    stone = tool in ('STEEL', '1000°C THERMAL')
    pitch = rnd.uniform(1.12, 1.25) if stone else rnd.uniform(1.2, 1.38)
    metal = PROFILE == 'metal_crystal' and round_idx < 2  # R1-R2: heavy/medium gold strikes
    if metal:
        pitch = rnd.uniform(0.96, 1.08)
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
        if metal:  # heavy body accent 120-260 Hz, no ringing peak
            bd = biquad(x, 'bp', 190.0, 0.8)
            x = [a + 0.4 * b for a, b in zip(x, bd)]
        mix.add(t, x, 0.8 * g * w, pan)
        STATS['chop_played'] += 1
    if w < 1.0:  # replaces the tonal chop body with a non-tonal glass/stone scatter
        glass_grains(mix, t, dt, 0.75 * g * (1.0 - w), rnd)
        if w == 0.0:
            STATS['chop_replaced'] += 1
    if metal and dt >= 0.06:  # short dry emerald crystal chip (15-28 ms, HP 2.4 kHz, -8 dB); dense runs use glass_grains instead
        chip = biquad(crackle(rnd, rnd.uniform(0.015, 0.028), rnd.uniform(1.15, 1.35)), 'hp', 2400.0)
        mix.add(t + 0.002, fade_out(chip, 0.006), 0.8 * g * 10 ** (-8 / 20) * min(1.0, dt / 0.14), pan)
        STATS['crystal_chip'] = STATS.get('crystal_chip', 0) + 1
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
        if PROFILE == 'metal_crystal':  # brighter, sparkling metal/crystal powder
            pitch = rnd.uniform(1.22, 1.40) if fine else rnd.uniform(0.98, 1.10)
        dur = rnd.uniform(0.05, 0.11) if fine else rnd.uniform(0.08, 0.16)
        x = crackle(rnd, dur, pitch)
        if fine:
            x = biquad(x, 'hp', 1800.0)  # silky fine sand
            if PROFILE == 'metal_crystal':  # delicate high-shelf accent 5-9 kHz
                sh = biquad(biquad(x, 'hp', 5000.0, 0.7), 'lp', 9000.0, 0.7)
                x = [a + 0.35 * b for a, b in zip(x, sh)]
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



# ---- v2.0 "slizzy_metal" voices (levitate -> slash -> silence -> impact_shatter -> rewind) -----------------------------
# No synthetic tonal bells, no chainsaw: blades = whoosh.wav (HP 1.2 kHz) + 15-25 ms crackle.wav crystal tick;
# fans = 3 layered whooshes + airy band noise; impacts = 85 -> 28 Hz sub punch + tiered shatter layers; finale = reversed
# avalanche + reversed whoosh that lands exactly on the loop point.
def hp_whoosh(rnd, pitch, dur):
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'lp', 1800.0)
    x = biquad(x, 'hp', 1200.0)
    x = x[:int(dur * SR)]
    return fade_out(x, min(0.06, dur * 0.3))


def tick(rnd, lo=0.015, hi=0.025, hp=2400.0, pitch=(1.15, 1.35)):
    return fade_out(biquad(crackle(rnd, rnd.uniform(lo, hi), rnd.uniform(*pitch)), 'hp', hp), 0.005)


def air(rnd, dur, f_hp=4000.0, f_lp=10000.0, attack=0.03):
    n = int(dur * SR)
    x = biquad(biquad(noise(n, rnd), 'hp', f_hp, 0.7), 'lp', f_lp, 0.7)
    for i in range(n):
        u = i / SR
        x[i] *= min(1.0, u / attack) * math.exp(-max(0.0, u - attack) / (dur * 0.35))
    return x


def hot_whoosh(rnd, pitch, dur):
    """slizzy_obsidian: denser 'fire' whoosh: whoosh.wav body band-limited to 400-900 Hz + a thin airy top (HP 1.2 kHz)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'lp', 1800.0)
    body = biquad(biquad(x, 'hp', 400.0), 'lp', 900.0)
    top = biquad(x, 'hp', 1200.0)
    n = min(len(x), int(dur * SR))
    out = [1.6 * body[i] + 0.35 * top[i] for i in range(n)]
    return fade_out(out, min(0.06, dur * 0.3))


def deep_whoosh(rnd, pitch, dur):
    """slizzy_earth: deep 'energy' whoosh: whoosh.wav pitched down, 220-950 Hz body + faint airy top (HP 1.5 kHz)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.7 * SR), rnd), 'lp', 1200.0)
    body = biquad(biquad(x, 'hp', 220.0), 'lp', 950.0)
    top = biquad(x, 'hp', 1500.0)
    n = min(len(x), int(dur * SR))
    out = [1.8 * body[i] + 0.25 * top[i] for i in range(n)]
    return fade_out(out, min(0.07, dur * 0.3))


def frost_whoosh(rnd, pitch, dur):
    """slizzy_ice: sharp frosty cutting whistle: whoosh.wav with its 1.0-2.4 kHz band accented + thin airy top (HP 2.4 kHz)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'lp', 2400.0)
    body = biquad(biquad(x, 'hp', 1000.0), 'lp', 2400.0)
    top = biquad(x, 'hp', 2400.0)
    low = biquad(x, 'lp', 1000.0)
    n = min(len(x), int(dur * SR))
    out = [1.7 * body[i] + 0.3 * top[i] + 0.25 * low[i] for i in range(n)]
    return fade_out(out, min(0.05, dur * 0.3))


def freeze_click(rnd):
    """slizzy_ice: short dry freeze click (crackle.wav 15-22 ms, HP 2.4 kHz, pitch 1.12-1.30)."""
    return tick(rnd, 0.015, 0.022, 2400.0, (1.12, 1.3))


def ice_crack(rnd, dur=0.03):
    """slizzy_ice: crisp glassy ice split (crackle.wav, HP 2.4 kHz, pitch 1.12-1.30)."""
    return fade_out(biquad(crackle(rnd, dur, rnd.uniform(1.12, 1.3)), 'hp', 2400.0), 0.01)


def magma_hiss(rnd, dur, pitch=(0.85, 1.05)):
    """slizzy_earth: dense magma hiss / rock crumble: overlapping crackle.wav grains (band 900 Hz - 7 kHz), decaying."""
    n = int(dur * SR)
    out = [0.0] * n
    tau = 0.0
    while tau < dur * 0.85:
        g = biquad(biquad(crackle(rnd, rnd.uniform(0.03, 0.08), rnd.uniform(*pitch)), 'hp', 900.0), 'lp', 7000.0)
        g = fade_out(g, 0.01)
        i0 = int(tau * SR)
        e = math.exp(-tau / (dur * 0.4)) * rnd.uniform(0.5, 1.0)
        for k in range(min(len(g), n - i0)):
            out[i0 + k] += g[k] * e
        tau += rnd.uniform(0.008, 0.022)
    return out


def heat_crackle(mix, rnd, t, inten, n=1):
    """short crackle.wav 'heat' crackle (18-35 ms, HP 1.6 kHz, pitch 0.9-1.1)."""
    for k in range(n):
        mix.add(t + 0.011 * k, tick(rnd, 0.018, 0.035, 1600.0, (0.9, 1.1)), 0.42 * inten, rnd.uniform(-0.5, 0.5))


def band(x, lo=1400.0, hi=5800.0):
    return biquad(biquad(x, 'hp', lo), 'lp', hi)


def plastic_punch(rnd, dur=0.2, f0=105.0, f1=36.0):
    """slizzy_plastic: short dry springy punch: white noise through a Chamberlin SVF low-pass whose cutoff sweeps f0 -> f1
    (exponential), 2 ms attack, ~45 ms decay. Band-limited noise, not an oscillator: no tonal sine body."""
    n = int(dur * SR)
    out, lo, bp = [0.0] * n, 0.0, 0.0
    q = 1.0 / 1.1
    for i in range(n):
        u = i / n
        fc = f0 * (f1 / f0) ** u
        f = 2.0 * math.sin(math.pi * fc / SR)
        x = rnd.uniform(-1.0, 1.0)
        hp = x - lo - q * bp
        bp += f * hp
        lo += f * bp
        tt = i / SR
        out[i] = lo * min(1.0, tt / 0.002) * math.exp(-tt / 0.045)
    pk = max(1e-9, max(abs(v) for v in out))
    return fade_out([v / pk for v in out], 0.03)


def micro_click(rnd, lo=0.012, hi=0.018, pitch=(1.1, 1.35)):
    """slizzy_plastic: 12-18 ms hard-plastic micro click (crackle.wav band-passed 1.4-5.8 kHz)."""
    return fade_out(band(crackle(rnd, rnd.uniform(lo, hi), rnd.uniform(*pitch))), 0.004)


def plastic_click(rnd, dur=0.06, pitch=(1.18, 1.35)):
    """slizzy_plastic: snappy dry ABS click: chop.wav 1.18-1.35x, dense attack, short tail (HP 700 Hz)."""
    if not BANK.get('chop'):
        return micro_click(rnd)
    return fade_out(biquad(play(BANK['chop'], rnd.uniform(*pitch), 0.0, dur), 'hp', 700.0), dur * 0.45)


def plastic_rattle(rnd, dur, density=90.0):
    """slizzy_plastic: fast cascade of hard plastic pieces (overlapping band-passed crackle.wav grains), decaying."""
    n = int(dur * SR)
    out = [0.0] * n
    tau = 0.0
    while tau < dur * 0.9:
        g = micro_click(rnd, 0.008, 0.02)
        i0 = int(tau * SR)
        e = math.exp(-tau / (dur * 0.3)) * rnd.uniform(0.45, 1.0)
        for k in range(min(len(g), n - i0)):
            out[i0 + k] += g[k] * e
        tau += rnd.uniform(0.5, 1.5) / density
    return out


def plastic_whoosh(rnd, pitch, dur):
    """slizzy_plastic: fast sharp plastic slice: whoosh.wav with its 1.2-3.0 kHz band accented + thin airy top (HP 3 kHz)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'lp', 3000.0)
    body = biquad(biquad(x, 'hp', 1200.0), 'lp', 3000.0)
    top = biquad(x, 'hp', 3000.0)
    low = biquad(x, 'lp', 1200.0)
    n = min(len(x), int(dur * SR))
    out = [1.7 * body[i] + 0.3 * top[i] + 0.18 * low[i] for i in range(n)]
    return fade_out(out, min(0.05, dur * 0.3))


def nuclear_sub(rnd, dur=0.6, f0=72.0, f1=26.0, decay=0.13):
    """slizzy_nuclear: massive metal sub punch: white noise through a Chamberlin SVF low-pass whose cutoff sweeps f0 -> f1
    (exponential), 2 ms attack, long decay. Band-limited noise, not an oscillator: no tonal sine body."""
    n = int(dur * SR)
    out, lo, bp = [0.0] * n, 0.0, 0.0
    q = 1.0 / 1.2
    for i in range(n):
        u = i / n
        fc = f0 * (f1 / f0) ** u
        f = 2.0 * math.sin(math.pi * fc / SR)
        hp = rnd.uniform(-1.0, 1.0) - lo - q * bp
        bp += f * hp
        lo += f * bp
        tt = i / SR
        out[i] = lo * min(1.0, tt / 0.002) * math.exp(-tt / decay)
    pk = max(1e-9, max(abs(v) for v in out))
    return fade_out([v / pk for v in out], 0.05)


def geiger(rnd, dur=0.02, pitch=(1.15, 1.45)):
    """slizzy_nuclear: one dry static 'Geiger' click / fission crack (crackle.wav HP 3.0 kHz, pitch 1.15-1.45)."""
    return fade_out(biquad(crackle(rnd, dur, rnd.uniform(*pitch)), 'hp', 3000.0), min(0.006, dur * 0.4))


def geiger_burst(mix, rnd, t, length, rate, gain):
    """Irregular (exponential-gap) burst of Geiger clicks, rate decaying over `length`."""
    tau = 0.0
    while tau < length:
        env = math.exp(-tau / (length * 0.45))
        mix.add(t + tau, geiger(rnd, rnd.uniform(0.006, 0.016)), gain * env * rnd.uniform(0.5, 1.0), rnd.uniform(-0.8, 0.8))
        tau += rnd.expovariate(rate * (0.3 + 0.7 * env))


def metal_knock(rnd, pitch=(0.86, 1.02), dur=None, lp=2800.0):
    """slizzy_nuclear: heavy resonant titanium-capsule knock (chop.wav 0.86-1.02x, LP)."""
    if not BANK.get('chop'):
        return geiger(rnd)
    return biquad(fade_out(play(BANK['chop'], rnd.uniform(*pitch), 0.0, dur), 0.1 if dur is None else dur * 0.4), 'lp', lp)


def ion_whoosh(rnd, pitch, dur):
    """slizzy_nuclear: deep ionised energy whoosh: whoosh.wav 500-1800 Hz body + faint airy top (HP 2.5 kHz)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'lp', 1800.0)
    body = biquad(biquad(x, 'hp', 500.0), 'lp', 1800.0)
    top = biquad(x, 'hp', 2500.0)
    n = min(len(x), int(dur * SR))
    out = [1.75 * body[i] + 0.25 * top[i] for i in range(n)]
    return fade_out(out, min(0.06, dur * 0.3))


def zap(rnd):
    """slizzy_nuclear: 15-20 ms electric click (crackle.wav, HP 3.0 kHz)."""
    return geiger(rnd, rnd.uniform(0.015, 0.02), (1.2, 1.4))


# ---- slizzy_glass (v3 Crystal Glass Apple) -----------------------------------------------------------
def bandpass(x, lo, hi):
    """Two cascaded RBJ biquads: HP lo + LP hi (band-limited, no resonance peak)."""
    return biquad(biquad(x, 'hp', lo), 'lp', hi)


def crystal_whistle(rnd, pitch, dur):
    """Silky, sharp glassy knife whistle: whoosh.wav restricted to 2.0-6.5 kHz (+ a faint 6.5 kHz air sheen)."""
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(0.6 * SR), rnd), 'hp', 2000.0)
    body = bandpass(x, 2000.0, 6500.0)
    top = biquad(x, 'hp', 6500.0)
    n = min(len(x), int(dur * SR))
    out = [1.8 * body[i] + 0.2 * top[i] for i in range(n)]
    return fade_out(out, min(0.06, dur * 0.3))


def glass_nick(rnd, dur=0.018, pitch=(1.15, 1.4)):
    """Dry glass incision: one 18 ms crackle.wav impulse band-limited to 4-8 kHz."""
    return fade_out(bandpass(crackle(rnd, dur, rnd.uniform(*pitch)), 4000.0, 8000.0), min(0.006, dur * 0.4))


def glass_grain(rnd, lo=0.006, hi=0.016, pitch=(1.2, 1.6)):
    """Micro transient of fine glass: crackle.wav band 2.8-9.5 kHz."""
    return fade_out(bandpass(crackle(rnd, rnd.uniform(lo, hi), rnd.uniform(*pitch)), 2800.0, 9500.0), 0.004)


def glass_break(rnd, pitch=(1.35, 1.6), dur=None):
    """Crunchy glass fracture body: chop.wav pitched 1.35-1.60x (HP 700 Hz keeps it crisp, no boom)."""
    if not BANK.get('chop'):
        return glass_grain(rnd, 0.03, 0.05)
    return biquad(fade_out(play(BANK['chop'], rnd.uniform(*pitch), 0.0, dur), 0.06 if dur is None else dur * 0.4), 'hp', 700.0)


def glass_shower(mix, rnd, t, length, rate, gain, spread=0.85):
    """Bright shower of fine glass: irregular (exponential-gap) layered micro transients, rate decaying over `length`."""
    tau = 0.0
    while tau < length:
        env = math.exp(-tau / (length * 0.4))
        mix.add(t + tau, glass_grain(rnd), gain * env * rnd.uniform(0.45, 1.0), rnd.uniform(-spread, spread))
        STATS['v2_grains'] = STATS.get('v2_grains', 0) + 1
        tau += rnd.expovariate(rate * (0.3 + 0.7 * env))


def glass_slash(mix, t, inten, rnd):
    mix.add(t - 0.09, crystal_whistle(rnd, rnd.uniform(1.0, 1.12), 0.32), 0.6 * inten, rnd.uniform(-0.3, 0.3))
    mix.add(t, glass_nick(rnd), 0.5 * inten, rnd.uniform(-0.2, 0.2))
    mix.add(t + 0.009, glass_nick(rnd, 0.012), 0.26 * inten, rnd.uniform(-0.4, 0.4))
    STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1


def glass_blitz(mix, t, inten, idx, n, dur, rnd):
    """R4/R5 single-blitz: ONE knife per event -> an accelerating machine-gun of crisp separate cuts.
    Per stroke: a short (<= 0.8 x stroke) glassy whistle that rises in pitch with the tempo, a sharp glass nick on contact and two
    micro glass grains. Nothing outlasts its own stroke interval, so strokes never smear into a hum."""
    k = idx / max(1.0, n - 1.0)  # 0 -> 1 across the burst (tempo ramps up)
    wd = max(0.04, min(0.1, dur * 0.95))
    pitch = (1.0 + 0.5 * k) * rnd.uniform(0.97, 1.03)
    if BANK.get('whoosh'):
        x = bandpass(play(BANK['whoosh'], pitch, rnd.uniform(0.0, 0.12), wd), 2400.0 + 600.0 * k, 7500.0)
    else:
        x = bandpass(noise(int(wd * SR), rnd), 2400.0, 7500.0)
    m = len(x)
    a, r = max(1, int(m * 0.25)), max(1, int(m * 0.5))
    for i in range(m):  # sharp attack, quick release: reads as a single "swish"
        x[i] *= (0.5 - 0.5 * math.cos(math.pi * i / a)) if i < a else 1.0
        if i >= m - r:
            x[i] *= 0.5 + 0.5 * math.cos(math.pi * (i - (m - r)) / r)
    pan = rnd.uniform(-0.45, 0.45)
    mix.add(t - 0.55 * wd, x, (0.5 + 0.12 * k) * inten * 1.6, pan)
    mix.add(t, glass_nick(rnd, 0.014, (1.2 + 0.25 * k, 1.45 + 0.25 * k)), (0.55 + 0.1 * k) * inten, pan * 0.6)
    mix.add(t + 0.006, glass_grain(rnd, 0.005, 0.01, (1.3, 1.7)), 0.3 * inten, rnd.uniform(-0.6, 0.6))
    mix.add(t + 0.015, glass_grain(rnd, 0.004, 0.008, (1.4, 1.8)), 0.2 * inten, rnd.uniform(-0.6, 0.6))
    STATS['v2_blitz'] = STATS.get('v2_blitz', 0) + 1


def glass_fan(mix, t, inten, blades, rnd):
    if blades <= 1:  # the v3 hook is a single chef-knife stroke (timeline tags hook passes as fan_slash)
        return glass_slash(mix, t, inten, rnd)
    for k, (p, off, pan) in enumerate(((0.98, -0.014, -0.55), (1.1, 0.0, 0.0), (1.22, 0.011, 0.55))):
        mix.add(t - 0.09 + off, crystal_whistle(rnd, p * rnd.uniform(0.97, 1.03), 0.36), (0.38 if k != 1 else 0.46) * inten, pan)
    for k in range(3):
        mix.add(t + 0.01 * k, glass_nick(rnd), 0.32 * inten, rnd.uniform(-0.6, 0.6))
    mix.add(t - 0.03, air(rnd, 0.36, 4000.0, 9500.0), 0.1 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
    STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1


def glass_cascade(rnd, length, density):
    """R4-R5: sparkling cascade of thousands of glass shards on stone (stereo): band-passed 2.8-9.5 kHz grains + a few
    heavier chunk clinks (chop.wav 1.4-1.6x, short) + a silky high glass-dust bed. Returns (L, R)."""
    n = int(length * SR) + int(0.2 * SR)
    L, R = [0.0] * n, [0.0] * n

    def put(off, x, g, pan):
        i0 = int(off * SR)
        a = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4.0
        gl, gr = math.cos(a) * g, math.sin(a) * g
        for k in range(min(len(x), n - i0)):
            L[i0 + k] += x[k] * gl
            R[i0 + k] += x[k] * gr
    tau = 0.0
    while tau < length:
        env = math.exp(-tau / (length * 0.36))
        if rnd.random() < 0.06 and BANK.get('chop'):
            put(tau, glass_break(rnd, (1.4, 1.6), 0.05), 0.16 * env, rnd.uniform(-0.8, 0.8))
        else:
            put(tau, glass_grain(rnd, 0.008, 0.03, (1.15, 1.55)), 0.3 * env * rnd.uniform(0.5, 1.0), rnd.uniform(-0.9, 0.9))
        STATS['v2_grains'] = STATS.get('v2_grains', 0) + 1
        tau += rnd.uniform(0.5, 1.5) / (density * (0.25 + 0.75 * env))
    for ch in (L, R):
        bed = bandpass(noise(int(length * SR), rnd), 4500.0, 9500.0)
        for i in range(len(bed)):
            u = i / SR
            ch[i] += bed[i] * min(1.0, u / 0.015) * math.exp(-u / (length * 0.3)) * 0.07
    return L, R


def juicy_crunch(mix, rnd, t, length, gain):
    """slizzy_juicy_glass: dense crisp-wet crunch of the first fracture (crackle.wav grains band 1.2-6.5 kHz, 4-14 ms, tight gaps)."""
    tau = 0.0
    while tau < length:
        env = math.exp(-tau / (length * 0.35))
        x = fade_out(bandpass(crackle(rnd, rnd.uniform(0.004, 0.014), rnd.uniform(0.85, 1.2)), 1200.0, 6500.0), 0.003)
        mix.add(t + tau, x, gain * env * rnd.uniform(0.5, 1.0), rnd.uniform(-0.5, 0.5))
        STATS['juicy_crunch'] = STATS.get('juicy_crunch', 0) + 1
        tau += rnd.expovariate(260.0 * (0.35 + 0.65 * env))


def marble_tick(rnd):
    """slizzy_juicy_glass: bright glass bead bouncing on polished marble (crackle.wav band 5-11 kHz, 3-7 ms)."""
    return fade_out(bandpass(crackle(rnd, rnd.uniform(0.003, 0.007), rnd.uniform(1.4, 1.9)), 5000.0, 11000.0), 0.002)


def glass_impact(mix, t, tier, rnd, boost):
    """slizzy_glass impact_shatter: springy noise sub 88 -> 32 Hz + crunchy glass break + bright fine-glass shower."""
    mix.add(t, nuclear_sub(rnd, 0.45, 88.0, 32.0, 0.09), (0.9 + 0.07 * min(tier, 4)) * boost)
    mix.add(t, glass_break(rnd), 0.8 * boost, -0.15)
    mix.add(t + 0.003, glass_nick(rnd, 0.02, (1.1, 1.3)), 0.55 * boost, 0.2)
    aval = None
    if tier <= 1:  # two thick crystal halves: second break + a short shower
        mix.add(t + 0.06, glass_break(rnd, (1.4, 1.6), 0.12), 0.55 * boost, 0.25)
        glass_shower(mix, rnd, t + 0.008, 0.45, 70.0, 0.36 * boost)
        if JUICY:  # juicy watermelon glass: lower crunchy break body + dense crackle crunch on the first fracture
            mix.add(t + 0.012, glass_break(rnd, (1.18, 1.32), 0.16), 0.5 * boost, -0.3)
            juicy_crunch(mix, rnd, t + 0.004, 0.32, 0.42 * boost)
    elif tier == 2:  # cascade of breaks + dense shower
        for k in range(5):
            mix.add(t + rnd.uniform(0.03, 0.3), glass_break(rnd, (1.4, 1.6), 0.08), 0.3 * math.exp(-k / 4.0), rnd.uniform(-0.6, 0.6))
        glass_shower(mix, rnd, t + 0.006, 0.7, 120.0, 0.36)
    else:  # dense noise thump + sparkling glass avalanche
        nb = int(0.3 * SR)
        boom = biquad(noise(nb, rnd), 'lp', 170.0)
        for i in range(nb):
            boom[i] *= math.exp(-(i / SR) / 0.08)
        mix.add(t, boom, 1.8)
        length = 3.2 if tier >= 4 else 1.9
        aval = glass_cascade(rnd, length, (300.0 if tier >= 4 else 200.0) if JUICY else (260.0 if tier >= 4 else 170.0))
        if JUICY:  # sparkling marble scatter: bright beads bouncing on polished stone (stereo, decaying)
            tau = 0.0
            while tau < length * 0.85:
                env = math.exp(-tau / (length * 0.32))
                mix.add(t + 0.02 + tau, marble_tick(rnd), 0.22 * env * rnd.uniform(0.4, 1.0), rnd.uniform(-0.95, 0.95))
                STATS['marble_tick'] = STATS.get('marble_tick', 0) + 1
                tau += rnd.expovariate(150.0 * (0.25 + 0.75 * env))
        i0 = int((t + 0.008) * SR)
        for k in range(min(len(aval[0]), mix.n - i0)):
            mix.L[i0 + k] += aval[0][k]
            mix.R[i0 + k] += aval[1][k]
    STATS['v2_impact'] = STATS.get('v2_impact', 0) + 1
    return aval


def glass_clatter(mix, t, count, inten, rnd, rnd_idx=0):
    if rnd_idx <= 2:  # R1-R3: ringing crystal chunks on stone (bright clinks + a short high chop.wav knock)
        for _ in range(min(3, count)):
            mix.add(t + rnd.uniform(0.0, 0.014), glass_grain(rnd, 0.012, 0.026, (1.2, 1.45)), 0.14 + 0.26 * inten, rnd.uniform(-0.7, 0.7))
        if inten > 0.35:
            mix.add(t, glass_break(rnd, (1.45, 1.6), 0.06), 0.18 * inten, rnd.uniform(-0.5, 0.5))
    else:  # R4-R5: fine glass scree
        for _ in range(min(2, count)):
            mix.add(t + rnd.uniform(0.0, 0.01), glass_grain(rnd, 0.006, 0.014, (1.3, 1.6)), 0.07 + 0.14 * inten, rnd.uniform(-0.85, 0.85))
    STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1


def v2_slash(mix, t, inten, rnd):
    if GLASS:
        return glass_slash(mix, t, inten, rnd)
    if NUC:
        mix.add(t - 0.09, ion_whoosh(rnd, rnd.uniform(0.92, 1.04), 0.36), 0.64 * inten, rnd.uniform(-0.3, 0.3))
        mix.add(t, zap(rnd), 0.42 * inten, rnd.uniform(-0.2, 0.2))
        mix.add(t + 0.01, zap(rnd), 0.24 * inten, rnd.uniform(-0.4, 0.4))
        STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1
        return
    if PLASTIC:
        mix.add(t - 0.08, plastic_whoosh(rnd, rnd.uniform(1.08, 1.2), 0.3), 0.62 * inten, rnd.uniform(-0.3, 0.3))
        mix.add(t, micro_click(rnd), 0.46 * inten, rnd.uniform(-0.2, 0.2))
        mix.add(t + 0.008, micro_click(rnd), 0.26 * inten, rnd.uniform(-0.4, 0.4))
        STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1
        return
    if ICE:
        mix.add(t - 0.09, frost_whoosh(rnd, rnd.uniform(1.0, 1.1), 0.34), 0.62 * inten, rnd.uniform(-0.3, 0.3))
        mix.add(t, freeze_click(rnd), 0.42 * inten, rnd.uniform(-0.2, 0.2))
        mix.add(t + 0.009, freeze_click(rnd), 0.26 * inten, rnd.uniform(-0.4, 0.4))
        STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1
        return
    if EARTH:
        mix.add(t - 0.1, deep_whoosh(rnd, rnd.uniform(0.84, 0.94), 0.4), 0.62 * inten, rnd.uniform(-0.3, 0.3))
        heat_crackle(mix, rnd, t - 0.01, inten, 3)
        mix.add(t, tick(rnd, 0.02, 0.035, 1100.0, (0.8, 0.95)), 0.36 * inten, rnd.uniform(-0.2, 0.2))
        STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1
        return
    if OBS:
        mix.add(t - 0.09, hot_whoosh(rnd, rnd.uniform(1.0, 1.12), 0.34), 0.6 * inten, rnd.uniform(-0.3, 0.3))
        heat_crackle(mix, rnd, t - 0.01, inten, 2)
        mix.add(t, tick(rnd), 0.4 * inten, rnd.uniform(-0.2, 0.2))
        STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1
        return
    mix.add(t - 0.09, hp_whoosh(rnd, rnd.uniform(1.15, 1.3), 0.32), 0.62 * inten, rnd.uniform(-0.3, 0.3))
    mix.add(t, tick(rnd), 0.55 * inten, rnd.uniform(-0.2, 0.2))
    if BANK.get('chop'):  # metallic "shink" transient: ultra-short, high-passed (no tonal body)
        sh = biquad(play(BANK['chop'], 1.6, 0.0, 0.03), 'hp', 3000.0)
        mix.add(t + 0.002, fade_out(sh, 0.01), 0.3 * inten)
    STATS['v2_slash'] = STATS.get('v2_slash', 0) + 1


def v2_fan(mix, t, inten, blades, rnd):
    if GLASS:
        return glass_fan(mix, t, inten, blades, rnd)
    if NUC:
        for k, (p, off, pan) in enumerate(((0.88, -0.015, -0.55), (0.98, 0.0, 0.0), (1.08, 0.012, 0.55))):
            mix.add(t - 0.09 + off, ion_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.4), (0.4 if k != 1 else 0.5) * inten, pan)
        for k in range(3):
            mix.add(t + 0.011 * k, zap(rnd), 0.3 * inten, rnd.uniform(-0.6, 0.6))
        mix.add(t - 0.03, air(rnd, 0.38, 2500.0, 8000.0), 0.1 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
        STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1
        return
    if PLASTIC:
        for k, (p, off, pan) in enumerate(((1.0, -0.014, -0.55), (1.12, 0.0, 0.0), (1.24, 0.011, 0.55))):
            mix.add(t - 0.08 + off, plastic_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.34), (0.4 if k != 1 else 0.48) * inten, pan)
        for k in range(3):
            mix.add(t + 0.01 * k, micro_click(rnd), 0.34 * inten, rnd.uniform(-0.6, 0.6))
        mix.add(t - 0.03, air(rnd, 0.34, 3000.0, 9000.0), 0.12 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
        STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1
        return
    if ICE:
        for k, (p, off, pan) in enumerate(((0.96, -0.015, -0.55), (1.06, 0.0, 0.0), (1.16, 0.012, 0.55))):
            mix.add(t - 0.09 + off, frost_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.38), (0.4 if k != 1 else 0.48) * inten, pan)
        for k in range(3):
            mix.add(t + 0.011 * k, freeze_click(rnd), 0.32 * inten, rnd.uniform(-0.6, 0.6))
        mix.add(t - 0.03, air(rnd, 0.38, 2400.0, 8000.0), 0.12 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
        STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1
        return
    if EARTH:
        for k, (p, off, pan) in enumerate(((0.74, -0.018, -0.55), (0.86, 0.0, 0.0), (0.98, 0.014, 0.55))):
            mix.add(t - 0.1 + off, deep_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.44), (0.42 if k != 1 else 0.5) * inten, pan)
        heat_crackle(mix, rnd, t - 0.02, inten, 5)
        mix.add(t - 0.03, air(rnd, 0.4, 2400.0, 7000.0), 0.1 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
        STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1
        return
    if OBS:
        for k, (p, off, pan) in enumerate(((0.92, -0.015, -0.55), (1.05, 0.0, 0.0), (1.18, 0.012, 0.55))):
            mix.add(t - 0.09 + off, hot_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.38), (0.4 if k != 1 else 0.48) * inten, pan)
        heat_crackle(mix, rnd, t - 0.02, inten, 4)
        mix.add(t - 0.03, air(rnd, 0.38, 3000.0, 9000.0), 0.14 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
        STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1
        return
    for k, (p, off, pan) in enumerate(((1.0, -0.015, -0.55), (1.15, 0.0, 0.0), (1.3, 0.012, 0.55))):
        mix.add(t - 0.09 + off, hp_whoosh(rnd, p * rnd.uniform(0.97, 1.03), 0.36), (0.42 if k != 1 else 0.5) * inten, pan)
    for k in range(3):
        mix.add(t + 0.012 * k, tick(rnd), 0.38 * inten, rnd.uniform(-0.6, 0.6))
    mix.add(t - 0.03, air(rnd, 0.38), 0.2 * inten * min(1.0, 0.5 + blades / 16.0), rnd.uniform(-0.2, 0.2))
    STATS['v2_fan'] = STATS.get('v2_fan', 0) + 1


def avalanche(rnd, length, density, fine, glass=False):
    """Stereo ASMR cascade of crystal grains + silky metal-powder bed. Returns (L, R)."""
    n = int(length * SR) + int(0.2 * SR)
    L, R = [0.0] * n, [0.0] * n

    def put(off, x, g, pan):
        i0 = int(off * SR)
        a = (max(-1.0, min(1.0, pan)) + 1.0) * math.pi / 4.0
        gl, gr = math.cos(a) * g, math.sin(a) * g
        for k in range(min(len(x), n - i0)):
            L[i0 + k] += x[k] * gl
            R[i0 + k] += x[k] * gr
    tau = 0.0
    while tau < length:
        env = math.exp(-tau / (length * 0.38))
        pitch = rnd.uniform(1.1, 1.4) if fine else rnd.uniform(0.95, 1.25)
        if glass:  # crisp volcanic-glass scree
            pitch = rnd.uniform(1.05, 1.3)
        if EARTH:  # falling rock + cooling magma: lower, fuller grains
            pitch = rnd.uniform(0.82, 1.05)
        if ICE:  # rolling ice chunks + crystalline ice crumb: bright, scattered
            pitch = rnd.uniform(1.08, 1.3)
        if PLASTIC:  # hard ABS / LEGO chips: short, bright, band-passed 1.4-5.8 kHz
            x = band(crackle(rnd, rnd.uniform(0.012, 0.035), rnd.uniform(1.1, 1.35)))
        elif NUC:  # metal shell casings + uranium crystals: heavier grains with a bright ringing top
            x = biquad(crackle(rnd, rnd.uniform(0.02, 0.07), rnd.uniform(0.95, 1.3)), 'hp', 1500.0)
        else:
            x = biquad(crackle(rnd, rnd.uniform(0.03, 0.09), pitch), 'hp', 2400.0 if ICE else 1000.0 if EARTH else 2800.0 if glass else 1800.0 if fine else 1200.0)
        put(tau, fade_out(x, 0.01), 0.3 * env * rnd.uniform(0.5, 1.0), rnd.uniform(-0.85, 0.85))
        STATS['v2_grains'] = STATS.get('v2_grains', 0) + 1
        tau += rnd.uniform(0.5, 1.5) / (density * (0.25 + 0.75 * env))
    bed = biquad(biquad(noise(int(length * SR), rnd), 'hp', 3000.0, 0.7), 'lp', 9000.0, 0.7)
    bed2 = biquad(biquad(noise(int(length * SR), rnd), 'hp', 3000.0, 0.7), 'lp', 9000.0, 0.7)
    for i in range(len(bed)):
        u = i / SR
        e = min(1.0, u / 0.02) * math.exp(-u / (length * 0.32)) * 0.11
        L[i] += bed[i] * e
        R[i] += bed2[i] * e
    return L, R


def chop_pitch(rnd, lo, hi=None):
    """chop.wav pitch: original range (slizzy_metal, identical rnd use) or the lower, heavier 0.78-0.92x (slizzy_obsidian)."""
    if ICE:
        return rnd.uniform(1.04, 1.16)
    if EARTH:
        return rnd.uniform(0.72, 0.86)
    if OBS:
        return rnd.uniform(0.78, 0.92)
    return lo if hi is None else rnd.uniform(lo, hi)


def v2_impact_plastic(mix, t, tier, rnd, boost):
    """slizzy_plastic impact: springy noise punch 105 -> 36 Hz + snappy ABS click(s) + fast plastic rattle; R4-R6 add a LEGO avalanche."""
    mix.add(t, plastic_punch(rnd, 0.2), (0.75 + 0.08 * min(tier, 4)) * boost)
    mix.add(t, plastic_click(rnd, 0.07), 0.8 * boost, -0.15)
    mix.add(t + 0.004, micro_click(rnd, 0.012, 0.016), 0.5 * boost, 0.2)
    aval = None
    if tier <= 1:  # two halves: double click + short rattle
        mix.add(t + 0.055, plastic_click(rnd, 0.06), 0.55 * boost, 0.3)
        mix.add(t + 0.01, plastic_rattle(rnd, 0.35, 60.0), 0.45 * boost, rnd.uniform(-0.3, 0.3))
    elif tier == 2:  # cascade of snappy chop.wav clicks + dense band-passed rattle
        for k in range(6):
            mix.add(t + rnd.uniform(0.02, 0.28), plastic_click(rnd, 0.05), 0.36 * math.exp(-k / 4.0), rnd.uniform(-0.65, 0.65))
        for side in (-0.5, 0.5):
            mix.add(t + 0.008, plastic_rattle(rnd, 0.55, 110.0), 0.42, side)
    else:  # wide LEGO avalanche
        length = 3.4 if tier >= 4 else 1.9
        aval = avalanche(rnd, length, 240.0 if tier >= 4 else 150.0, tier >= 4)
        i0 = int((t + 0.01) * SR)
        for k in range(min(len(aval[0]), mix.n - i0)):
            mix.L[i0 + k] += aval[0][k]
            mix.R[i0 + k] += aval[1][k]
    STATS['v2_impact'] = STATS.get('v2_impact', 0) + 1
    return aval


def v2_impact_nuclear(mix, t, tier, rnd, boost):
    """slizzy_nuclear impact: SVF noise sub 72 -> 26 Hz + heavy titanium knock(s) + Geiger fission crackle; R4-R6 add a
    metal / uranium-crystal avalanche."""
    mix.add(t, nuclear_sub(rnd, 0.6), (0.95 + 0.08 * min(tier, 4)) * boost)
    mix.add(t, metal_knock(rnd), 0.85 * boost, -0.15)
    mix.add(t, geiger(rnd, 0.03), 0.6 * boost)
    aval = None
    if tier <= 1:  # two heavy halves: second knock + a short Geiger burst
        mix.add(t + 0.07, metal_knock(rnd, (0.9, 1.0)), 0.65 * boost, 0.25)
        geiger_burst(mix, rnd, t + 0.012, 0.5, 40.0, 0.4 * boost)
    elif tier == 2:  # cascade of knocks + denser crackle
        for k in range(5):
            mix.add(t + rnd.uniform(0.03, 0.3), metal_knock(rnd, (0.9, 1.02), 0.12, 3200.0), 0.34 * math.exp(-k / 4.0), rnd.uniform(-0.6, 0.6))
        geiger_burst(mix, rnd, t + 0.01, 0.7, 70.0, 0.4)
    else:  # heavy noise boom + wide metal / uranium avalanche + Geiger storm
        n = int(0.35 * SR)
        boom = biquad(noise(n, rnd), 'lp', 160.0)
        for i in range(n):
            boom[i] *= math.exp(-(i / SR) / 0.1)
        mix.add(t, boom, 2.0)
        length = 3.4 if tier >= 4 else 1.9
        aval = avalanche(rnd, length, 220.0 if tier >= 4 else 140.0, tier >= 4)
        i0 = int((t + 0.01) * SR)
        for k in range(min(len(aval[0]), mix.n - i0)):
            mix.L[i0 + k] += aval[0][k]
            mix.R[i0 + k] += aval[1][k]
        geiger_burst(mix, rnd, t + 0.01, 1.2 if tier >= 4 else 0.8, 90.0, 0.3)
    STATS['v2_impact'] = STATS.get('v2_impact', 0) + 1
    return aval


def v2_impact(mix, t, tier, rnd):
    boost = 10 ** (2.5 / 20) if tier <= 1 else 1.0  # R1 punch: +2.5 dB (master re-normalises to -1.0 dBFS, soft limiter = no clipping)
    if GLASS:
        return glass_impact(mix, t, tier, rnd, boost)
    if NUC:
        return v2_impact_nuclear(mix, t, tier, rnd, boost)
    if PLASTIC:
        return v2_impact_plastic(mix, t, tier, rnd, boost)
    if ICE:  # dense, dry ice-block sub punch
        mix.add(t, sweep_sine(85.0, 28.0, 0.6, rate=5.0, decay=5.5), (0.95 + 0.1 * min(tier, 4)) * boost)
    elif EARTH:  # massive tectonic sub
        mix.add(t, sweep_sine(60.0, 22.0, 0.8, rate=4.5, decay=4.5), (1.0 + 0.1 * min(tier, 4)) * boost)
    elif OBS:  # deeper, heavier stone sub
        mix.add(t, sweep_sine(75.0, 24.0, 0.65, rate=5.0, decay=5.0), (0.95 + 0.1 * min(tier, 4)) * boost)
    else:
        mix.add(t, sweep_sine(85.0, 28.0, 0.55, rate=5.0, decay=6.0), (0.9 + 0.1 * min(tier, 4)) * boost)
    chop = BANK.get('chop')
    aval = None
    if OBS:  # dry, sharp obsidian glass crack (crackle.wav, HP 2.8 kHz, pitch 1.05-1.30)
        mix.add(t, fade_out(biquad(crackle(rnd, 0.03, rnd.uniform(1.05, 1.3)), 'hp', 2800.0), 0.01), 0.7 * boost)
        mix.add(t + 0.012, fade_out(biquad(crackle(rnd, 0.022, rnd.uniform(1.05, 1.3)), 'hp', 2800.0), 0.008), 0.4 * boost, rnd.uniform(-0.5, 0.5))
    if ICE:  # crisp glass-ice split on every impact (two layered crackle.wav cracks)
        mix.add(t, ice_crack(rnd, 0.032), 0.68 * boost)
        mix.add(t + 0.011, ice_crack(rnd, 0.022), 0.4 * boost, rnd.uniform(-0.5, 0.5))
    if EARTH:  # rock split crack + dense magma hiss / crumbling rock under every impact
        mix.add(t, fade_out(biquad(crackle(rnd, 0.04, rnd.uniform(0.8, 0.95)), 'hp', 1200.0), 0.012), 0.6 * boost)
        hiss = magma_hiss(rnd, 0.9 if tier <= 2 else 0.6)
        mix.add(t + 0.02, hiss, (0.5 if tier <= 2 else 0.35) * boost, rnd.uniform(-0.3, 0.3))
    if tier <= 1:  # two heavy dull chop.wav knocks (halves) + dry crystal crunch from crackle.wav; no tonal synthesis
        if chop:
            mix.add(t, biquad(fade_out(play(chop, chop_pitch(rnd, 0.85, 0.9)), 0.1), 'lp', 2200.0), 0.85 * boost, -0.2)
            mix.add(t + 0.070, biquad(fade_out(play(chop, chop_pitch(rnd, 0.93, 0.98)), 0.1), 'lp', 2200.0), 0.65 * boost, 0.25)
            # extra attack: 9 ms bright chop.wav transient (HP 900 Hz) on the very first sample of the hit
            mix.add(t, biquad(fade_out(play(chop, 1.25, 0.0, 0.009), 0.004), 'hp', 900.0), 0.55 * boost)
        mix.add(t, fade_out(biquad(crackle(rnd, 0.035, 1.0), 'hp', 2200.0), 0.012), 0.55 * boost)
    elif tier == 2:  # dense sub + cascade of real chop.wav hits (pitch 0.95-1.20) + decaying crackle.wav scatter
        if chop:
            mix.add(t, biquad(fade_out(play(chop, chop_pitch(rnd, 0.95)), 0.1), 'lp', 3000.0), 0.8)
            for k in range(5):
                mix.add(t + rnd.uniform(0.03, 0.3), biquad(fade_out(play(chop, chop_pitch(rnd, 0.95, 1.2), 0.0, 0.12), 0.05), 'lp', 3200.0),
                        0.34 * math.exp(-k / 4.0), rnd.uniform(-0.6, 0.6))
        dt = 0.0
        for k in range(16):
            dt += rnd.uniform(0.01, 0.06) * (1 + k * 0.12)
            mix.add(t + dt, fade_out(biquad(crackle(rnd, rnd.uniform(0.02, 0.045), rnd.uniform(1.12, 1.3) if ICE else rnd.uniform(1.05, 1.3) if OBS else rnd.uniform(0.95, 1.1)), 'hp', 2400.0 if ICE else 2800.0 if OBS else 1800.0), 0.01),
                    0.5 * math.exp(-dt / 0.4), rnd.uniform(-0.75, 0.75))
    else:  # mighty bass hit + wide rustling avalanche of crystals and metal powder
        n = int(0.35 * SR)
        boom = biquad(noise(n, rnd), 'lp', 180.0)
        for i in range(n):
            boom[i] *= math.exp(-(i / SR) / 0.09)
        mix.add(t, boom, 2.2)
        if chop:
            mix.add(t, biquad(fade_out(play(chop, chop_pitch(rnd, 0.7) if (OBS or ICE) else 0.7), 0.08), 'lp', 2000.0), 0.6)
        length = 3.4 if tier >= 4 else 1.9
        aval = avalanche(rnd, length, 220.0 if tier >= 4 else 140.0, tier >= 4, glass=OBS)  # EARTH: rock grains (see avalanche)
        i0 = int((t + 0.01) * SR)
        for k in range(min(len(aval[0]), mix.n - i0)):
            mix.L[i0 + k] += aval[0][k]
            mix.R[i0 + k] += aval[1][k]
    STATS['v2_impact'] = STATS.get('v2_impact', 0) + 1
    return aval


def v2_clatter(mix, t, count, inten, rnd, rnd_idx=0):
    if GLASS:
        return glass_clatter(mix, t, count, inten, rnd, rnd_idx)
    if NUC:
        if rnd_idx <= 2:  # R1-R3: ringing-heavy titanium shell-casing clatter + a dry Geiger tick
            for _ in range(min(3, count)):
                mix.add(t + rnd.uniform(0.0, 0.016), tick(rnd, 0.016, 0.032, 1200.0, (0.92, 1.08)), 0.12 + 0.25 * inten, rnd.uniform(-0.7, 0.7))
            if inten > 0.35:
                mix.add(t, metal_knock(rnd, (0.95, 1.1), 0.08, 3000.0), 0.2 * inten, rnd.uniform(-0.5, 0.5))
            if rnd.random() < 0.4:
                mix.add(t + rnd.uniform(0.0, 0.03), geiger(rnd, 0.01), 0.12, rnd.uniform(-0.8, 0.8))
        else:  # R4-R6: bright uranium-crystal / metal-chip scree
            for _ in range(min(2, count)):
                mix.add(t + rnd.uniform(0.0, 0.012), tick(rnd, 0.01, 0.024, 2200.0, (1.05, 1.3)), 0.07 + 0.14 * inten, rnd.uniform(-0.8, 0.8))
        STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1
        return
    if PLASTIC:
        if rnd_idx <= 2:  # R1-R3: juicy LEGO-chip clatter (micro clicks + short snappy chop.wav click)
            for _ in range(min(3, count)):
                mix.add(t + rnd.uniform(0.0, 0.014), micro_click(rnd, 0.01, 0.02), 0.14 + 0.26 * inten, rnd.uniform(-0.7, 0.7))
            if inten > 0.3:
                mix.add(t, plastic_click(rnd, 0.045), 0.2 * inten, rnd.uniform(-0.5, 0.5))
        else:  # R4-R6: crisp plastic-bead scree
            for _ in range(min(2, count)):
                mix.add(t + rnd.uniform(0.0, 0.01), micro_click(rnd, 0.008, 0.016), 0.08 + 0.15 * inten, rnd.uniform(-0.8, 0.8))
        STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1
        return
    if ICE:
        if rnd_idx <= 2:  # R1-R3: ringing, crunchy ice chunks (bright crackle ticks + short dry chop.wav knock)
            for _ in range(min(3, count)):
                mix.add(t + rnd.uniform(0.0, 0.016), tick(rnd, 0.016, 0.03, 1800.0, (1.04, 1.22)), (0.12 + 0.24 * inten), rnd.uniform(-0.7, 0.7))
            if inten > 0.35 and BANK.get('chop'):
                mix.add(t, biquad(fade_out(play(BANK['chop'], rnd.uniform(1.04, 1.16), 0.0, 0.08), 0.03), 'lp', 2600.0), 0.18 * inten, rnd.uniform(-0.5, 0.5))
        else:  # R4-R6: crisp scattered ice crumb
            for _ in range(min(2, count)):
                mix.add(t + rnd.uniform(0.0, 0.012), tick(rnd, 0.01, 0.022, 2600.0, (1.15, 1.35)), 0.07 + 0.14 * inten, rnd.uniform(-0.8, 0.8))
        STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1
        return
    if EARTH:
        if rnd_idx <= 2:  # R1-R3: heavy rock clatter
            for _ in range(min(3, count)):
                mix.add(t + rnd.uniform(0.0, 0.016), tick(rnd, 0.02, 0.038, 700.0, (0.72, 0.86)), (0.12 + 0.26 * inten), rnd.uniform(-0.7, 0.7))
            if inten > 0.35 and BANK.get('chop'):
                mix.add(t, biquad(fade_out(play(BANK['chop'], rnd.uniform(0.72, 0.86), 0.0, 0.1), 0.04), 'lp', 1300.0), 0.22 * inten, rnd.uniform(-0.5, 0.5))
        else:  # R4-R6: gravel scree
            for _ in range(min(2, count)):
                mix.add(t + rnd.uniform(0.0, 0.012), tick(rnd, 0.014, 0.026, 1400.0, (0.85, 1.05)), 0.07 + 0.14 * inten, rnd.uniform(-0.8, 0.8))
        STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1
        return
    if OBS:
        if rnd_idx <= 2:  # R1-R3: heavy stone clatter (low crackle ticks + dull chop.wav knock)
            for _ in range(min(3, count)):
                mix.add(t + rnd.uniform(0.0, 0.016), tick(rnd, 0.018, 0.034, 900.0, (0.78, 0.92)), (0.12 + 0.26 * inten), rnd.uniform(-0.7, 0.7))
            if inten > 0.35 and BANK.get('chop'):
                mix.add(t, biquad(fade_out(play(BANK['chop'], rnd.uniform(0.78, 0.92), 0.0, 0.09), 0.035), 'lp', 1500.0), 0.2 * inten, rnd.uniform(-0.5, 0.5))
        else:  # R4-R6: crisp volcanic-glass scree
            for _ in range(min(2, count)):
                mix.add(t + rnd.uniform(0.0, 0.012), tick(rnd, 0.012, 0.024, 2800.0, (1.05, 1.3)), 0.07 + 0.14 * inten, rnd.uniform(-0.8, 0.8))
        STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1
        return
    for _ in range(min(3, count)):
        mix.add(t + rnd.uniform(0.0, 0.016), tick(rnd, 0.015, 0.03, 1500.0, (0.95, 1.05)), (0.1 + 0.22 * inten), rnd.uniform(-0.7, 0.7))
    if inten > 0.5 and BANK.get('chop'):
        mix.add(t, biquad(fade_out(play(BANK['chop'], rnd.uniform(0.9, 1.05), 0.0, 0.08), 0.03), 'lp', 2000.0), 0.15 * inten, rnd.uniform(-0.5, 0.5))
    STATS['v2_clatter'] = STATS.get('v2_clatter', 0) + 1


def v2_whoosh(mix, t, dur, gain, pitch, rnd):
    x = play(BANK['whoosh'], pitch) if BANK.get('whoosh') else biquad(noise(int(dur * SR), rnd), 'lp', 900.0)
    x = x[:int(dur * SR)]
    n = len(x)
    for i in range(n):
        x[i] *= min(1.0, i / (0.02 * SR)) * min(1.0, (n - i) / (0.06 * SR))
    mix.add(t, x, gain, rnd.uniform(-0.3, 0.3))


def v2_rewind(mix, t0, t1, aval, rnd):
    """Reversed avalanche (its loud head lands on t1) + two reversed rising whooshes ending exactly at t1 (= loop point 0.0 s)."""
    n = int((t1 - t0) * SR)
    i1 = int(t1 * SR)
    if aval:
        seg_l, seg_r = aval[0][:n], aval[1][:n]
        m = len(seg_l)
        for k in range(m):
            g = 0.25 + 0.75 * (k / max(1, m)) ** 2.2
            j = i1 - m + k
            if 0 <= j < mix.n:
                mix.L[j] += seg_l[m - 1 - k] * g * 0.9
                mix.R[j] += seg_r[m - 1 - k] * g * 0.9
    if BANK.get('whoosh'):
        for p, g in ((0.62, 0.55), (0.95, 0.45)):
            x = biquad(play(BANK['whoosh'], p), 'hp', 300.0)[::-1]
            mix.add(t1 - len(x) / SR, x, g, 0.0)
    STATS['v2_rewind'] = 1


def gate(mix, a, b, fade=0.03):
    """Pure silence in [a + fade, b): tension pause before the impact."""
    ia, ib, nf = int(a * SR), int(b * SR), int(fade * SR)
    for i in range(max(0, ia), min(mix.n, ib)):
        k = i - ia
        g = 0.0 if k >= nf else 0.5 + 0.5 * math.cos(math.pi * k / nf)
        mix.L[i] *= g
        mix.R[i] *= g


def main_v2(events, a):
    rnd = random.Random(a.seed)
    end = next((e['time'] for e in events if e['type'] == 'end'), max(e['time'] for e in events) + 1.0)
    total = a.duration if a.duration else end
    mix = Mix(total)
    aval_last = None
    pauses = []
    for e in events:
        t, ty, inten = e['time'], e['type'], float(e.get('intensity', 1.0))
        if ty == 'slash' and GLASS and e.get('blitz'):
            glass_blitz(mix, t, inten, int(e.get('idx', 0)), int(e.get('n', 1)), float(e.get('dur', 0.08)), rnd)
        elif ty == 'slash':
            v2_slash(mix, t, inten, rnd)
        elif ty == 'fan_slash':
            v2_fan(mix, t, inten, int(e.get('blades', 8)), rnd)
        elif ty == 'impact_shatter':
            av = v2_impact(mix, t, int(e.get('tier', 1)), rnd)
            if av:
                aval_last = av
        elif ty == 'clatter':
            if e.get('round', -1) in (0, 1, 2):
                v2_clatter(mix, t, int(e.get('count', 1)), inten, rnd, e.get('round', 0))
            elif (OBS or EARTH or ICE or PLASTIC or NUC or GLASS) and e.get('round', -1) in (3, 4, 5) and rnd.random() < 0.5:
                v2_clatter(mix, t, int(e.get('count', 1)), inten, rnd, e.get('round', 3))
        elif ty == 'transition':
            v2_whoosh(mix, t, 0.25, 0.32, 1.25, rnd)
        elif ty == 'whip':
            v2_whoosh(mix, t - 0.05, 0.45, 0.5, 1.0, rnd)
        elif ty == 'tension_pause':
            pauses.append((t, float(e['until'])))
        elif ty == 'shimmer' and GLASS:  # soft sparse glints on the settled glass pile (no dead air before the rewind)
            glass_shower(mix, rnd, t, float(e['until']) - t, 26.0, 0.1 * inten, 0.9)
        elif ty == 'rewind':
            v2_rewind(mix, t, min(total, float(e['until'])), aval_last, rnd)
    for a0, b0 in pauses:
        gate(mix, a0, b0)
    # loop seam: 10 ms fade-in at 0 and 15 ms fade-out at the end (no click when the Short loops)
    for i in range(int(0.01 * SR)):
        g = i / (0.01 * SR)
        mix.L[i] *= g
        mix.R[i] *= g
    nf = int(0.015 * SR)
    for i in range(nf):
        g = i / nf
        mix.L[mix.n - 1 - i] *= g
        mix.R[mix.n - 1 - i] *= g
    return mix, total, pauses

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
    ap.add_argument('--audio-profile', choices=['obsidian', 'metal_crystal', 'slizzy_metal', 'slizzy_obsidian', 'slizzy_earth', 'slizzy_ice', 'slizzy_plastic', 'slizzy_nuclear', 'slizzy_glass', 'slizzy_juicy_glass'], default='obsidian', help='recipe.audioProfile')
    a = ap.parse_args()
    global PROFILE, OBS, EARTH, ICE, PLASTIC, NUC, GLASS, JUICY
    PROFILE = a.audio_profile
    OBS = PROFILE == 'slizzy_obsidian'
    EARTH = PROFILE == 'slizzy_earth'
    ICE = PROFILE == 'slizzy_ice'
    PLASTIC = PROFILE == 'slizzy_plastic'
    NUC = PROFILE == 'slizzy_nuclear'
    JUICY = PROFILE == 'slizzy_juicy_glass'
    GLASS = PROFILE == 'slizzy_glass' or JUICY

    with open(a.events, encoding='utf-8') as f:
        events = sorted(json.load(f), key=lambda e: e['time'])
    rnd = random.Random(a.seed)
    for key in ('chop', 'crackle', 'whoosh'):
        BANK[key] = load_sample(key + '.wav')
    print(f'audio profile: {PROFILE}')
    print('samples: ' + ', '.join(f'{k}={"live " + os.path.basename(v["path"]) if v else "synth fallback"}' for k, v in BANK.items()))
    if PROFILE in ('slizzy_metal', 'slizzy_obsidian', 'slizzy_earth', 'slizzy_ice', 'slizzy_plastic', 'slizzy_nuclear', 'slizzy_glass', 'slizzy_juicy_glass'):
        mix, total, pauses = main_v2(events, a)
    else:
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

    for e in (events if PROFILE not in ('slizzy_metal', 'slizzy_obsidian', 'slizzy_earth', 'slizzy_ice', 'slizzy_plastic', 'slizzy_nuclear', 'slizzy_glass', 'slizzy_juicy_glass') else []):
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
            voice_chop(mix, t, inten, tool, dt, e.get('phase', ''), rnd, e.get('round', 0))
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
