"""Finds a licensed header image for a place on Wikimedia Commons, crops and
enhances it to a target size, and burns in an attribution watermark.

Claude does the parts that need judgement — disambiguating the place name,
looking at the candidates and picking one, deciding where the crop sits. The
parts that must not be guessed are plain Python: the Commons queries, the
licence and size filtering, and the Pillow processing. That split is deliberate.
The system prompt says "never invent author or licence details", and the only
way to guarantee that is for the model never to be the one writing them down —
it picks a file title, and the metadata travels with the file.

The card and the hero are searched independently. A photo that crops well to
2:1 often has nothing left at 3.1:1, so each target gets its own candidate.
"""

import collections
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageOps

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
# Commons rejects anonymous clients, so identify the app on every request.
USER_AGENT = "VisitHistoryImageHelper/1.0 (place header image tool)"
HTTP_TIMEOUT = 45
HTTP_RETRIES = 2
# Wikimedia rate-limits bursts, and the card and the hero both want the same
# multi-megabyte original. Space requests out and remember the last few files.
MIN_REQUEST_GAP = 0.35
CACHE_MAX_BYTES = 96 * 1024 * 1024

MODEL = "claude-opus-5"
MAX_CANDIDATES_TO_VIEW = 6
VIEW_THUMB_WIDTH = 800
MAX_TURNS = 12

# Titles that are almost never a usable header photo. Cheap pre-filter only —
# the real judgement is Claude looking at the thumbnails.
TITLE_BLOCKLIST = re.compile(
    r"\b(map|plan|diagram|coat of arms|arms of|logo|blazon|"
    r"information board|interpretation board|plaque|signpost|"
    r"floorplan|ground plan|survey|chart|sketch|engraving|"
    # Scanned book illustrations: wide, so they sort to the top of the picker
    r"woodcut|lithograph|etching|illustration|frontispiece|"
    r"figure \d|fig\.? ?\d|plate \d)\b",
    re.I,
)
# Internet Archive book scans carry an identifier like "castellateddomes02macg_0489".
SCAN_ID = re.compile(r"\b[a-z]{6,}\d{2}[a-z]{2,}_\d{3,}\b", re.I)
PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png")

# Commons hosts gigapixel scans — Arbroath Abbey's widest file is 19737x14696,
# 290 megapixels — and Pillow refuses anything past ~179MP as a decompression
# bomb. These are real photographs we do want, so the ceiling is raised to a
# bounded figure and anything past it is filtered out rather than crashing.
# Decoding is kept cheap by drafting large JPEGs down on the way in.
MAX_SOURCE_PIXELS = 400_000_000
Image.MAX_IMAGE_PIXELS = MAX_SOURCE_PIXELS

# What a panel gets as a croppable source. Well beyond any target's width, so a
# tight crop still has pixels to spare, but far short of a full gigapixel scan
# that would take a gigabyte of RAM and choke the data URL going to the UI.
MAX_SLOT_EDGE = 6000


class FinderError(Exception):
    pass


# --- Wikimedia Commons ------------------------------------------------------


_cache = collections.OrderedDict()
_cache_bytes = 0
_net_lock = threading.Lock()
_last_request = [0.0]


def _throttle():
    """Keeps requests spaced out. The card and hero panels can search at the same
    time, so this is shared rather than per-search."""
    with _net_lock:
        gap = time.monotonic() - _last_request[0]
        if gap < MIN_REQUEST_GAP:
            time.sleep(MIN_REQUEST_GAP - gap)
        _last_request[0] = time.monotonic()


def _http_get(url):
    """GETs with one or two backoff retries. Wikimedia answers a burst with 429,
    and the prompt is explicit that a rate-limit is worth waiting out once
    rather than reporting as a failure."""
    for attempt in range(HTTP_RETRIES + 1):
        _throttle()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            retryable = exc.code in (429, 500, 502, 503, 504)
            if not retryable or attempt == HTTP_RETRIES:
                raise FinderError(f"HTTP {exc.code} from {urllib.parse.urlsplit(url).netloc}")
            try:
                wait = float(exc.headers.get("Retry-After") or 0)
            except (TypeError, ValueError):
                wait = 0
            time.sleep(min(max(wait, 2.0 * (attempt + 1)), 30))
        except urllib.error.URLError as exc:
            if attempt == HTTP_RETRIES:
                raise FinderError(f"Network error: {exc.reason}")
            time.sleep(2.0 * (attempt + 1))
    raise FinderError("Request failed")


def _get_json(params):
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    return json.loads(_http_get(url).decode("utf-8"))


def _get_bytes(url):
    """Cached: a place's card and hero are searched separately but often land on
    the same file, and re-downloading it is what trips the rate limit."""
    global _cache_bytes
    with _net_lock:
        if url in _cache:
            _cache.move_to_end(url)
            return _cache[url]
    data = _http_get(url)
    with _net_lock:
        _cache[url] = data
        _cache_bytes += len(data)
        while _cache_bytes > CACHE_MAX_BYTES and len(_cache) > 1:
            _cache_bytes -= len(_cache.popitem(last=False)[1])
    return data


