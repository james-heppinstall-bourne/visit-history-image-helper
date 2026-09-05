# Visit History Image Helper

Pywebview desktop app for cropping images to a fixed aspect ratio with auto-enhance, rotation, zoom, and photo credit watermark overlay.

## Project structure

- `app.py` — Entry point; creates the pywebview window and wires up the API
- `backend.py` — Python API exposed to the frontend (file dialogs, image processing, crop/save)
- `finder.py` — Image finder: Wikimedia Commons search + the Claude tool loop that picks a photo
- `web/home.html` — Menu the app opens on; each tool is its own page
- `web/index.html` + `web/app.js` — Image Helper: one image, one target at a time
- `web/place-images.html` + `web/place-images.js` — Place Images: the place list with the card and hero open side by side
- `web/log-viewer.html` + `web/log-viewer.js` — Log Viewer
  Logs come from two tables, `app_logs` (the mobile app) and `web_logs` (the
  website). The three log tabs default to both merged by time, with a source
  filter (App + Web / App / Web). `Api._fetch_logs` does the merge and pages
  by a `created_at` cursor (`before` / `next_before`) rather than page number,
  because page N of two interleaved tables is not a well-defined thing. Web
  levels (`info`, `warn`, `fatal`) are normalised to the app's names on the
  way out and translated back for the level filter; each row carries
  `log_source`. Web rows are matched to a user by `user_id` *or*
  `context.userId`, since the site often records the user only in context.
- `web/map.html` + `web/map.js` — Place Map
- `web/style.css` — Dark theme styles for every page
- `config.json` — Runtime config (crop dimensions, output folder, webp quality); auto-created on first run

## The two image screens

Both compose the same outputs through the same backend helpers (`apply_auto_enhance`,
`render_crop`), and differ in how you get to them:

- **Image Helper** (`index.html`) works on one open image and toggles between the
  card and the hero. It keeps its source in `Api._original_image` and saves through
  `save_crop()`.
- **Place Images** (`place-images.html`) starts from the place: a searchable list
  filtered by what is missing (all / no card / no hero / neither), and two panels
  that each hold their own source and save independently. Sources live in
  `Api._slot_sources` keyed by target name and save through `save_slot_crop()`.
  Panels take a source from the file dialog, a paste, a drop, the other panel
  (`copy_slot_image`), or the place's stored image (`load_slot_image_from_url`).

Either panel can take the full width (the header's ⤢ toggle, or clicking the
collapsed rail); `layoutMode` is "both" or the slot showing on its own. The
canvas follows automatically via each stage's `ResizeObserver`, and
`rescaleToCrop()` maps the existing composition onto the resized crop box — the
box keeps its aspect ratio, so one factor covers both axes — rather than
re-fitting, so framing set by hand survives maximising and restoring. A
collapsed stage reports no size and is skipped, which is what preserves it.

Each panel in Place Images is in one of three states, set only by `Panel.render()`:

| State | Stage shows | Live controls |
|---|---|---|
| `editing` | canvas + crop overlay | everything |
| `preview` | the image the place already has | Re-crop, Replace, Clear |
| `empty` | "Open, paste or drop an image" | Open, Find with Claude |
| `searching` | the finder's progress log | Cancel |

`preview` is a deliberate gate: a place that already has an image cannot be
edited over — by Open, paste, drop, or the other panel's Copy → — until one of
Re-crop (crop the stored image again), Replace (crop a different image) or Clear
(blank the column) says what to do with it. Only Clear writes to the database;
Replace leaves the stored image in place until a save overwrites it.
`Panel.locked` is that state, and `renderCopyButton()` is what lets one panel's
gate disable the other panel's Copy →.

## Image finder (`finder.py`)

"Find with Claude" fills an empty panel from Wikimedia Commons. The split of
responsibilities is the point of the module:

- **Python** does the Commons queries, the licence and size filtering, the
  download, and all the Pillow work. The model never writes an author or a
  licence down — it picks a file title, and the metadata travels with the file.
  `licence_ok()` accepts CC0, public domain, CC BY and CC BY-SA only; a blank
  licence and "no known restrictions" are rejected, and the bar does not move
  when a search comes up short. `filter_candidates` also drops scanned book
  illustrations — `TITLE_BLOCKLIST`, the `SCAN_ID` pattern for Internet Archive
  identifiers, and an "Book authors:" artist field. They are wide, so without
  this they sort straight to the top of the picker.

  `short_artist()` trims the credit to 48 characters for the burnt-in watermark;
  Commons artist fields run to whole title pages. The full string still goes in
  the JSON record and the attribution row.
