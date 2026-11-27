"""v4 HUD overlay (Pillow): per-frame transparent RGBA PNGs composited by FFmpeg.

bright-marble style (v3.1 light theme): charcoal ink with a soft white halo for titles, dark
translucent pills for the bait lines (gold / white text), every line fitted to 92% of the width
so nothing is clipped in 9:16. Bottom 20% of the frame always stays clear.
"""
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = "/System/Library/Fonts/SFNS.ttf"
EMOJI = "/System/Library/Fonts/Apple Color Emoji.ttc"
EMOJI_STRIKE = 160


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Fonts:
    def __init__(self):
        self.cache = {}
        self.emoji = ImageFont.truetype(EMOJI, EMOJI_STRIKE)

    def get(self, size, weight="Black"):
        key = (size, weight)
        if key not in self.cache:
            f = ImageFont.truetype(FONT, size)
            try:
                f.set_variation_by_name(weight)
            except Exception:
                pass
            self.cache[key] = f
        return self.cache[key]


def _is_emoji(ch):
    return ord(ch) >= 0x1F000 or 0x2600 <= ord(ch) <= 0x27BF


def _runs(text):
    runs, cur, emo = [], "", None
    for ch in text:
        e = _is_emoji(ch)
        if ch == "️":
            continue
        if emo is None or e == emo:
            cur += ch
        else:
            runs.append((cur, emo))
            cur = ch
        emo = e
    if cur:
        runs.append((cur, emo))
    return runs