_IMAGEINFO_PARAMS = {
    "action": "query",
    "prop": "imageinfo",
    "iiprop": "url|size|extmetadata|mime",
    "iiextmetadatafilter": (
        "LicenseShortName|LicenseUrl|Artist|DateTimeOriginal|ImageDescription"
    ),
    "format": "json",
}
# Titles per request when filling in thumbnails. The API allows 50 anonymously;
# 40 keeps the URL comfortably short.
THUMB_BATCH = 40


def _strip_html(value):
    if not value:
        return ""
    text = re.sub(r"<[^>]+>", " ", value)
    text = text.replace("&amp;", "&").replace("&nbsp;", " ").replace("&quot;", '"')
    return " ".join(text.split())


def _meta(info, key):
    return _strip_html((info.get("extmetadata") or {}).get(key, {}).get("value", ""))


PAGE_SIZE = 50


def add_thumbnails(candidates, width):
    """Fills in `thumburl` for the candidates we are actually going to show.

    Thumbnails are fetched separately, and only for files already established to
    be photographs. Asking the listing request for a thumbnail of a PDF fails the
    *whole* query with `urlparamnormal` — one scanned book in a category wipes
    out the entire search — so the listing never asks. Doing it here also means
    Commons renders thumbnails for the dozen candidates on screen rather than
    every file in the category.
    """
    photos = [c for c in candidates if c["title"].lower().endswith(PHOTO_EXTENSIONS)]
    for start in range(0, len(photos), THUMB_BATCH):
        batch = photos[start:start + THUMB_BATCH]
        try:
            data = _get_json({
                "action": "query",
                "format": "json",
                "titles": "|".join(c["title"] for c in batch),
                "prop": "imageinfo",
                "iiprop": "url",
                "iiurlwidth": str(int(width)),
            })
        except FinderError:
            continue  # a missing thumbnail is not worth failing the search over
        by_title = {}
        for page in ((data.get("query") or {}).get("pages") or {}).values():
            infos = page.get("imageinfo") or []
            if infos and infos[0].get("thumburl"):
                by_title[page.get("title")] = infos[0]["thumburl"]
        for c in batch:
            c["thumburl"] = by_title.get(c["title"], c["thumburl"])
    return candidates


def commons_query(query, mode="category", max_files=PAGE_SIZE):
    """Lists files by Commons category, or by full-text search as the fallback.

    No thumbnails here — see add_thumbnails() for why.

    max_files follows Commons' continuation until that many files are collected.
    The default is one page: the model only ever sees a shortlist, so paging for
    it would cost requests and latency for candidates it never reads. The picker
    asks for more, because there "all of them" is the point.
    """
    params = dict(_IMAGEINFO_PARAMS)
    if mode == "category":
        title = query if query.lower().startswith("category:") else f"Category:{query}"
        params.update({
            "generator": "categorymembers",
            "gcmtitle": title,
            "gcmtype": "file",
            "gcmlimit": str(PAGE_SIZE),
        })
    else:
        params.update({
            # filetype:bitmap keeps PDFs and DjVu scans out of search results
            # altogether; category listings have no equivalent filter.
            "generator": "search",
            "gsrsearch": f"{query} filetype:bitmap",
            "gsrnamespace": "6",
            "gsrlimit": str(PAGE_SIZE),
        })

    out, seen, cont = [], set(), {}
    while True:
        data = _get_json({**params, **cont})
        if "error" in data:
            raise FinderError(data["error"].get("info", "Commons API error"))
        pages = (data.get("query") or {}).get("pages") or {}
        for page in pages.values():
            infos = page.get("imageinfo") or []
            title = page.get("title", "")
            if not infos or title in seen:
                continue
            seen.add(title)
            info = infos[0]
            out.append({
                "title": title,
                "url": info.get("url", ""),
                "thumburl": info.get("thumburl", ""),
                "descriptionurl": info.get("descriptionurl", ""),
                "mime": info.get("mime", ""),
                "width": int(info.get("width") or 0),
                "height": int(info.get("height") or 0),
                "artist": _meta(info, "Artist"),
                "licence": _meta(info, "LicenseShortName"),
                "licence_url": _meta(info, "LicenseUrl"),
                "description": _meta(info, "ImageDescription")[:300],
                "date": _meta(info, "DateTimeOriginal")[:40],
            })
        cont = data.get("continue") or {}
        if not cont or len(out) >= max_files:
            break
    return out, bool(cont)


