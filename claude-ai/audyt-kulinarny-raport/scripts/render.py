#!/usr/bin/env python3
"""Renderer raportu z audytu kulinarnego: raport.json -> PDF (A4 poziomo, slajdy).

    python3 render.py raport.json [wynik.pdf] [--podglad katalog]

Wymaga: reportlab, Pillow. Czcionki DejaVu leżą w ../fonts obok skryptu.
Kod wyjścia 0 = PDF gotowy; 2 = PDF powstał, ale na wymienionych slajdach treść się nie mieści
albo zdjęcie zostało ściśnięte – skróć tekst lub podziel slajd i wyrenderuj ponownie.
"""
import io
import json
import math
import os
import re
import subprocess
import sys

from PIL import Image, ImageOps
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

W, H = 841.89, 595.28
M = 36
NAVY, ACCENT, BEIGE = HexColor("#202a36"), HexColor("#c2552d"), HexColor("#f3eee8")
GOOD, WARN, BAD = HexColor("#2e7d4f"), HexColor("#c98a1b"), HexColor("#b23a3a")
MUTED, INK, WHITE, PALE, LINE = HexColor("#6b7280"), HexColor("#1f2933"), HexColor("#ffffff"), HexColor("#d5dae0"), HexColor("#dcdcdc")
TONES = {"good": GOOD, "ok": GOOD, "warn": WARN, "bad": BAD, "accent": ACCENT, "dark": NAVY}

problems = []   # (numer slajdu, opis)
current = [0]


def problem(msg):
    if (current[0], msg) not in problems:
        problems.append((current[0], msg))


# ---------- czcionki ----------
def setup_fonts():
    here = os.path.dirname(os.path.abspath(__file__))
    dirs = [os.path.join(here, "..", "fonts"), "/usr/share/fonts/truetype/dejavu", "/usr/share/fonts/dejavu",
            "/Library/Fonts", "C:/Windows/Fonts"]
    try:
        import matplotlib
        dirs.append(os.path.join(os.path.dirname(matplotlib.__file__), "mpl-data", "fonts", "ttf"))
    except Exception:
        pass

    def find(name):
        for d in dirs:
            p = os.path.join(d, name)
            if os.path.exists(p):
                return p
        return None

    reg, bold = find("DejaVuSans.ttf"), find("DejaVuSans-Bold.ttf")
    if not reg or not bold:
        sys.exit("Brak czcionek DejaVuSans.ttf / DejaVuSans-Bold.ttf (powinny być w katalogu fonts skilla).")
    ital = find("DejaVuSans-Oblique.ttf") or reg
    bi = find("DejaVuSans-BoldOblique.ttf") or bold
    for n, p in (("F", reg), ("FB", bold), ("FI", ital), ("FBI", bi)):
        pdfmetrics.registerFont(TTFont(n, p))
    pdfmetrics.registerFontFamily("F", normal="F", bold="FB", italic="FI", boldItalic="FBI")