def text_image(fonts, text, size, color, weight="Black"):
    """Render mixed text + colour emoji on a transparent canvas (tight-ish box)."""
    font = fonts.get(size, weight)
    asc, desc = font.getmetrics()
    h = asc + desc
    parts = []
    for run, emo in _runs(text):
        if emo:
            for ch in run:
                im = Image.new("RGBA", (EMOJI_STRIKE * 2, EMOJI_STRIKE * 2), (0, 0, 0, 0))
                ImageDraw.Draw(im).text((0, 0), ch, font=fonts.emoji, embedded_color=True)
                im = im.crop(im.getbbox() or (0, 0, 1, 1))
                s = int(size * 1.05)
                im = im.resize((max(1, int(im.width * s / im.height)), s), Image.LANCZOS)
                parts.append(("img", im))
        else:
            w = int(font.getlength(run))
            im = Image.new("RGBA", (max(1, w), h), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((0, 0), run, font=font, fill=(*color, 255))
            parts.append(("txt", im))
    W = sum(p.width for _, p in parts) + int(size * 0.12) * max(0, len(parts) - 1)
    out = Image.new("RGBA", (max(1, W), h), (0, 0, 0, 0))
    x = 0
    for kind, im in parts:
        y = (h - im.height) // 2 if kind == "img" else 0
        out.alpha_composite(im, (x, max(0, y)))
        x += im.width + int(size * 0.12)
    bb = out.getbbox() or (0, 0, 1, 1)
    return out.crop((0, bb[1], out.width, bb[3]))


class HUD:
    def __init__(self, cues, W, H):
        self.c, self.W, self.H = cues, W, H
        self.st = cues["style"]
        self.fonts = Fonts()
        self.cache = {}

    def _fit_size(self, text, rel, pad=0.0, weight="Black"):
        size = int(self.H * rel)
        maxw = self.W * 0.92 - pad
        while size > 8:
            if text_image(self.fonts, text, size, (0, 0, 0), weight).width <= maxw:
                return size
            size = int(size * 0.94)
        return size

    def _title(self, text, rel):
        key = ("title", text, rel)
        if key not in self.cache:
            size = self._fit_size(text, rel)
            ink = text_image(self.fonts, text, size, _rgb(self.st["ink"]))
            pad = int(size * 0.35)
            size2 = (ink.width + 2 * pad, ink.height + 2 * pad)
            halo = Image.new("RGBA", size2, (0, 0, 0, 0))
            mask = Image.new("L", size2, 0)
            mask.paste(ink.getchannel("A"), (pad, pad))
            for r, a in ((size * 0.22, 0.55), (size * 0.07, 0.95)):
                # blur the alpha only, then fill with pure white: a clean halo, no grey fringe
                m = mask.filter(ImageFilter.GaussianBlur(r)).point(lambda v, a=a: min(255, int(v * a * 2.4)))
                g = Image.new("RGBA", size2, (255, 255, 255, 0))
                g.putalpha(m)
                halo.alpha_composite(g)
            halo.alpha_composite(ink, (pad, pad))
            self.cache[key] = halo
        return self.cache[key]

    def _pill(self, text, rel, color, weight="Heavy"):
        key = ("pill", text, rel, color)
        if key not in self.cache:
            px, py = int(self.H * 0.026), int(self.H * 0.011)
            size = self._fit_size(text, rel, 2 * px, weight)
            ink = text_image(self.fonts, text, size, _rgb(color), weight)
            w, h = ink.width + 2 * px, ink.height + 2 * py
            sh = int(h * 0.35)
            im = Image.new("RGBA", (w + 2 * sh, h + 2 * sh), (0, 0, 0, 0))
            shadow = Image.new("RGBA", im.size, (0, 0, 0, 0))
            ImageDraw.Draw(shadow).rounded_rectangle((sh, sh + h * 0.08, sh + w, sh + h), radius=h // 2,
                                                     fill=(20, 16, 12, 80))
            im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(sh * 0.5)))
            ImageDraw.Draw(im).rounded_rectangle((sh, sh, sh + w, sh + h), radius=h // 2, fill=tuple(self.st["pill"]))
            im.alpha_composite(ink, (sh + px, sh + py))
            self.cache[key] = im
        return self.cache[key]

    def _alpha(self, t, a, b):
        f = self.st["fade"]
        if t < a or t >= b:
            return 0.0
        k = 1.0
        if a > 0.0:
            k = min(k, (t - a) / f)
        if b < self.c.get("duration", 1e9) - 1e-6:
            k = min(k, (b - t) / f)
        return max(0.0, min(1.0, k))

    def _place(self, frame, im, top, alpha):
        if alpha <= 0.0:
            return
        if alpha < 1.0:
            im = im.copy()
            im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
        x = (self.W - im.width) // 2
        y = int(self.H * top - im.height * 0.18)
        frame.alpha_composite(im, (x, max(0, y)))

    def frame(self, t):
        st = self.st
        out = Image.new("RGBA", (self.W, self.H), (0, 0, 0, 0))
        hk = self.c["hook"]
        a = max(self._alpha(t, s, e) for s, e in hk["show"])
        if a > 0:
            self._place(out, self._title(hk["title"], st["hook_size"]), st["hook_top"], a)
            self._place(out, self._pill(hk["badge"], st["badge_size"], st["pill_gold"]), st["badge_top"], a)
        for lb in self.c["labels"]:
            a = self._alpha(t, *lb["t"])
            if a > 0:
                im = (self._pill(lb["text"], st["label_size"] * 0.8, st["pill_gold"], "Black") if lb.get("bonus")
                      else self._title(lb["text"], st["label_size"]))
                self._place(out, im, st["label_top"], a)
        fn = self.c["final"]
        a = self._alpha(t, *fn["t"])
        if a > 0:
            self._place(out, self._pill(fn["text"], st["final_size"], st["pill_text"]), st["final_top"], a)
        return out


def render_overlays(cues, W, H, fps, n_frames, out_dir, duration):
    os.makedirs(out_dir, exist_ok=True)
    cues = dict(cues, duration=duration)
    hud = HUD(cues, W, H)
    for i in range(n_frames):
        hud.frame(i / fps).save(os.path.join(out_dir, f"{i + 1:05d}.png"), compress_level=1)
    return n_frames