def licence_ok(short_name, allow_sharealike=True):
    """Accepts CC0, public domain, CC BY and CC BY-SA only.

    Everything else is rejected, including a blank licence and Commons'
    "no known restrictions" — the bar does not move when a search comes up
    short, because a wrong licence on a public site is not recoverable.
    """
    name = (short_name or "").strip().lower()
    if not name:
        return False
    if "nc" in re.split(r"[^a-z0-9]+", name) or "noncommercial" in name:
        return False
    if "nd" in re.split(r"[^a-z0-9]+", name) or "noderiv" in name:
        return False
    if "no known restrictions" in name or "fair use" in name:
        return False
    if "cc0" in name or "public domain" in name or name.startswith("pd"):
        return True
    if name.startswith("cc by-sa") or name.startswith("cc-by-sa"):
        return allow_sharealike
    if name.startswith("cc by") or name.startswith("cc-by"):
        return True
    return False


def filter_candidates(items, min_width, allow_sharealike=True):
    """Keeps landscape photographs, large enough not to be upscaled, that carry
    a licence we can actually use."""
    kept, rejected = [], []

    def drop(item, why):
        rejected.append({"title": item["title"], "reason": why})

    for item in items:
        title = item["title"]
        if not title.lower().endswith(PHOTO_EXTENSIONS):
            drop(item, "not a JPEG/PNG")
            continue
        if TITLE_BLOCKLIST.search(title):
            drop(item, "title suggests a map/plan/sign/illustration, not a photo")
            continue
        if SCAN_ID.search(title) or (item["artist"] or "").lower().startswith("book author"):
            drop(item, "looks like a scanned book illustration")
            continue
        if not licence_ok(item["licence"], allow_sharealike):
            drop(item, f"licence not usable: {item['licence'] or 'missing'}")
            continue
        if item["width"] < min_width:
            drop(item, f"too small: {item['width']}px wide, need {min_width}")
            continue
        if item["width"] <= item["height"]:
            drop(item, f"not landscape: {item['width']}x{item['height']}")
            continue
        if item["width"] * item["height"] > MAX_SOURCE_PIXELS:
            drop(item, f"too large to decode: {item['width']}x{item['height']}")
            continue
        kept.append(item)

    kept.sort(key=lambda c: c["width"], reverse=True)
    return kept, rejected


# --- Image processing -------------------------------------------------------


def crop_to_aspect(img, target_w, target_h, crop_top_ratio=0.55):
    """Crops to the target aspect ratio, keeping as much of the frame as possible.

    crop_top_ratio is the share of the discarded height taken off the top. The
    default 0.55 trims a little more sky than foreground, which puts the subject
    on or just below the centre line; Claude adjusts it per image.
    """
    target_aspect = target_w / target_h
    w, h = img.width, img.height
    offset_top = 0

    if w / h > target_aspect:
        # Wider than the target: keep the full height, crop the sides centred.
        crop_w = int(round(h * target_aspect))
        left = (w - crop_w) // 2
        img = img.crop((left, 0, left + crop_w, h))
    else:
        crop_h = int(round(w / target_aspect))
        ratio = min(max(float(crop_top_ratio), 0.0), 1.0)
        offset_top = int(round((h - crop_h) * ratio))
        img = img.crop((0, offset_top, w, offset_top + crop_h))

    return img.resize((target_w, target_h), Image.LANCZOS), offset_top


# Shadow lift. A sunlit building against a bright sky spans the full range
# already, so autocontrast finds nothing to stretch and the result stays as
# murky as the original — measured at +2.8 levels on a 1200x600 castle crop.
# A gamma curve on the midtones is what actually opens those shadows, so it is
# applied only when the frame really is shadow-heavy, and in proportion.
SHADOW_CUTOFF = 43          # top of the bottom sixth of the range
SHADOW_FLOOR = 0.18         # below this share of dark pixels, leave it alone
SHADOW_CEILING = 0.45       # at or above this share, apply the full lift
SHADOW_MAX_GAMMA = 0.76     # strongest curve; <1 brightens midtones


def shadow_share(img):
    """Fraction of pixels sitting in the bottom sixth of the luminance range."""
    hist = img.convert("L").histogram()
    total = sum(hist) or 1
    return sum(hist[:SHADOW_CUTOFF]) / total


def lift_shadows(img, factor=1.0):
    """Opens up the shadows without touching the white point.

    Returns (image, gamma) — gamma 1.0 means the image was left alone.
    """
    share = shadow_share(img)
    if share < SHADOW_FLOOR or factor <= 0:
        return img, 1.0
    ramp = min((share - SHADOW_FLOOR) / (SHADOW_CEILING - SHADOW_FLOOR), 1.0)
    gamma = 1.0 - (1.0 - SHADOW_MAX_GAMMA) * ramp * factor
    lut = [round(255 * ((i / 255) ** gamma)) for i in range(256)]
    return img.point(lut * len(img.getbands())), gamma