# ---------- tekst ----------
def fmt(s):
    s = str("" if s is None else s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", s)
    s = re.sub(r"(^|[\s(])_([^_\n]+)_(?=[\s).,;:]|$)", r"\1<i>\2</i>", s)
    return s.replace("\n", "<br/>")


def para(text, size=9, color=INK, bold=False, italic=False, align=0, lead=1.45, raw=False):
    st = ParagraphStyle("p", fontName="FB" if bold else ("FI" if italic else "F"), fontSize=size, leading=size * lead,
                        textColor=color, alignment=align, splitLongWords=True)
    return Paragraph(text if raw else fmt(text), st)


def tone(name, default=None):
    return TONES.get(name, default)


# ---------- elementy układu ----------
class Item:
    flex = False

    def min_h(self, w):
        return 0

    def draw(self, c, x, top, w, h):
        pass


class Para(Item):
    def __init__(self, p):
        self.p = p

    def min_h(self, w):
        return self.p.wrap(w, 10000)[1]

    def draw(self, c, x, top, w, h):
        ph = self.p.wrap(w, 10000)[1]
        self.p.drawOn(c, x, top - ph)


class Gap(Item):
    def __init__(self, h):
        self.h = h

    def min_h(self, w):
        return self.h


class Spacer(Item):
    flex = True


class Rule(Item):
    def min_h(self, w):
        return 3.5

    def draw(self, c, x, top, w, h):
        c.setFillColor(ACCENT)
        c.rect(x, top - 3.5, 60, 3.5, stroke=0, fill=1)


class Bullets(Item):
    def __init__(self, items, color):
        self.ps = [para(i) for i in items]
        self.color = color

    def min_h(self, w):
        return sum(p.wrap(w - 15, 10000)[1] for p in self.ps) + 4 * (len(self.ps) - 1)

    def draw(self, c, x, top, w, h):
        y = top
        for p in self.ps:
            ph = p.wrap(w - 15, 10000)[1]
            c.setFillColor(self.color)
            c.rect(x, y - 3.4 - 6.5, 6.5, 6.5, stroke=0, fill=1)
            p.drawOn(c, x + 15, y - ph)
            y -= ph + 4


def score_color(v):
    try:
        n = float(str(v).replace(",", "."))
    except ValueError:
        return None
    return GOOD if n >= 4 else WARN if n >= 3 else BAD


def priority_color(v):
    s = str(v).upper()
    if re.search("WYSOK|PILN|KRYT", s):
        return BAD
    if re.search("ŚREDNI|SREDNI", s):
        return WARN
    if "NISK" in s:
        return GOOD
    return None


class Table(Item):
    def __init__(self, b):
        self.cols = [{"label": c} if isinstance(c, str) else c for c in b["columns"]]
        self.pady = 3.2 if b.get("compact") else 4.8
        self.rows = []
        al = {"left": 0, "center": 1, "right": 2}
        self.head = [para(c["label"], 8.5, WHITE, bold=True, align=al.get(c.get("align", "left"), 0)) for c in self.cols]
        for r in b["rows"]:
            row = {"cells": r} if isinstance(r, list) else r
            style = row.get("style")
            cells = []
            for i, cell in enumerate(row["cells"]):
                col = self.cols[i] if i < len(self.cols) else {}
                o = cell if isinstance(cell, dict) else {"text": cell}
                kind, size, color, bold = col.get("kind"), 8.5, INK, bool(o.get("bold"))
                if kind == "score":
                    size, bold, color = 10.5, True, score_color(o.get("text")) or INK
                elif kind == "priority":
                    bold, color = True, priority_color(o.get("text")) or INK
                elif kind == "bold":
                    bold = True
                elif kind == "small":
                    size = 7.8
                if o.get("tone"):
                    bold, color = True, tone(o["tone"], color)
                if style in ("sum", "strong", "accent", "dark"):
                    bold = True
                if style in ("accent", "dark"):
                    color = WHITE
                cells.append(para(o.get("text", ""), size, color, bold=bold, align=al.get(col.get("align", "left"), 0)))
            self.rows.append((style, cells))

    def widths(self, w):
        given = [c.get("width") for c in self.cols]
        free = [g for g in given if not g]
        rest = max(0.0, 100 - sum(g for g in given if g))
        return [w * (g if g else rest / max(1, len(free))) / 100 for g in given]

    def layout(self, w):
        ws = self.widths(w)
        hh = max(p.wrap(max(10, cw - 12), 10000)[1] for p, cw in zip(self.head, ws)) + 9
        rhs = [max([p.wrap(max(10, ws[i] - 12), 10000)[1] for i, p in enumerate(cells) if i < len(ws)] or [10]) + 2 * self.pady
               for _, cells in self.rows]
        return ws, hh, rhs

    def min_h(self, w):
        _, hh, rhs = self.layout(w)
        return hh + sum(rhs)

    def draw(self, c, x, top, w, h):
        ws, hh, rhs = self.layout(w)
        c.setFillColor(NAVY)
        c.rect(x, top - hh, w, hh, stroke=0, fill=1)
        cx = x
        for p, cw in zip(self.head, ws):
            ph = p.wrap(max(10, cw - 12), 10000)[1]
            p.drawOn(c, cx + 6, top - (hh + ph) / 2)
            cx += cw
        y = top - hh
        for n, ((style, cells), rh) in enumerate(zip(self.rows, rhs)):
            bg = ACCENT if style == "accent" else NAVY if style == "dark" else BEIGE if n % 2 == 1 else None
            if bg:
                c.setFillColor(bg)
                c.rect(x, y - rh, w, rh, stroke=0, fill=1)
            if style == "sum":
                c.setStrokeColor(NAVY)
                c.setLineWidth(1)
                c.line(x, y, x + w, y)
            cx = x
            for i, p in enumerate(cells):
                if i >= len(ws):
                    break
                ph = p.wrap(max(10, ws[i] - 12), 10000)[1]
                p.drawOn(c, cx + 6, y - (rh + ph) / 2)
                cx += ws[i]
            y -= rh


class Kpis(Item):
    def __init__(self, b):
        self.items = b["items"]
        self.n = b.get("columns") or len(self.items)

    def card_h(self):
        return 9 + 11.6 + 23.8 + (10.2 if any(k.get("note") for k in self.items) else 0) + 8

    def min_h(self, w):
        rows = math.ceil(len(self.items) / self.n)
        return rows * self.card_h() + (rows - 1) * 12

    def draw(self, c, x, top, w, h):
        ch = self.card_h()
        cw = (w - 12 * (self.n - 1)) / self.n
        for i, k in enumerate(self.items):
            cx = x + (i % self.n) * (cw + 12)
            cy = top - (i // self.n) * (ch + 12)
            c.setFillColor(BEIGE)
            c.roundRect(cx, cy - ch, cw, ch, 6, stroke=0, fill=1)
            c.setFillColor(MUTED)
            c.setFont("F", 8)
            c.drawString(cx + 12, cy - 9 - 8, str(k.get("label", "")))
            size, val = 19, str(k.get("value", ""))
            while size > 9 and pdfmetrics.stringWidth(val, "FB", size) > cw - 24:
                size -= 1
            c.setFillColor(tone(k.get("tone"), NAVY))
            c.setFont("FB", size)
            c.drawString(cx + 12, cy - 9 - 11.6 - 18.5, val)
            if k.get("note"):
                c.setFillColor(MUTED)
                c.setFont("F", 7)
                note, limit = str(k["note"]), cw - 24
                while len(note) > 4 and pdfmetrics.stringWidth(note, "F", 7) > limit:
                    note = note[:-2].rstrip() + "…"
                c.drawString(cx + 12, cy - 9 - 11.6 - 23.8 - 7.5, note)


_images = {}


def load_image(src, base):
    path = src if os.path.isabs(src) else os.path.join(base, src)
    if path not in _images:
        if not os.path.exists(path):
            sys.exit(f"Brak pliku zdjęcia: {path}")
        try:
            im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        except Exception as e:
            sys.exit(f"Nie udało się otworzyć zdjęcia {path} ({e}). Użyj JPG/PNG/WEBP – HEIC przekonwertuj wcześniej.")
        im.thumbnail((1600, 1600))   # zdjęcia z telefonu mają po kilka MB
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
        buf.seek(0)
        _images[path] = (ImageReader(buf), im.size[0], im.size[1])
    return _images[path]


def parse_position(pos):
    px = py = 0.5
    toks = str(pos or "center").split()
    vals = []
    for t in toks:
        if t == "left":
            px = 0.0
        elif t == "right":
            px = 1.0
        elif t == "top":
            py = 0.0
        elif t == "bottom":
            py = 1.0
        elif t.endswith("%"):
            vals.append((len(vals) if len(toks) > 1 else 0, float(t[:-1]) / 100))
        else:
            vals.append((None, None))
    if len(toks) == 2:
        for idx, t in enumerate(toks):
            if t.endswith("%"):
                if idx == 0:
                    px = float(t[:-1]) / 100
                else:
                    py = float(t[:-1]) / 100
    elif len(toks) == 1 and toks[0].endswith("%"):
        px = float(toks[0][:-1]) / 100
    return px, py


def draw_cover(c, img, x, y, w, h, pos, radius=0):
    reader, iw, ih = img
    s = max(w / iw, h / ih)
    dw, dh = iw * s, ih * s
    px, py = parse_position(pos)
    c.saveState()
    p = c.beginPath()
    if radius:
        p.roundRect(x, y, w, h, radius)
    else:
        p.rect(x, y, w, h)
    c.clipPath(p, stroke=0, fill=0)
    c.drawImage(reader, x - (dw - w) * px, y - (dh - h) * (1 - py), dw, dh)
    c.restoreState()


class Img(Item):
    flex = True

    def __init__(self, b, base):
        self.img = load_image(b["src"], base)
        self.pos = b.get("position")
        self.cap = b.get("caption")
        self.fixed = b.get("height")
        if self.fixed:
            self.flex = False

    def min_h(self, w):
        return (self.fixed or 60) + (15 if self.cap else 0)

    def draw(self, c, x, top, w, h):
        ih = h - (15 if self.cap else 0)
        if ih < 90:
            problem("zdjęcie ściśnięte poniżej 90 pt")
        if ih > 5:
            draw_cover(c, self.img, x, top - ih, w, ih, self.pos, 6)
        if self.cap:
            c.setFillColor(MUTED)
            c.setFont("F", 7.5)
            c.drawString(x, top - ih - 11.5, str(self.cap))


class Imgs(Item):
    flex = True

    def __init__(self, b, base):
        self.items = [Img(i, base) for i in b["items"]]

    def min_h(self, w):
        return max(i.min_h(w) for i in self.items)

    def draw(self, c, x, top, w, h):
        n = len(self.items)
        iw = (w - 10 * (n - 1)) / n
        for k, i in enumerate(self.items):
            i.draw(c, x + k * (iw + 10), top, iw, h)


class Cards(Item):
    flex = True

    def __init__(self, b):
        self.n = b.get("columns") or 3
        self.items = [(para(i["title"], 9.5, INK, bold=True, lead=1.3), para(i["text"], 8.8, INK, lead=1.55)) for i in b["items"]]

    def content_h(self, cw):
        return max(3.5 + 10 + max(18, t.wrap(cw - 24 - 30, 10000)[1]) + 10 + p.wrap(cw - 24, 10000)[1] + 10 for t, p in self.items)

    def geom(self, w):
        return (w - 12 * (self.n - 1)) / self.n, math.ceil(len(self.items) / self.n)

    def min_h(self, w):
        cw, rows = self.geom(w)
        return rows * self.content_h(cw) + 12 * (rows - 1)

    def draw(self, c, x, top, w, h):
        cw, rows = self.geom(w)
        ch = (h - 12 * (rows - 1)) / rows
        if ch < self.content_h(cw) - 1:
            problem("treść się nie mieści")
        for i, (t, p) in enumerate(self.items):
            cx = x + (i % self.n) * (cw + 12)
            cy = top - (i // self.n) * (ch + 12)
            c.setFillColor(BEIGE)
            c.roundRect(cx, cy - ch, cw, ch, 6, stroke=0, fill=1)
            c.rect(cx, cy - 8, cw, 8, stroke=0, fill=1)
            c.setFillColor(ACCENT)
            c.rect(cx, cy - 3.5, cw, 3.5, stroke=0, fill=1)
            c.setFont("FB", 15)
            c.drawString(cx + 12, cy - 3.5 - 10 - 13, f"{i + 1:02d}")
            th = t.wrap(cw - 24 - 30, 10000)[1]
            t.drawOn(c, cx + 12 + 30, cy - 3.5 - 10 - 2.5 - th)
            head = max(18, th)
            ph = p.wrap(cw - 24, 10000)[1]
            p.drawOn(c, cx + 12, cy - 3.5 - 10 - head - 10 - ph)


class Panel(Item):
    """Ramka z tekstem: ciemna (callout) albo beżowa (box)."""

    def __init__(self, ps, bg):
        self.ps, self.bg = ps, bg

    def min_h(self, w):
        return sum(p.wrap(w - 24, 10000)[1] for p in self.ps) + 2 * (len(self.ps) - 1) + 19

    def draw(self, c, x, top, w, h):
        mh = self.min_h(w)
        c.setFillColor(self.bg)
        c.roundRect(x, top - mh, w, mh, 6, stroke=0, fill=1)
        y = top - 9.5
        for p in self.ps:
            ph = p.wrap(w - 24, 10000)[1]
            p.drawOn(c, x + 12, y - ph)
            y -= ph + 2


class Stack(Item):
    def __init__(self, items, gap=9):
        self.items, self.gap = items, gap
        self.flex = any(i.flex for i in items)

    def min_h(self, w):
        return sum(i.min_h(w) for i in self.items) + self.gap * max(0, len(self.items) - 1)

    def draw(self, c, x, top, w, h):
        extra = h - self.min_h(w)
        if extra < -1.5:
            problem("treść się nie mieści")
        flex = [i for i in self.items if i.flex]
        share = max(0, extra) / len(flex) if flex else 0
        y = top
        for i in self.items:
            ih = i.min_h(w) + (share if i.flex else 0)
            i.draw(c, x, y, w, ih)
            y -= ih + self.gap


class Cols(Item):
    flex = True

    def __init__(self, cols, base):
        self.cols = [(float(col.get("width") or 1), Stack(build(col.get("blocks"), base))) for col in cols]

    def widths(self, w):
        total = sum(k for k, _ in self.cols)
        free = w - 30 * (len(self.cols) - 1)
        return [free * k / total for k, _ in self.cols]

    def min_h(self, w):
        return max(s.min_h(cw) for (_, s), cw in zip(self.cols, self.widths(w)))

    def draw(self, c, x, top, w, h):
        cx = x
        for (_, s), cw in zip(self.cols, self.widths(w)):
            s.draw(c, cx, top, cw, h)
            cx += cw + 30


def build(blocks, base):
    out = []
    for b in blocks or []:
        t = b.get("type")
        if b.get("heading") and t != "heading":
            out.append(Para(para(b["heading"], 12, tone(b.get("tone"), ACCENT), bold=True, lead=1.3)))
        if t == "heading":
            out.append(Para(para(b["text"], 12, tone(b.get("tone"), ACCENT), bold=True, lead=1.3)))
        elif t == "text":
            large = b.get("size") == "large"
            out.append(Para(para(b["text"], 10.5 if large else 9, lead=1.5 if large else 1.45)))
        elif t == "bullets":
            out.append(Bullets(b["items"], tone(b.get("tone"), ACCENT)))
        elif t == "table":
            out.append(Table(b))
        elif t == "kpis":
            out.append(Kpis(b))
        elif t == "image":
            out.append(Img(b, base))
        elif t == "images":
            out.append(Imgs(b, base))
        elif t == "cards":
            out.append(Cards(b))
        elif t == "callout":
            out.append(Panel([para(b["text"], 9, WHITE)], NAVY))
        elif t == "box":
            ps = [para(b["text"], 9, INK, italic=b.get("italic", True))]
            if b.get("note"):
                ps.append(para(b["note"], 9, MUTED))
            out.append(Panel(ps, BEIGE))
        elif t == "spacer":
            out.append(Spacer())
        else:
            sys.exit(f"Nieznany typ bloku: {t}")
    return out


# ---------- slajdy ----------
def dark_slide(c, s, report, base):
    cover = s["type"] == "cover"
    iw = (s.get("imageWidth") or (47 if cover else 40)) / 100 * W if s.get("image") else 0
    lw = W - iw
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    if s.get("image"):
        draw_cover(c, load_image(s["image"], base), lw, 0, iw, H, s.get("imagePosition"))
    items = [Para(para(report.get("brand", ""), 10.5, WHITE, bold=True)), Gap(16), Rule()]
    if cover:
        items += [Gap(54), Para(para(s.get("kicker", ""), 11, PALE)), Gap(6), Para(para(s.get("title", ""), 34, WHITE, bold=True, lead=1.25))]
        if s.get("subtitle"):
            items.append(Para(para(s["subtitle"], 19, WHITE, bold=True, lead=1.3)))
        items.append(Gap(40))
        for b in s.get("bullets") or []:
            items += [Para(para("—  " + fmt(b), 10, PALE, raw=True)), Gap(5.5)]
        items += [Spacer(), Para(para("<br/>".join(fmt(m) for m in s.get("meta") or []), 8.5, PALE, lead=1.7, raw=True))]
    else:
        items += [Gap(40), Para(para(s.get("title", ""), 27, WHITE, bold=True, lead=1.25)), Gap(18),
                  Para(para(s.get("text", ""), 11.5, WHITE, lead=1.5)), Spacer()]
        if s.get("next"):
            items += [Para(para(s.get("nextTitle") or "Następny krok", 10.5, WHITE, bold=True)), Gap(8), Para(para(s["next"], 9.5, PALE))]
        items.append(Spacer())
        if s.get("disclaimer"):
            items.append(Para(para(s["disclaimer"], 6.8, HexColor("#9aa3ad"), lead=1.5)))
    Stack(items, gap=0).draw(c, 40, H - 58, lw - 80, H - 58 - 44)


def content_slide(c, s, report, base, n):
    c.setFillColor(NAVY)
    c.rect(0, H - 62, W, 62, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H - 66, W, 4, stroke=0, fill=1)
    brand, sec = str(report.get("brand", "")), str(s.get("section", ""))
    right = max(pdfmetrics.stringWidth(brand, "FB", 9), pdfmetrics.stringWidth(sec, "F", 8))
    title, size = str(s.get("title", "")), 19
    while size > 12 and pdfmetrics.stringWidth(title, "FB", size) > W - 2 * M - right - 24:
        size -= 0.5
    c.setFillColor(WHITE)
    c.setFont("FB", size)
    c.drawString(M, H - 31 - size * 0.36, title)
    c.setFont("FB", 9)
    c.drawRightString(W - M, H - 29, brand)
    c.setFont("F", 8)
    c.drawRightString(W - M, H - 43, sec)

    c.setStrokeColor(LINE)
    c.setLineWidth(1)
    c.line(M, 30, W - M, 30)
    c.setFillColor(MUTED)
    c.setFont("F", 7.5)
    c.drawString(M, 12.5, str(report.get("footer", "")))
    c.drawRightString(W - M, 12.5, str(n))

    items = []
    if s.get("subtitle"):
        items += [Para(para(s["subtitle"], 10.5, MUTED)), Gap(2)]
    items += build(s.get("top"), base) + build(s.get("blocks"), base)
    if s.get("columns"):
        items.append(Cols(s["columns"], base))
    items += build(s.get("bottom"), base)
    top = H - 66 - 12
    Stack(items).draw(c, M, top, W - 2 * M, top - 38)


def preview(pdf, outdir):
    os.makedirs(outdir, exist_ok=True)
    try:
        import fitz
        doc = fitz.open(pdf)
        for i, page in enumerate(doc):
            page.get_pixmap(dpi=96).save(os.path.join(outdir, f"slajd-{i + 1:02d}.png"))
        return True
    except Exception:
        pass
    try:
        subprocess.run(["pdftoppm", "-png", "-r", "96", pdf, os.path.join(outdir, "slajd")], check=True, capture_output=True)
        return True
    except Exception:
        return False


def main():
    args = sys.argv[1:]
    prev = None
    if "--podglad" in args:
        i = args.index("--podglad")
        prev = args[i + 1]
        del args[i:i + 2]
    if not args:
        sys.exit("Użycie: python3 render.py raport.json [wynik.pdf] [--podglad katalog]")
    src = os.path.abspath(args[0])
    with open(src, encoding="utf-8") as f:
        report = json.load(f)
    base = os.path.dirname(src)
    out = os.path.abspath(args[1] if len(args) > 1 else report.get("output") or re.sub(r"\.json$", "", src) + ".pdf")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    setup_fonts()
    c = canvas.Canvas(out, pagesize=(W, H))
    c.setTitle(str(report.get("title") or report.get("footer") or "Raport"))
    c.setAuthor(str(report.get("brand", "")))
    for n, s in enumerate(report["slides"], 1):
        current[0] = n
        if s.get("type") in ("cover", "closing"):
            dark_slide(c, s, report, base)
        else:
            content_slide(c, s, report, base, n)
        c.showPage()
    c.save()
    print(f"PDF: {out} ({len(report['slides'])} slajdów, {os.path.getsize(out) // 1024} kB)")
    if prev:
        print(f"Podgląd PNG: {os.path.abspath(prev)}" if preview(out, prev) else "Podgląd PNG pominięty (brak PyMuPDF i pdftoppm).")
    if problems:
        print("UWAGA – slajdy do poprawy: " + "; ".join(f"{n}: {m}" for n, m in problems), file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