- **Claude** (`claude-opus-5`, adaptive thinking) does the judgement: which
  Commons category actually refers to this place, which candidate photo to use
  — looking at thumbnails through `view_candidates`, a genuine vision call —
  and where the crop sits (`crop_top_ratio`).

Tools: `search_commons`, `view_candidates`, `preview_crop`, `choose_image`,
`give_up`. Only titles returned by `search_commons` are accepted by
`choose_image`, so an invented filename is rejected and fed back rather than
acted on.

### One search fills every target

`find_place_images(place, targets)` runs a single search and a single
conversation covering the card and the hero together, because the shortlist and
the thumbnails are identical either way. The model still picks a *different*
photo per target where one frames better — it just does so with both aspect
ratios in front of it. `start_find_images(place, slots)` maps each slot to the
job so both panels poll the same run; passing one slot re-runs that panel alone.

Measured on one place (Aberdour Castle), like for like: sharing the search cuts
input tokens 49% raw / 43% cached, and one Commons query replaces two.

### Not cropping through the subject

The hero is 3.1:1 — a wide letterbox. A 4:3 photo keeps only 43% of its height
at that shape, so a subject filling the frame loses its top or bottom.

- `search_commons` reports `keeps_height` per candidate **per target**, so the
  model can prefer photos that barely get cropped at the wide shape.
- `preview_crop` renders a candidate at a target's exact aspect ratio and hands
  the result back as an image, so the framing is judged by looking at it.
- Below `PREVIEW_REQUIRED_BELOW` (60% of height retained), `choose_image` is
  **refused** until that title and target have been previewed. The guard is in
  code, not just in the prompt.

## Browse Commons (`browse_commons`)

The other way to fill a panel, and no model is involved. Same Commons search and
the **same licence bar**, but the shortlist comes back to the UI as a grid of up
to ten tiles and the user picks.

| | Find with Claude | Browse Commons |
|---|---|---|
| Who chooses | the model | you |
| Cost | a model call per place | none |
| What lands in the panel | finished image at target size | the **full-resolution original** |
| Crop | model's, already applied | yours, from the source |
| Attribution | burnt in automatically | pre-filled, you Apply it |

Because the panel gets the original rather than a finished image, reframing in
this mode is lossless and there is no second WebP encode.

`browse_commons(query, mode, target, large_only, limit)` returns **every** usable
candidate (`limit <= 0`), ordered by `keeps_height` for the chosen target, with
source width breaking ties so relaxing `large_only` cannot float a tiny panorama
above a big photo. The picker's sort toggle (best fit / largest) re-orders that
list **client-side** — every candidate is already there, so it needs no round
trip. Switching target does re-query, because the minimum width differs per
target and the candidate set genuinely differs. Each tile shows the author, licence, dimensions, a
`keeps N%` chip (red under 60%, green at 75%+) and a link to the Commons file
page. `commons_query` follows Commons' continuation up to `BROWSE_MAX_FILES`
(300) for the picker; the finder still takes one page of 50, because it only
ever shows the model a shortlist and paging for it would buy nothing.

`large_only` is the only filter the user can relax — the licence bar never moves,
whoever is choosing. Choosing a tile calls `load_slot_image_from_url`, sets a
partial record so the attribution row and its Source button work, fills the
credit field and licence dropdown, and **applies the credit**, so the watermark
is on the canvas before any cropping starts. Both fields stay editable and Apply
re-does it. `setLicenceOption` adds the file's licence to the dropdown when it is
not one of the presets — Commons carries licences the list was never built for,
and silently leaving the wrong one selected would put a false licence on the
image.

### Cost

Every request sets `cache_control` — each turn resends the whole conversation
and the thumbnails in it dominate (1,920 tokens for three), so caching turns
those resends into reads at a tenth of the price. Without it the framing check
would have made the flow more expensive than the two separate searches it
replaced; with it the shipped flow costs 27% less than the old one *and*
includes the check.

`watermark()` sets the credit on a rounded dark plate in the bottom-right
corner, close to the edge rather than the 12px inset of the original spec. The
plate is what carries legibility over a blown-out sky as well as dark stone.
`credit_style()` sizes the credit for each target's shape: 15px on a card, 16px
on anything wider than 2.5:1 (`size_scale` 0.78 against a taller output), where
card proportions read as a stripe across the banner. Both keep the rounded dark plate, run **flush into the bottom-right corner**
(zero inset — the outer rounded corners are pushed past the edge so they clip
square, leaving only the visible corners rounded), and are measured at card
411x23px, hero 442x24px. `watermark()` also takes
`plate=False`, which drops the rectangle and puts a dark outline on the glyphs
instead; no target uses it at present. The corner inset stays full size either way, so the
smaller plate stays tucked in rather than drifting inward.
(The manual "Photo credit" field in `render_crop` is a separate feature with its
own filled strip.)