def enhance(img, strength="normal"):
    """The prompt's recipe, plus a shadow lift for high-contrast scenes.

    Order matters: autocontrast sets the black and white points, the lift opens
    the midtones between them, and the colour/contrast/sharpening finish on top.
    """
    if strength == "none":
        return img
    factor = 0.5 if strength == "light" else 1.0
    img = ImageOps.autocontrast(img, cutoff=0.3, preserve_tone=True)
    img, _gamma = lift_shadows(img, factor)
    img = ImageEnhance.Color(img).enhance(1 + 0.2 * factor)
    img = ImageEnhance.Contrast(img).enhance(1 + 0.08 * factor)
    return img.filter(
        ImageFilter.UnsharpMask(radius=1.2, percent=int(70 * factor), threshold=3)
    )


def _load_font(size):
    for name in ("arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


# A letterbox banner wants a smaller credit than a card: at the card's
# proportions it reads as a stripe across a thin image. Both keep the plate —
# it is what carries legibility over a blown-out sky as well as dark stone.
WIDE_ASPECT = 2.5
WIDE_CREDIT = {"size_scale": 0.78, "plate": True}
CARD_CREDIT = {"size_scale": 1.0, "plate": True}


def credit_style(target_w, target_h):
    """Size and treatment of the credit for a target's shape."""
    return WIDE_CREDIT if target_w / target_h >= WIDE_ASPECT else CARD_CREDIT


def watermark(img, text, size_scale=1.0, plate=True):
    """Photo credit in the bottom-right corner.

    The 15px text is quoted against a 600-high output and scales with the image;
    size_scale adjusts it per target. With `plate` it sits on a rounded dark
    rectangle, which carries legibility over anything. Without, the text goes
    straight into the corner and a dark outline on the glyphs does that job —
    lighter over the photo, and the treatment a wide banner wants.
    """
    if not text:
        return img
    base = img.height / 600
    scale = base * size_scale
    font_size = max(6, round(15 * scale))

    canvas = img.convert("RGBA")
    overlay = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = _load_font(font_size)

    if plate:
        pad_x = max(4, round(9 * scale))
        pad_y = max(3, round(6 * scale))
        radius = max(2, round(5 * scale))
        box = draw.textbbox((0, 0), text, font=font)
        tw, th = box[2] - box[0], box[3] - box[1]
        # Flush into the corner. The plate is pushed a radius past the right and
        # bottom edges so those rounded corners fall outside the frame and get
        # clipped square — only the corners that show stay rounded.
        x1, y1 = canvas.width + radius, canvas.height + radius
        x0 = canvas.width - (tw + pad_x * 2)
        y0 = canvas.height - (th + pad_y * 2)
        draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=(0, 0, 0, 120))
        draw.text((x0 + pad_x - box[0], y0 + pad_y - box[1]), text, font=font,
                  fill=(255, 255, 255, 255))
    else:
        # No plate: the outline carries the contrast on its own, since the corner
        # may be bright sky or dark stone. textbbox includes the stroke, so the
        # outline stays inside the margin rather than bleeding off the edge.
        stroke = max(1, round(font_size / 9))
        margin = max(4, round(6 * base))
        box = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
        x = canvas.width - margin - (box[2] - box[0])
        y = canvas.height - margin - (box[3] - box[1])
        draw.text((x - box[0], y - box[1]), text, font=font,
                  fill=(255, 255, 255, 240),
                  stroke_width=stroke, stroke_fill=(0, 0, 0, 205))

    return Image.alpha_composite(canvas, overlay).convert("RGB")


CREDIT_NAME_LIMIT = 48


def short_artist(artist, limit=CREDIT_NAME_LIMIT):
    """Trims an author to something a watermark can carry.

    Commons artist fields run to whole title pages — "Book authors: Ross,
    Thomas, 1839-1930; Lorimer, Robert (Sir) 1864-1929; ..." — which would
    swamp a 1200x600 image. The full string still goes in the JSON record and
    the attribution row; only the burnt-in credit is shortened.
    """
    name = " ".join((artist or "").split())
    if len(name) <= limit:
        return name
    # Prefer cutting at a separator so the result reads as a name, not a fragment.
    head = name[:limit]
    cut = max(head.rfind(";"), head.rfind(","), head.rfind(" "))
    if cut > limit // 2:
        head = head[:cut]
    return head.rstrip(" ,;:") + "…"


def attribution_text(candidate):
    artist = short_artist(candidate.get("artist")) or "Unknown"
    licence = candidate.get("licence") or "see source"
    return f"Photo: {artist} / Wikimedia Commons · {licence}"


def build_image(candidate, target_w, target_h, crop_top_ratio, enhance_strength):
    """Downloads the chosen file and renders the finished header image."""
    img = _source_image(candidate, target_w, target_h)
    source_size = (img.width, img.height)
    img, offset_top = crop_to_aspect(img, target_w, target_h, crop_top_ratio)
    img = enhance(img, enhance_strength)
    img = watermark(img, attribution_text(candidate), **credit_style(target_w, target_h))
    return img, offset_top, source_size


def build_record(place, candidate, out_name, offset_top, source_size, target_w, target_h):
    artist = candidate.get("artist") or "Unknown"
    licence = candidate.get("licence") or ""
    short_title = candidate["title"].replace("File:", "").rsplit(".", 1)[0]
    return {
        "place": place,
        "output_file": out_name,
        "source_title": candidate["title"],
        "source_page": candidate.get("descriptionurl", ""),
        "source_size": f"{source_size[0]}x{source_size[1]}",
        "author": artist,
        "license": licence,
        "license_url": candidate.get("licence_url", ""),
        "attribution_line": (
            f'"{short_title}" by {artist}, via Wikimedia Commons, {licence}, '
            "cropped and colour-adjusted."
        ),
        "modifications": (
            f"cropped to {target_w / target_h:.2f}:1, resized to {target_w}x{target_h}, "
            "levels/saturation/contrast/sharpening adjusted, watermark added"
        ),
        "crop_offset_top_px": offset_top,
    }


# --- The Claude loop --------------------------------------------------------

TOOLS = [
    {
        "name": "search_commons",
        "description": (
            "Search Wikimedia Commons for candidate photographs. Returns only files "
            "that already passed the licence, format and size filters, so anything "
            "returned is safe to use. Use mode='category' first — Commons has a "
            "category for most named places. Fall back to mode='search' if the "
            "category is missing or everything was filtered out. If the place name "
            "is ambiguous, add the county or country to the query."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Category name without the 'Category:' prefix (category mode), "
                        "or free-text search terms (search mode)."
                    ),
                },
                "mode": {"type": "string", "enum": ["category", "search"]},
            },
            "required": ["query", "mode"],
            "additionalProperties": False,
        },
    },
    {
        "name": "view_candidates",
        "description": (
            "Look at thumbnails of up to six candidates. Use this whenever the "
            "metadata alone does not tell you which photo frames the whole subject "
            "in decent light. Pass titles exactly as returned by search_commons."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "titles": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "File titles to view, most promising first.",
                }
            },
            "required": ["titles"],
            "additionalProperties": False,
        },
    },
    {
        "name": "preview_crop",
        "description": (
            "Render a candidate at one target's exact aspect ratio and look at the "
            "result before committing. This is how you check that a wide crop has "
            "not cut through the subject: you see the actual framing, not the "
            "uncropped photo. Call it again with a different crop_top_ratio to "
            "adjust. You may preview several candidates for the same target."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "target": {"type": "string", "description": "Which output to frame for."},
                "crop_top_ratio": {
                    "type": "number",
                    "description": "Share of the discarded height taken off the top, 0 to 1.",
                },
            },
            "required": ["title", "target", "crop_top_ratio"],
            "additionalProperties": False,
        },
    },
    {
        "name": "choose_image",
        "description": (
            "Commit one target to one candidate and crop. Call it once per target. "
            "Different targets may use different photos — pick whatever frames best "
            "at each shape rather than forcing one photo to serve both."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "The chosen file title."},
                "target": {"type": "string", "description": "Which output this is for."},
                "crop_top_ratio": {
                    "type": "number",
                    "description": (
                        "Share of the discarded height taken off the top, 0 to 1. "
                        "0.55 trims a little more sky than foreground and suits most "
                        "photos. Raise it to cut more sky, lower it to keep more "
                        "foreground. Never cut through the subject."
                    ),
                },
                "enhance": {
                    "type": "string",
                    "enum": ["normal", "light", "none"],
                    "description": (
                        "Back the enhancement off to 'light' or 'none' when the source "
                        "is already vivid or high-contrast."
                    ),
                },
                "reason": {
                    "type": "string",
                    "description": "One sentence on why this photo and this crop.",
                },
            },
            "required": ["title", "target", "crop_top_ratio", "reason"],
            "additionalProperties": False,
        },
    },
    {
        "name": "give_up",
        "description": (
            "Report that no candidate passes the bar for a target. Use this rather "
            "than settling for an unusable licence, a portrait crop, a picture of "
            "the wrong place, or a crop that slices through the subject."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "reason": {"type": "string"},
                "target": {
                    "type": "string",
                    "description": "Omit to abandon every remaining target.",
                },
            },
            "required": ["reason"],
            "additionalProperties": False,
        },
    },
]