The result is a finished image at the target size, already cropped, enhanced and
watermarked. It is loaded into the panel **as a source for review** — nothing
reaches the database until the user saves it like any other crop. A copy and a
JSON provenance record are written to the output folder.

Card and hero search independently: a photo that crops well to 2:1 often has
nothing left at 3.1:1, so each target gets its own candidate.

`enhance()` follows the prompt's recipe with one addition. A sunlit building
against a bright sky already spans 0-255, so `autocontrast` finds nothing to
stretch — measured at +2.8 levels on a real castle crop, which is why those
images came out murky. `lift_shadows()` applies a gamma curve to the midtones
instead, scaled by how shadow-heavy the frame actually is: no effect below 18%
of pixels in the bottom sixth of the range, ramping to gamma 0.76 at 45%. On
the same castle that is +10 to +11 levels; on an already bright photo it is a
no-op. It runs after autocontrast (which sets the black and white points) and
before the colour/contrast/sharpening finish.

A find takes about a minute, so `start_find_image()` runs it on a thread and the
frontend polls `get_find_status(slot, since)`; `cancel_find()` stops it at the
next checkpoint. Requires an Anthropic API key in `config.json`
(`anthropic_api_key`) or `ANTHROPIC_API_KEY`; `finder_ready()` tells the UI why
the button is disabled rather than failing a minute into a search.

## Output targets

Each place has two images at different aspect ratios, so they are composed and
saved as two separate actions from the same source (the Card/Hero toggle in the
Image Helper, or the two panels in Place Images):

| Target | Size (config keys) | Quality | File | DB column |
|---|---|---|---|---|
| `card` | 1200×600 (`crop_width`/`crop_height`) | `webp_quality` (80) | `{name}.webp` | `places.image_path` |
| `hero` | 2480×800 (`hero_width`/`hero_height`) | `hero_webp_quality` (75) | `{name}-hero.webp` | `places.hero_image_path` |

Both go to the public `place-images` bucket. `TARGETS` in `backend.py`, `app.js`
and `place-images.js` must stay in step. The hero overlay marks the lower-left, where the website's
`SiteHeader` lays the place name and buttons over the image.

## Setup and running

```bash
pip install -r requirements.txt
python app.py
```

Requires Python 3.9+.

## Building a standalone executable

```bash
python -m PyInstaller build.spec
```

Output goes to `dist/`.

## Key conventions

- Frontend communicates with Python via `pywebview.api.*` calls
- Images are passed between frontend and backend as base64 data URLs
- Crop coordinates are computed in canvas space and converted to image space in `render_crop()`
- There is **one** watermark implementation, `finder.watermark()`. `render_crop()`
  calls it, so a credit typed by hand, applied by the Commons picker, or burnt in
  by the finder all look the same and all get `credit_style()`. It previously had
  a second copy sized at `target_h / 30` — 27px on the hero — which is what those
  first two paths actually produced. The canvas previews in `app.js` and
  `place-images.js` mirror the same proportions, expressed as fractions of the
  output height, so what is on screen is what lands in the file.
- Listing requests never ask Commons for thumbnails. A single PDF or DjVu in a
  category fails the *whole* query with `urlparamnormal` ("Could not normalize
  image parameters"), losing every result. `add_thumbnails()` fetches them in a
  second batched request for the files already established to be photographs —
  which also means Commons renders thumbnails for the dozen on screen rather
  than every file in the category. Search mode additionally appends
  `filetype:bitmap`, which keeps scans out at source; category listings have no
  equivalent filter. Thumbnail URLs cannot be derived by hand: Wikimedia only
  serves widths it has already generated (500 and 960 for one test file; 400,
  420, 640 and 800 all returned HTTP 400).
- Commons hosts gigapixel scans that exceed Pillow's decompression-bomb guard.
  `finder` raises the ceiling to `MAX_SOURCE_PIXELS` (400MP), filters anything
  past it, and `open_source()` uses `draft()` so a large JPEG decodes at a
  fraction of full size — 290MP goes from 18s to 1.4s. `_slot_payload` caps a
  panel source at `MAX_SLOT_EDGE` (6000px), well beyond any target's width.
- All saved images are output as WebP