SYSTEM = """You choose licensed photographs for a place's website images.

You are filling {n_targets} target{plural} in one pass:
{target_lines}

The searching, licence checking and image processing are done by the tools. Your \
job is the judgement the tools cannot do:

- Work out which Commons category or search terms actually refer to this place. \
Place names repeat across counties; if the results look like a different place, \
search again with the region added.
- Choose a photograph for each target. Prefer the whole subject in frame, \
daylight with decent light and sky, and no people, vehicles or signage \
dominating. Prefer larger originals when the choice is otherwise close.
- Choose where each crop sits, so the subject lands on or just below the centre \
line and is never cut through.

Search once and consider the whole shortlist for every target together. The \
targets are different shapes, so the best photo for one is often not the best \
for another — use different photos where that gives a better result, and the \
same photo where it genuinely works for both.

**Framing on wide targets.** search_commons reports keeps_height for each \
candidate at each target: the share of the photo's height that survives the \
crop. A candidate at 45% keeps under half its height, so a subject that fills \
the frame will lose its top or its bottom. For a wide target, prefer candidates \
with a high keeps_height — a photo that is already wide barely gets cropped — \
and leave visible space above and below the subject rather than framing it to \
the edges. If every candidate would cut the subject, say so with give_up for \
that target rather than committing a beheaded crop.

Use preview_crop to look at the actual framing before you commit. It is \
required for any target keeping less than {preview_threshold}% of the height, \
and worth using whenever you are unsure. Adjust crop_top_ratio and preview \
again until the subject has room.

search_commons only returns files that already passed the licence, format and \
size filters, so you never need to check or state a licence yourself, and you \
must not describe a file the tools did not return to you. If nothing passes, \
try the other search mode and the place name plus its region before giving up. \
Do not lower the bar.

Call choose_image once for each target."""

# Below this share of retained height a crop is aggressive enough that the model
# must look at the rendered result before committing to it.
PREVIEW_REQUIRED_BELOW = 60.0
PREVIEW_WIDTH = 768


def height_kept_pct(candidate, target_w, target_h):
    """Share of the source's height that survives the crop to this aspect ratio.

    100 means the photo is wider than the target and only the sides are trimmed;
    43 means a 4:3 photo squeezed into a 3.1:1 letterbox, which will behead a
    subject that fills the frame.
    """
    target_aspect = target_w / target_h
    w, h = candidate["width"], candidate["height"]
    if h <= 0 or w <= 0:
        return 0.0
    if w / h >= target_aspect:
        return 100.0
    return round((w / target_aspect) / h * 100, 1)


def _image_block(data, media_type):
    import base64

    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": media_type,
            "data": base64.standard_b64encode(data).decode("ascii"),
        },
    }


def _client(api_key):
    try:
        import anthropic
    except ImportError:
        raise FinderError(
            "The 'anthropic' package is not installed. Run: pip install anthropic"
        )
    if api_key:
        return anthropic, anthropic.Anthropic(api_key=api_key)
    # No explicit key: let the SDK resolve ANTHROPIC_API_KEY or an `ant auth login`
    # profile itself rather than failing here.
    return anthropic, anthropic.Anthropic()


def _create(client, anthropic_mod, **kwargs):
    """Sends the request with prompt caching and server-side refusal fallbacks,
    degrading to a plain call if this account or SDK build lacks the beta.

    Caching is what makes a multi-turn tool loop affordable. Each turn resends
    the whole conversation, and the thumbnails in it are the bulk of the tokens
    — measured at 1,920 tokens for three, resent on every turn after they are
    fetched. Caching the prefix turns those resends into cache reads at a tenth
    of the price instead of paying full rate for the same bytes repeatedly.
    """
    kwargs.setdefault("cache_control", {"type": "ephemeral"})
    try:
        return client.beta.messages.create(
            betas=["server-side-fallback-2026-07-01"], fallbacks="default", **kwargs
        )
    except (anthropic_mod.BadRequestError, TypeError):
        kwargs.pop("cache_control", None)
        try:
            return client.messages.create(
                cache_control={"type": "ephemeral"}, **kwargs
            )
        except TypeError:
            return client.messages.create(**kwargs)


def open_source(data, target_w=0, target_h=0):
    """Decodes a downloaded original, cheaply.

    draft() lets a JPEG decode at 1/2, 1/4 or 1/8 scale straight out of the DCT
    coefficients. Half again over the target leaves headroom for a crop that
    keeps less than the full width, while letting a 290MP scan decode at a
    quarter scale instead of full — pixels the resize would throw away anyway.
    It is a no-op for PNG and for sources already near the requested size.
    """
    img = Image.open(io.BytesIO(data))
    if target_w and target_h:
        img.draft("RGB", (round(target_w * 1.5), round(target_h * 1.5)))
    return ImageOps.exif_transpose(img).convert("RGB")


def _source_image(candidate, target_w=0, target_h=0):
    return open_source(_get_bytes(candidate["url"]), target_w, target_h)


def find_place_images(
    place_name,
    targets,
    region="",
    api_key="",
    model=MODEL,
    allow_sharealike=True,
    min_width=0,
    progress=lambda msg: None,
    should_stop=lambda: False,
):
    """Fills every target in `targets` from one search and one conversation.

    targets: [{"name": "card", "width": 1200, "height": 600}, ...]

    Returns {target_name: {"image": PIL, "record": dict}}. Targets the model
    abandoned are absent from the result; if it abandons all of them, or nothing
    usable exists, FinderError is raised.
    """
    if not targets:
        raise FinderError("No targets requested")
    anthropic_mod, client = _client(api_key)
    by_name = {t["name"]: t for t in targets}
    # Never upscale; for the card that also lands on the prompt's 2400px bar.
    min_width = min_width or max(2400, max(t["width"] for t in targets))

    def aspect(t):
        return f"{t['width'] / t['height']:.2f}:1"

    target_lines = "\n".join(
        f"- {t['name']}: {t['width']}x{t['height']} ({aspect(t)})" for t in targets
    )
    system = SYSTEM.format(
        n_targets=len(targets),
        plural="s" if len(targets) != 1 else "",
        target_lines=target_lines,
        preview_threshold=int(PREVIEW_REQUIRED_BELOW),
    )

    seen = {}          # title -> candidate
    previewed = set()  # (title, target) the model has actually looked at
    chosen = {}        # target -> {"image", "record"}
    abandoned = {}     # target -> reason
    rejected_total = 0

    messages = [{
        "role": "user",
        "content": (
            f"Find images for: {place_name}"
            + (f" ({region})" if region else "")
            + "\nTargets:\n" + target_lines
        ),
    }]

    def remaining():
        return [t["name"] for t in targets
                if t["name"] not in chosen and t["name"] not in abandoned]

    for _turn in range(MAX_TURNS):
        if should_stop():
            raise FinderError("Cancelled")

        response = _create(
            client, anthropic_mod,
            model=model, max_tokens=16000, system=system,
            thinking={"type": "adaptive"}, tools=TOOLS, messages=messages,
        )

        if response.stop_reason == "refusal":
            detail = getattr(response, "stop_details", None)
            raise FinderError(
                "Claude declined this request"
                + (f" ({detail.category})" if detail and detail.category else "")
            )

        messages.append({"role": "assistant", "content": response.content})
        calls = [b for b in response.content if b.type == "tool_use"]
        if not calls:
            if chosen:
                break
            text = " ".join(b.text for b in response.content if b.type == "text")
            raise FinderError(text.strip()[:300] or "Claude stopped without choosing an image")

        results = []
        for call in calls:
            name, args = call.name, call.input

            def ok(content):
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "content": content})

            def err(content):
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "is_error": True, "content": content})

            if name == "search_commons":
                mode = args.get("mode", "category")
                query = args.get("query", "")
                progress(f"Searching Commons ({mode}): {query}")
                try:
                    items, _more = commons_query(query, mode)
                except Exception as exc:
                    err(f"Commons request failed: {exc}")
                    continue
                kept, rejected = filter_candidates(items, min_width, allow_sharealike)
                rejected_total += len(rejected)
                for c in kept:
                    seen[c["title"]] = c
                progress(f"{len(kept)} usable of {len(items)} files")
                ok(json.dumps({
                    "usable": [
                        {
                            "title": c["title"], "width": c["width"], "height": c["height"],
                            "artist": c["artist"], "licence": c["licence"],
                            "description": c["description"], "date": c["date"],
                            # How much of this photo survives each target's crop.
                            "keeps_height": {
                                t["name"]: height_kept_pct(c, t["width"], t["height"])
                                for t in targets
                            },
                        }
                        for c in kept[:25]
                    ],
                    "filtered_out": rejected[:15],
                    "totals": {"returned": len(items), "usable": len(kept)},
                }))

            elif name == "view_candidates":
                titles = [t for t in args.get("titles", []) if t in seen][:MAX_CANDIDATES_TO_VIEW]
                if not titles:
                    err("None of those titles came from search_commons.")
                    continue
                progress(f"Looking at {len(titles)} candidate{'s' if len(titles) > 1 else ''}")
                add_thumbnails([seen[t] for t in titles], VIEW_THUMB_WIDTH)
                blocks = []
                for title in titles:
                    c = seen[title]
                    thumb = c.get("thumburl") or c["url"]
                    try:
                        data = _get_bytes(thumb)
                    except Exception as exc:
                        blocks.append({"type": "text", "text": f"{title}: could not load ({exc})"})
                        continue
                    media = "image/png" if thumb.lower().endswith(".png") else "image/jpeg"
                    blocks.append({"type": "text", "text": f"{title} ({c['width']}x{c['height']})"})
                    blocks.append(_image_block(data, media))
                results.append({"type": "tool_result", "tool_use_id": call.id,
                                "content": blocks})

            elif name == "preview_crop":
                title, tname = args.get("title", ""), args.get("target", "")
                candidate, spec = seen.get(title), by_name.get(tname)
                if candidate is None:
                    err("That title did not come from search_commons.")
                    continue
                if spec is None:
                    err(f"Unknown target '{tname}'. Targets: {', '.join(by_name)}")
                    continue
                ratio = args.get("crop_top_ratio", 0.55)
                progress(f"Previewing {tname} crop of {title.replace('File:', '')}")
                try:
                    cropped, offset = crop_to_aspect(
                        _source_image(candidate, spec["width"], spec["height"]),
                        spec["width"], spec["height"], ratio,
                    )
                except Exception as exc:
                    err(f"Could not render preview: {exc}")
                    continue
                previewed.add((title, tname))
                small = cropped.copy()
                small.thumbnail((PREVIEW_WIDTH, PREVIEW_WIDTH), Image.LANCZOS)
                buf = io.BytesIO()
                small.save(buf, format="JPEG", quality=80)
                results.append({
                    "type": "tool_result", "tool_use_id": call.id,
                    "content": [
                        {"type": "text", "text": (
                            f"{tname} crop of {title} at crop_top_ratio={ratio} "
                            f"(keeps {height_kept_pct(candidate, spec['width'], spec['height'])}% "
                            f"of the height, {offset}px trimmed from the top). "
                            "This is the framing that would be saved."
                        )},
                        _image_block(buf.getvalue(), "image/jpeg"),
                    ],
                })

            elif name == "choose_image":
                title, tname = args.get("title", ""), args.get("target", "")
                candidate, spec = seen.get(title), by_name.get(tname)
                if candidate is None:
                    err("That title did not come from search_commons. Choose one that did.")
                    continue
                if spec is None:
                    err(f"Unknown target '{tname}'. Targets: {', '.join(by_name)}")
                    continue
                if tname in chosen:
                    err(f"{tname} is already chosen. Remaining: {remaining() or 'none'}")
                    continue
                keeps = height_kept_pct(candidate, spec["width"], spec["height"])
                if keeps < PREVIEW_REQUIRED_BELOW and (title, tname) not in previewed:
                    err(
                        f"This crop keeps only {keeps}% of the photo's height, so it may "
                        f"cut through the subject. Call preview_crop for this title and "
                        f"target and look at the framing before committing."
                    )
                    continue
                progress(f"Processing {tname}: {title.replace('File:', '')}")
                try:
                    img, offset, source_size = build_image(
                        candidate, spec["width"], spec["height"],
                        args.get("crop_top_ratio", 0.55), args.get("enhance", "normal"),
                    )
                except Exception as exc:
                    err(f"Could not build the image: {exc}")
                    continue
                record = build_record(place_name, candidate, "", offset, source_size,
                                      spec["width"], spec["height"])
                record["reason"] = args.get("reason", "")
                record["candidates_seen"] = len(seen)
                record["keeps_height_pct"] = keeps
                record["target"] = tname
                chosen[tname] = {"image": img, "record": record}
                left = remaining()
                ok(f"{tname} saved. " + (f"Still to choose: {', '.join(left)}."
                                         if left else "All targets done."))

            elif name == "give_up":
                reason = args.get("reason", "No suitable image found")
                tname = args.get("target")
                if tname and tname in by_name:
                    abandoned[tname] = reason
                    progress(f"No {tname} image: {reason}")
                    left = remaining()
                    ok(f"{tname} abandoned. " + (f"Still to choose: {', '.join(left)}."
                                                 if left else "Nothing left."))
                else:
                    for t in remaining():
                        abandoned[t] = reason
                    ok("Abandoned every remaining target.")

            else:
                err(f"Unknown tool {name}")

        if not remaining():
            break
        messages.append({"role": "user", "content": results})
    else:
        if not chosen:
            raise FinderError(f"Gave up after {MAX_TURNS} turns without choosing an image")

    if not chosen:
        reason = "; ".join(f"{k}: {v}" for k, v in abandoned.items()) or "nothing suitable"
        raise FinderError(f"{reason} (saw {len(seen)} usable, {rejected_total} filtered out)")

    for tname, reason in abandoned.items():
        progress(f"No {tname} image: {reason}")
    return chosen


def find_place_image(place_name, target_w, target_h, **kwargs):
    """Single-target wrapper, kept so one panel can be re-run on its own."""
    name = kwargs.pop("target_name", "image")
    out = find_place_images(
        place_name, [{"name": name, "width": target_w, "height": target_h}], **kwargs
    )
    entry = out[name]
    return entry["image"], entry["record"], entry["record"].get("reason", "")


def save_outputs(img, record, output_folder, base_name, suffix=""):
    """Writes the WebP and its JSON provenance record side by side."""
    os.makedirs(output_folder, exist_ok=True)
    name = f"{base_name}{suffix}"
    out_path = os.path.join(output_folder, f"{name}.webp")
    img.save(out_path, "WEBP", quality=85, method=6)
    record["output_file"] = os.path.basename(out_path)
    with open(os.path.join(output_folder, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)
    return out_path
