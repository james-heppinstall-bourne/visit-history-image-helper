import base64
import io
import json
import os
import re
import threading
import time
import urllib.request
import webbrowser
from datetime import datetime, timezone

import webview
from PIL import Image, ImageEnhance, ImageOps

import finder

try:
    from supabase import create_client, Client as SupabaseClient
except ImportError:
    create_client = None
    SupabaseClient = None


CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
DEFAULT_CONFIG = {
    "crop_width": 1200,
    "crop_height": 600,
    "output_folder": "./output",
    "webp_quality": 80,
    "hero_width": 2480,
    "hero_height": 800,
    "hero_webp_quality": 75,
    "supabase_url": "",
    "supabase_key": "",
    # Image finder. The key may also come from the ANTHROPIC_API_KEY environment
    # variable, which the SDK reads when this is blank.
    "anthropic_api_key": "",
    "finder_model": "claude-opus-5",
    "finder_allow_sharealike": True,
}

# The two outputs a place can have. They are different aspect ratios (2:1 and
# 3.1:1), so each is composed and saved as its own action rather than derived
# from the other. `column` is the places column that receives the filename;
# `suffix` keeps the two files apart in the output folder and the bucket.
TARGETS = {
    "card": {
        "width_key": "crop_width",
        "height_key": "crop_height",
        "quality_key": "webp_quality",
        "suffix": "",
        "column": "image_path",
    },
    "hero": {
        "width_key": "hero_width",
        "height_key": "hero_height",
        "quality_key": "hero_webp_quality",
        "suffix": "-hero",
        "column": "hero_image_path",
    },
}


def resolve_target(cfg, target):
    spec = TARGETS.get(target)
    if spec is None:
        raise ValueError(f"Unknown target '{target}' (expected one of {', '.join(TARGETS)})")
    return {
        "width": int(cfg[spec["width_key"]]),
        "height": int(cfg[spec["height_key"]]),
        "quality": int(cfg[spec["quality_key"]]),
        "suffix": spec["suffix"],
        "column": spec["column"],
    }


def apply_auto_enhance(img):
    """The one auto-enhance recipe, shared by the preview and the saved file so
    what is on screen is what lands in the bucket."""
    img = ImageOps.autocontrast(img, cutoff=1)
    img = ImageEnhance.Sharpness(img).enhance(1.3)
    img = ImageEnhance.Color(img).enhance(1.1)
    return img


def render_crop(img, crop_box, img_transform, rotation, credit, target_w, target_h):
    """Crops the canvas-space box out of `img` and renders it at the target size.

    crop_box/img_transform come from the frontend in canvas pixels; the transform
    says where the image was drawn, so dividing back through the scale maps the
    box onto the source. Shared by the single-image helper and the per-place
    editor, which compose the same way in two different layouts.
    """
    orig_w, orig_h = img.width, img.height

    # Apply rotation if needed (Pillow rotates CCW, so negate)
    if rotation:
        img = img.rotate(-rotation, resample=Image.BICUBIC, expand=True)

    scale = img_transform["scale"]
    img_x = img_transform["x"]
    img_y = img_transform["y"]

    # After rotation with expand, the image center stays the same but
    # dimensions change. The canvas draw() rotates around the scaled image center,
    # so we need to offset coordinates by the size difference.
    dx = (img.width - orig_w) / 2
    dy = (img.height - orig_h) / 2

    # Convert crop box coordinates to rotated image coordinates
    src_x = (crop_box["x"] - img_x) / scale + dx
    src_y = (crop_box["y"] - img_y) / scale + dy
    src_w = crop_box["width"] / scale
    src_h = crop_box["height"] / scale

    # Clamp to image bounds
    src_x = max(0, src_x)
    src_y = max(0, src_y)
    src_w = min(src_w, img.width - src_x)
    src_h = min(src_h, img.height - src_y)

    cropped = img.crop((
        int(src_x),
        int(src_y),
        int(src_x + src_w),
        int(src_y + src_h),
    ))
    cropped = cropped.resize((target_w, target_h), Image.LANCZOS)

    if credit:
        # One watermark implementation for the whole app. This used to have its
        # own copy sized at target_h/30 — 27px on the hero — which is what a
        # credit applied by hand or by the Commons picker actually got, while
        # the finder's scaling was applied somewhere else entirely.
        cropped = finder.watermark(
            cropped, credit, **finder.credit_style(target_w, target_h)
        )

    if cropped.mode == "RGBA":
        cropped = cropped.convert("RGB")
    return cropped


def resolve_output_folder(cfg):
    output_folder = cfg["output_folder"]
    if not os.path.isabs(output_folder):
        output_folder = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), output_folder
        )
    os.makedirs(output_folder, exist_ok=True)
    return output_folder


def slugify(name):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", (name or "").lower()))


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            stored = json.load(f)
        merged = dict(DEFAULT_CONFIG)
        merged.update(stored)
        return merged
    save_config(DEFAULT_CONFIG)
    return dict(DEFAULT_CONFIG)


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)


class Api:
    def __init__(self):
        self._window = None
        self._current_image_path = None
        self._original_image = None
        self._supabase = None
        # Per-panel sources for the place image manager, keyed by target name.
        self._slot_sources = {}
        # In-flight image finds. A find takes a minute or so, so it runs on a
        # thread and the frontend polls get_find_status(). One job can cover
        # several panels, so slots are mapped to jobs rather than owning them.
        self._finds = {}
        self._slot_job = {}
        self._finds_lock = threading.Lock()

    def set_window(self, window):
        self._window = window

    def get_config(self):
        return load_config()

    def update_config(self, cfg):
        current = load_config()
        current.update(cfg)
        save_config(current)
        return current

    def open_file_dialog(self):
        file_types = ("Image Files (*.jpg;*.jpeg;*.png;*.webp)",)
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=file_types
        )
        if result and len(result) > 0:
            path = result[0]
            return self.load_image(path)
        return None

    def load_image(self, path):
        try:
            img = Image.open(path)
            img = ImageOps.exif_transpose(img)
            self._original_image = img.copy()
            self._current_image_path = path

            data_url = self._image_to_data_url(img)
            return {
                "data_url": data_url,
                "width": img.width,
                "height": img.height,
                "filename": os.path.basename(path),
            }
        except Exception as e:
            return {"error": str(e)}

    def auto_enhance(self):
        if self._original_image is None:
            return {"error": "No image loaded"}
        try:
            img = apply_auto_enhance(self._original_image.copy())
            data_url = self._image_to_data_url(img)
            return {
                "data_url": data_url,
                "width": img.width,
                "height": img.height,
            }
        except Exception as e:
            return {"error": str(e)}

    def get_original(self):
        if self._original_image is None:
            return {"error": "No image loaded"}
        data_url = self._image_to_data_url(self._original_image)
        return {
            "data_url": data_url,
            "width": self._original_image.width,
            "height": self._original_image.height,
        }

    def _get_supabase_client(self):
        if self._supabase is not None:
            return self._supabase
        if create_client is None:
            return None
        cfg = load_config()
        url = cfg.get("supabase_url", "")
        key = cfg.get("supabase_key", "")
        if not url or not key:
            return None
        self._supabase = create_client(url, key)
        return self._supabase

    def get_places(self):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"places": []}
            PAGE_SIZE = 1000
            all_places = []
            offset = 0
            while True:
                result = (
                    client.table("places")
                    .select("id, name")
                    .order("name")
                    .range(offset, offset + PAGE_SIZE - 1)
                    .execute()
                )
                rows = result.data
                all_places.extend({"id": r["id"], "name": r["name"]} for r in rows)
                if len(rows) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE
            return {"places": all_places}
        except Exception as e:
            return {"places": [], "error": str(e)}

    def get_map_places(self):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"places": []}
            PAGE_SIZE = 1000
            all_places = []
            offset = 0
            while True:
                result = (
                    client.table("places")
                    .select(
                        "id, name, latitude, longitude, managed_by, featured, "
                        "town, county, category, official_website, website, "
                        "pin_position_updated_at"
                    )
                    .not_.is_("latitude", "null")
                    .not_.is_("longitude", "null")
                    .order("name")
                    .range(offset, offset + PAGE_SIZE - 1)
                    .execute()
                )
                rows = result.data
                all_places.extend(rows)
                if len(rows) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE
            return {"places": all_places}
        except Exception as e:
            return {"places": [], "error": str(e)}

    def confirm_place_position(self, place_id):
        """Marks a pin as checked without moving it. The coordinates are unchanged,
        so the on_places_pin_position_updated trigger won't fire — the timestamp is
        written explicitly here instead."""
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            stamp = datetime.now(timezone.utc).isoformat()
            result = (
                client.table("places")
                .update({"pin_position_updated_at": stamp})
                .eq("id", place_id)
                .execute()
            )
            row = result.data[0] if result.data else {}
            return {
                "success": True,
                "pin_position_updated_at": row.get("pin_position_updated_at", stamp),
            }
        except Exception as e:
            return {"error": str(e)}

    def update_place_websites(self, place_id, official_website, website):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            for url in (official_website, website):
                if url and not url.lower().startswith(("http://", "https://")):
                    return {"error": "URLs must start with http:// or https://"}
            client.table("places").update(
                {
                    "official_website": official_website or None,
                    "website": website or None,
                }
            ).eq("id", place_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def update_place_name(self, place_id, name):
        name = (name or "").strip()
        if not name:
            return {"error": "A place needs a name"}
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            result = (
                client.table("places")
                .update({"name": name})
                .eq("id", place_id)
                .execute()
            )
            if not result.data:
                return {"error": "No place was updated"}
            return {"success": True, "name": result.data[0].get("name", name)}
        except Exception as e:
            return {"error": str(e)}

    def open_url(self, url):
        """Opens a place website in the system browser (the webview itself would
        navigate away from the app)."""
        if not url or not url.lower().startswith(("http://", "https://")):
            return {"error": "Unsupported URL"}
        try:
            webbrowser.open(url)
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def update_place_coordinates(self, place_id, latitude, longitude):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            # pin_position_updated_at is stamped by the on_places_pin_position_updated
            # trigger, so every writer records it, not just this app.
            result = (
                client.table("places")
                .update({"latitude": latitude, "longitude": longitude})
                .eq("id", place_id)
                .execute()
            )
            row = result.data[0] if result.data else {}
            return {
                "success": True,
                "pin_position_updated_at": row.get("pin_position_updated_at"),
            }
        except Exception as e:
            return {"error": str(e)}

    def _upload_to_supabase(self, file_path, place_id, column="image_path"):
        """Uploads the file to the public place-images bucket and points the
        given places column (image_path or hero_image_path) at it."""
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            filename = os.path.basename(file_path)
            with open(file_path, "rb") as f:
                file_bytes = f.read()
            client.storage.from_("place-images").upload(
                filename,
                file_bytes,
                file_options={"content-type": "image/webp", "upsert": "true"},
            )
            client.table("places").update({column: filename}).eq("id", place_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def save_crop(self, canvas_width, canvas_height, crop_box, img_transform, enhanced, filename="", rotation=0, credit="", place_id=None, target="card"):
        """
        Save the cropped region from the original image.

        canvas_width/height: the canvas dimensions
        crop_box: {x, y, width, height} of the crop overlay on canvas
        img_transform: {x, y, scale, rotation} of the image on canvas
        enhanced: bool - whether to apply auto-enhance before saving
        filename: custom output filename (without extension)
        rotation: rotation angle in degrees
        target: "card" (image_path, 1200x600) or "hero" (hero_image_path,
                2480x800) — see TARGETS. Each is its own crop of the source.
        """
        if self._original_image is None:
            return {"error": "No image loaded"}

        try:
            cfg = load_config()
            spec = resolve_target(cfg, target)
            img = self._original_image.copy()

            if enhanced:
                img = apply_auto_enhance(img)

            cropped = render_crop(
                img, crop_box, img_transform, rotation, credit,
                spec["width"], spec["height"],
            )

            output_folder = resolve_output_folder(cfg)

            # Use custom filename if provided, otherwise fall back to original + timestamp.
            # The target suffix ("-hero") keeps the two outputs from overwriting each other.
            if filename:
                base_name = filename
            else:
                base_name = os.path.splitext(
                    os.path.basename(self._current_image_path)
                )[0]
                base_name = f"{base_name}_{int(time.time())}"
            out_path = os.path.join(output_folder, f"{base_name}{spec['suffix']}.webp")
            cropped.save(out_path, "WEBP", quality=spec["quality"])

            result = {
                "success": True,
                "path": out_path,
                "target": target,
                "column": spec["column"],
                "size_bytes": os.path.getsize(out_path),
            }

            if place_id is not None:
                upload_result = self._upload_to_supabase(out_path, place_id, spec["column"])
                if upload_result.get("error"):
                    result["supabase_error"] = upload_result["error"]
                else:
                    result["uploaded"] = True

            return result
        except Exception as e:
            return {"error": str(e)}

    # --- Place image manager -------------------------------------------------
    # The manager works a place at a time with the card and the hero open side
    # by side, so each panel keeps its own source image instead of sharing the
    # single _original_image the one-shot helper uses. Panels are keyed by
    # target name ("card"/"hero"), so a panel's slot *is* its output target.

    def _slot_image(self, slot):
        entry = self._slot_sources.get(slot)
        return entry["image"] if entry else None

    def _slot_payload(self, slot, img, name):
        # A gigapixel Commons scan would take a gigabyte of RAM and produce a
        # data URL too big to hand the webview. Nothing is lost: the largest
        # output is 2480px wide, so this still leaves room for a tight crop.
        if max(img.width, img.height) > finder.MAX_SLOT_EDGE:
            img = img.copy()
            img.thumbnail((finder.MAX_SLOT_EDGE, finder.MAX_SLOT_EDGE), Image.LANCZOS)
        self._slot_sources[slot] = {"image": img.copy(), "name": name}
        return {
            "slot": slot,
            "data_url": self._image_to_data_url(img),
            "width": img.width,
            "height": img.height,
            "filename": name,
        }

    def get_places_with_images(self):
        """Every place plus the two image columns, so the manager can list and
        filter on what is missing without a round trip per place."""
        try:
            client = self._get_supabase_client()
            cfg = load_config()
            base = cfg.get("supabase_url", "").rstrip("/")
            image_base_url = f"{base}/storage/v1/object/public/place-images/" if base else ""
            if client is None:
                return {"places": [], "image_base_url": image_base_url,
                        "error": "Supabase not configured"}
            PAGE_SIZE = 1000
            all_places = []
            offset = 0
            while True:
                result = (
                    client.table("places")
                    .select("id, name, town, county, image_path, hero_image_path, "
                            "official_website, website")
                    .order("name")
                    .range(offset, offset + PAGE_SIZE - 1)
                    .execute()
                )
                rows = result.data
                all_places.extend(rows)
                if len(rows) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE
            return {"places": all_places, "image_base_url": image_base_url}
        except Exception as e:
            return {"places": [], "image_base_url": "", "error": str(e)}

    def open_slot_image(self, slot):
        file_types = ("Image Files (*.jpg;*.jpeg;*.png;*.webp)",)
        result = self._window.create_file_dialog(
            webview.OPEN_DIALOG, file_types=file_types
        )
        if result and len(result) > 0:
            return self.load_slot_image(slot, result[0])
        return None

    def load_slot_image(self, slot, path):
        try:
            img = ImageOps.exif_transpose(Image.open(path))
            return self._slot_payload(slot, img, os.path.basename(path))
        except Exception as e:
            return {"error": str(e)}

    def load_slot_image_from_url(self, slot, url):
        """Pulls a source over HTTP - used to re-crop the image a place already
        has, and to accept an image URL pasted straight into a panel."""
        if not url or not url.lower().startswith(("http://", "https://")):
            return {"error": "Enter an http(s) image URL"}
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "visit-history-image-helper"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
            img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
            name = os.path.basename(url.split("?")[0]) or "downloaded"
            return self._slot_payload(slot, img, name)
        except Exception as e:
            return {"error": str(e)}

    def load_slot_image_from_data_url(self, slot, data_url, name="pasted"):
        """Takes an image pasted or dropped into a panel, which reaches us as
        bytes rather than a path the file dialog could have given us."""
        try:
            if "," in data_url:
                data_url = data_url.split(",", 1)[1]
            img = ImageOps.exif_transpose(Image.open(io.BytesIO(base64.b64decode(data_url))))
            return self._slot_payload(slot, img, name)
        except Exception as e:
            return {"error": str(e)}

    def copy_slot_image(self, from_slot, to_slot):
        """The card and the hero are usually two crops of the same photo, so the
        second panel can borrow the first panel's source rather than reopening it."""
        entry = self._slot_sources.get(from_slot)
        if entry is None:
            return {"error": f"No image loaded in the {from_slot} panel"}
        return self._slot_payload(to_slot, entry["image"], entry["name"])

    def enhance_slot(self, slot):
        img = self._slot_image(slot)
        if img is None:
            return {"error": "No image loaded"}
        try:
            enhanced = apply_auto_enhance(img.copy())
            return {"data_url": self._image_to_data_url(enhanced)}
        except Exception as e:
            return {"error": str(e)}

    def clear_slot(self, slot):
        self._slot_sources.pop(slot, None)
        return {"success": True}

    def save_slot_crop(self, slot, canvas_width, canvas_height, crop_box,
                       img_transform, enhanced, filename="", rotation=0,
                       credit="", place_id=None, target=None):
        """Same composition as save_crop(), against the panel's own source."""
        img = self._slot_image(slot)
        if img is None:
            return {"error": "No image loaded"}
        target = target or slot
        try:
            cfg = load_config()
            spec = resolve_target(cfg, target)
            img = img.copy()
            if enhanced:
                img = apply_auto_enhance(img)

            cropped = render_crop(
                img, crop_box, img_transform, rotation, credit,
                spec["width"], spec["height"],
            )

            base_name = filename or f"place_{int(time.time())}"
            out_path = os.path.join(
                resolve_output_folder(cfg), f"{base_name}{spec['suffix']}.webp"
            )
            cropped.save(out_path, "WEBP", quality=spec["quality"])

            result = {
                "success": True,
                "path": out_path,
                "target": target,
                "column": spec["column"],
                "stored_filename": os.path.basename(out_path),
                "size_bytes": os.path.getsize(out_path),
            }
            if place_id is not None:
                upload = self._upload_to_supabase(out_path, place_id, spec["column"])
                if upload.get("error"):
                    result["supabase_error"] = upload["error"]
                else:
                    result["uploaded"] = True
            return result
        except Exception as e:
            return {"error": str(e)}

    # --- Image finder --------------------------------------------------------
    # Claude searches Wikimedia Commons, picks a photo per target and says where
    # to crop it; finder.py does the querying, licence filtering and Pillow work.
    # Results are loaded into the panels as sources for review — nothing is
    # written to the place until the user saves it like any other crop.
    #
    # One run can fill several panels. Card and hero share a single search and a
    # single conversation, because the shortlist and the thumbnails are the same
    # either way; the model still picks a different photo per target when one
    # frames better than the other. Slots map to the job so each panel can poll
    # for its own result.

    def _find_state(self, slot):
        with self._finds_lock:
            key = self._slot_job.get(slot)
            return self._finds.get(key) if key else None

    def _find_update(self, key, **fields):
        with self._finds_lock:
            state = self._finds.setdefault(key, {})
            if "message" in fields:
                state.setdefault("messages", []).append(fields.pop("message"))
            state.update(fields)

    def start_find_images(self, place_name, slots, region=""):
        """Runs one search covering every slot named, on a background thread."""
        if not place_name:
            return {"error": "No place selected"}
        if isinstance(slots, str):
            slots = [slots]
        slots = [s for s in slots if s in TARGETS]
        if not slots:
            return {"error": "No valid targets requested"}

        for slot in slots:
            state = self._find_state(slot)
            if state and state.get("status") == "running":
                return {"error": f"A search covering {slot} is already running"}

        cfg = load_config()
        try:
            specs = [dict(resolve_target(cfg, s), name=s) for s in slots]
        except ValueError as e:
            return {"error": str(e)}

        key = f"{'+'.join(slots)}:{time.time()}"
        label = " and ".join(slots)
        with self._finds_lock:
            self._finds[key] = {
                "status": "running",
                "messages": [f"Looking for {label} image(s) for {place_name}"],
                "results": {},
                "error": None,
                "stop": False,
                "started_at": time.time(),
                "slots": list(slots),
            }
            for slot in slots:
                self._slot_job[slot] = key

        threading.Thread(
            target=self._run_find,
            args=(key, place_name, region, specs, cfg),
            daemon=True,
        ).start()
        return {"started": True, "slots": slots}

    def start_find_image(self, slot, place_name, target=None, region=""):
        """Single-panel search, so one target can be re-run on its own."""
        return self.start_find_images(place_name, [target or slot], region)

    def _run_find(self, key, place_name, region, specs, cfg):
        try:
            import finder

            targets = [
                {"name": s["name"], "width": s["width"], "height": s["height"]}
                for s in specs
            ]
            found = finder.find_place_images(
                place_name,
                targets,
                region=region,
                api_key=cfg.get("anthropic_api_key", ""),
                model=cfg.get("finder_model", finder.MODEL),
                allow_sharealike=bool(cfg.get("finder_allow_sharealike", True)),
                progress=lambda msg: self._find_update(key, message=msg),
                should_stop=lambda: bool((self._finds.get(key) or {}).get("stop")),
            )

            self._find_update(key, message="Saving copies and the source records")
            by_name = {s["name"]: s for s in specs}
            payloads = {}
            for name, entry in found.items():
                spec = by_name[name]
                out_path = finder.save_outputs(
                    entry["image"], entry["record"],
                    resolve_output_folder(cfg), slugify(place_name), spec["suffix"],
                )
                # Hand each finished image to its panel exactly like an opened
                # file, so Save and every other control work unchanged.
                payload = self._slot_payload(name, entry["image"], os.path.basename(out_path))
                payload["record"] = entry["record"]
                payload["reason"] = entry["record"].get("reason", "")
                payload["local_path"] = out_path
                payloads[name] = payload

            missing = [s["name"] for s in specs if s["name"] not in payloads]
            self._find_update(
                key, status="done", results=payloads,
                message="Done" + (f" (no image for {', '.join(missing)})" if missing else ""),
            )
        except Exception as e:
            message = str(e) or e.__class__.__name__
            self._find_update(key, status="error", error=message, message=message)

    def get_find_status(self, slot, since=0):
        """Polled by the frontend. `since` is the number of progress lines the
        caller already has, so only new ones come back. Panels sharing a run see
        the same progress and collect their own result."""
        state = self._find_state(slot)
        if state is None:
            return {"status": "idle", "messages": [], "total_messages": 0}
        messages = state.get("messages", [])
        out = {
            "status": state.get("status", "running"),
            "messages": messages[int(since):],
            "total_messages": len(messages),
            "error": state.get("error"),
            "elapsed": round(time.time() - state.get("started_at", time.time())),
            "shared_with": [s for s in state.get("slots", []) if s != slot],
        }
        if state.get("status") == "done":
            result = state.get("results", {}).get(slot)
            out["result"] = result
            if result is None:
                out["error"] = f"No {slot} image was found"
        return out

    def cancel_find(self, slot):
        """Asks the thread to stop at its next checkpoint. Work already in flight
        (an HTTP request, a model turn) finishes first."""
        with self._finds_lock:
            key = self._slot_job.get(slot)
            state = self._finds.get(key) if key else None
        if not state or state.get("status") != "running":
            return {"error": "Nothing to cancel"}
        self._find_update(key, stop=True, message="Cancelling…")
        return {"cancelling": True, "slots": state.get("slots", [slot])}

    def clear_find(self, slot):
        """Drops this slot's claim on its job, and the job once nothing needs it."""
        with self._finds_lock:
            key = self._slot_job.pop(slot, None)
            if key and key not in self._slot_job.values():
                self._finds.pop(key, None)
        return {"success": True}

    def finder_ready(self):
        """Whether a find can run at all, so the UI can explain itself rather
        than failing a minute into a search."""
        cfg = load_config()
        has_key = bool(cfg.get("anthropic_api_key") or os.environ.get("ANTHROPIC_API_KEY"))
        try:
            import anthropic  # noqa: F401

            has_sdk = True
        except ImportError:
            has_sdk = False
        if not has_sdk:
            return {"ready": False, "reason": "The 'anthropic' package is not installed (pip install anthropic)"}
        if not has_key:
            return {"ready": False, "reason": "No Anthropic API key in config.json or ANTHROPIC_API_KEY"}
        return {"ready": True, "model": cfg.get("finder_model", "claude-opus-5")}

    # --- Browse Commons ------------------------------------------------------
    # The other way to fill a panel: the same search and the same licence bar,
    # but the shortlist comes back to the UI instead of to a model, and the user
    # picks. No model call, and the panel gets the full-resolution original to
    # crop rather than a finished image, so framing stays lossless.

    # How deep to follow Commons' continuation for the picker. Each page is 50
    # files and roughly a second, so this is the point where a click stops
    # feeling like a click. A named place's category is rarely near it; when one
    # is, `more_available` tells the user to narrow the search rather than
    # silently truncating.
    BROWSE_MAX_FILES = 200

    def browse_commons(self, query, mode="auto", target="card", large_only=True, limit=0):
        """Returns every usable candidate for the picker grid.

        limit <= 0 means all of them; the grid scrolls and lazy-loads its
        thumbnails, so there is no reason to hold any back.

        The licence bar does not move for this mode: an unusable licence is never
        offered, whoever is choosing. `large_only` is the caller's to relax,
        because a smaller original is a judgement call, not a rights problem.
        """
        try:
            import finder

            cfg = load_config()
            allow_sharealike = bool(cfg.get("finder_allow_sharealike", True))
            spec = resolve_target(cfg, target if target in TARGETS else "card")
            min_width = max(2400, spec["width"]) if large_only else 1
            THUMB = 420

            attempts = ["category", "search"] if mode == "auto" else [mode]
            items, used_mode, more = [], attempts[0], False
            for attempt in attempts:
                try:
                    items, more = finder.commons_query(
                        query, attempt, max_files=self.BROWSE_MAX_FILES
                    )
                except Exception as e:
                    return {"candidates": [], "error": str(e)}
                used_mode = attempt
                if items:
                    break

            kept, rejected = finder.filter_candidates(items, min_width, allow_sharealike)
            # Widest first: at these aspect ratios a wide original survives the
            # crop with the most of its height intact. Size breaks ties, so
            # relaxing large_only cannot float a tiny panorama above a big photo.
            kept.sort(
                key=lambda c: (
                    finder.height_kept_pct(c, spec["width"], spec["height"]),
                    c["width"],
                ),
                reverse=True,
            )

            # Thumbnails only for the tiles that will be shown, which also keeps
            # a PDF in the category from failing the listing request.
            finder.add_thumbnails(kept if int(limit) <= 0 else kept[: int(limit)], THUMB)

            candidates = [
                {
                    "title": c["title"],
                    "name": c["title"].replace("File:", "").rsplit(".", 1)[0],
                    "url": c["url"],
                    "thumburl": c["thumburl"] or c["url"],
                    "page": c["descriptionurl"],
                    "width": c["width"],
                    "height": c["height"],
                    "artist": c["artist"],
                    # What the watermark should say: the full field can run to a
                    # whole title page, which would swamp the image.
                    "credit_name": finder.short_artist(c["artist"]),
                    "licence": c["licence"],
                    "description": c["description"],
                    "keeps_height": {
                        name: finder.height_kept_pct(
                            c, int(cfg[t["width_key"]]), int(cfg[t["height_key"]])
                        )
                        for name, t in TARGETS.items()
                    },
                }
                for c in (kept if int(limit) <= 0 else kept[: int(limit)])
            ]
            return {
                "candidates": candidates,
                "query": query,
                "mode": used_mode,
                "total_usable": len(kept),
                "returned": len(items),
                "filtered_out": len(rejected),
                "more_available": more,
                "reasons": rejected[:6],
            }
        except Exception as e:
            return {"candidates": [], "error": str(e)}

    def clear_place_image(self, place_id, target):
        """Blanks one of the two image columns. The file is left in the bucket -
        other places may point at it, and re-saving overwrites by name anyway."""
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            spec = TARGETS.get(target)
            if spec is None:
                return {"error": f"Unknown target '{target}'"}
            client.table("places").update({spec["column"]: None}).eq("id", place_id).execute()
            return {"success": True, "column": spec["column"]}
        except Exception as e:
            return {"error": str(e)}

    def suggest_filename(self, name):
        return {"filename": slugify(name)}

    def get_auth_users(self):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"users": [], "error": "Supabase not configured"}
            all_users = []
            page = 1
            per_page = 1000
            while True:
                res = client.auth.admin.list_users(page=page, per_page=per_page)
                users = res if isinstance(res, list) else getattr(res, "users", res)
                if not users:
                    break
                for u in users:
                    uid = u.id if hasattr(u, "id") else u.get("id")
                    email = u.email if hasattr(u, "email") else u.get("email", "")
                    created = u.created_at if hasattr(u, "created_at") else u.get("created_at", "")
                    meta = u.user_metadata if hasattr(u, "user_metadata") else u.get("user_metadata", {})
                    display = ""
                    if meta:
                        display = meta.get("display_name", "") or meta.get("full_name", "") or meta.get("name", "")
                    all_users.append({
                        "id": str(uid),
                        "email": email or "",
                        "display_name": display,
                        "created_at": str(created) if created else "",
                    })
                if len(users) < per_page:
                    break
                page += 1
            all_users.sort(key=lambda u: u["created_at"], reverse=True)
            return {"users": all_users}
        except Exception as e:
            return {"users": [], "error": str(e)}

    # Logs live in two tables: app_logs (the mobile app) and web_logs (the
    # website). They share the core columns but not the level names — the web
    # writes info/warn where the app writes information/warning — so web rows
    # are normalised to the app's names on the way out and a level filter is
    # translated back on the way in. Each row is tagged log_source ("app" or
    # "web"); web_logs' own "source" column (server/client) is left untouched.
    APP_LOG_COLUMNS = (
        "id, created_at, user_id, level, category, message, context, "
        "exception_type, exception_message, stack_trace, "
        "device_platform, device_version, app_version"
    )
    WEB_LOG_COLUMNS = (
        "id, created_at, user_id, level, category, message, context, "
        "exception_type, exception_message, stack_trace, "
        "source, route, method, status, request_id, deployment_id, environment"
    )
    WEB_LEVEL_TO_APP = {"info": "information", "warn": "warning", "fatal": "critical"}
    APP_LEVEL_TO_WEB = {
        "information": ["information", "info"],
        "warning": ["warning", "warn"],
        "critical": ["critical", "fatal"],
    }
    LOG_TABLES = {"app": ("app_logs", APP_LOG_COLUMNS), "web": ("web_logs", WEB_LOG_COLUMNS)}

    def _query_log_table(self, client, log_source, limit, before=None, level="", user_id=None):
        table, columns = self.LOG_TABLES[log_source]
        query = client.table(table).select(columns)
        if user_id:
            if log_source == "web":
                # Web logs often carry the user only inside context.userId.
                query = query.or_(f"user_id.eq.{user_id},context->>userId.eq.{user_id}")
            else:
                query = query.eq("user_id", user_id)
        if level:
            if log_source == "web":
                query = query.in_("level", self.APP_LEVEL_TO_WEB.get(level, [level]))
            else:
                query = query.eq("level", level)
        if before:
            query = query.lt("created_at", before)
        rows = query.order("created_at", desc=True).limit(limit).execute().data or []
        for row in rows:
            row["log_source"] = log_source
            if log_source == "web":
                if not row.get("user_id"):
                    row["user_id"] = (row.get("context") or {}).get("userId") or None
                row["level"] = self.WEB_LEVEL_TO_APP.get(row.get("level"), row.get("level"))
        return rows

    def _fetch_logs(self, page_size, source="all", before=None, level="", user_id=None):
        """Keyset-paged log fetch across one or both tables.

        `before` is the created_at of the last row already shown; the next
        page is everything older. Merging two tables by time only works with a
        cursor — page numbers would skip or repeat rows as the two interleave.
        """
        client = self._get_supabase_client()
        if client is None:
            return {"logs": [], "error": "Supabase not configured"}
        sources = ["app", "web"] if source == "all" else [source]
        merged, has_more = [], False
        for log_source in sources:
            rows = self._query_log_table(client, log_source, page_size, before, level, user_id)
            has_more = has_more or len(rows) >= page_size
            merged.extend(rows)
        merged.sort(key=lambda r: r["created_at"], reverse=True)
        if len(merged) > page_size:
            has_more = True
            merged = merged[:page_size]
        next_before = merged[-1]["created_at"] if merged and has_more else None
        return {"logs": merged, "page_size": page_size, "has_more": has_more, "next_before": next_before}

    def get_logs_for_user(self, user_id, page_size=100, source="all", before=None, level=""):
        try:
            return self._fetch_logs(page_size, source, before, level, user_id=user_id)
        except Exception as e:
            return {"logs": [], "error": str(e)}

    def get_all_logs(self, page_size=100, source="all", before=None, level=""):
        try:
            return self._fetch_logs(page_size, source, before, level)
        except Exception as e:
            return {"logs": [], "error": str(e)}

    def get_visits(self, page=1, page_size=10):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"visits": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size
            result = (
                client.table("visits")
                .select("id, user_id, place_id, visited_at, notes, rating, is_favorite, nhle_list_entry, nhle_name, nhle_grade, cadw_fid, cadw_name, cadw_grade, public_comments, published")
                .order("visited_at", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            visits = result.data or []

            # Fetch place names for visits that have a place_id
            place_ids = list({v["place_id"] for v in visits if v.get("place_id")})
            place_map = {}
            if place_ids:
                places_result = (
                    client.table("places")
                    .select("id, name")
                    .in_("id", place_ids)
                    .execute()
                )
                for p in (places_result.data or []):
                    place_map[p["id"]] = p["name"]

            # Fetch photos for all visits in this page
            visit_ids = [v["id"] for v in visits]
            photo_map = {}
            if visit_ids:
                photos_result = (
                    client.table("visit_photos")
                    .select("id, visit_id, storage_path, comment, is_public")
                    .in_("visit_id", visit_ids)
                    .order("created_at")
                    .execute()
                )
                for photo in (photos_result.data or []):
                    vid = photo["visit_id"]
                    if vid not in photo_map:
                        photo_map[vid] = []
                    photo_map[vid].append(photo)

            # Generate signed URLs for photos (bucket is private)
            for v in visits:
                v["place_name"] = place_map.get(v.get("place_id"), "")
                photos = photo_map.get(v["id"], [])
                for photo in photos:
                    try:
                        signed = client.storage.from_("visit-photos").create_signed_url(
                            photo["storage_path"], 3600
                        )
                        photo["url"] = signed.get("signedURL", "") or signed.get("signedUrl", "")
                    except Exception:
                        photo["url"] = ""
                v["photos"] = photos

            return {"visits": visits, "page": page, "page_size": page_size}
        except Exception as e:
            return {"visits": [], "error": str(e)}

    def get_visits_for_map(self):
        """Every visit that can be placed on a map, with coordinates resolved.

        NHLE and Cadw visits carry their own coordinates; place visits take
        them from the linked place row.
        """
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"visits": [], "error": "Supabase not configured"}
            PAGE_SIZE = 1000
            rows = []
            offset = 0
            while True:
                result = (
                    client.table("visits")
                    .select(
                        "id, user_id, place_id, visited_at, rating, is_favorite, "
                        "nhle_list_entry, nhle_name, nhle_latitude, nhle_longitude, nhle_layer_id, "
                        "cadw_fid, cadw_name, cadw_latitude, cadw_longitude, cadw_layer_id, "
                        "places(name, latitude, longitude)"
                    )
                    .order("visited_at", desc=True)
                    .range(offset, offset + PAGE_SIZE - 1)
                    .execute()
                )
                batch = result.data or []
                rows.extend(batch)
                if len(batch) < PAGE_SIZE:
                    break
                offset += PAGE_SIZE

            visits = []
            for r in rows:
                place = r.get("places") or {}
                if r.get("place_id") and place.get("latitude") is not None:
                    kind, layer_id = "place", None
                    name = place.get("name") or ""
                    lat, lon = place.get("latitude"), place.get("longitude")
                elif r.get("nhle_latitude") is not None:
                    kind, layer_id = "nhle", r.get("nhle_layer_id")
                    name = r.get("nhle_name") or ""
                    lat, lon = r.get("nhle_latitude"), r.get("nhle_longitude")
                elif r.get("cadw_latitude") is not None:
                    kind, layer_id = "cadw", r.get("cadw_layer_id")
                    name = r.get("cadw_name") or ""
                    lat, lon = r.get("cadw_latitude"), r.get("cadw_longitude")
                else:
                    continue
                if lat is None or lon is None:
                    continue
                visits.append({
                    "id": r["id"],
                    "user_id": r.get("user_id"),
                    "visited_at": r.get("visited_at"),
                    "rating": r.get("rating"),
                    "is_favorite": r.get("is_favorite"),
                    "kind": kind,
                    "layer_id": layer_id,
                    "name": name,
                    "latitude": lat,
                    "longitude": lon,
                })
            return {"visits": visits, "total": len(rows)}
        except Exception as e:
            return {"visits": [], "error": str(e)}

    def get_active_users(self):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"users": [], "error": "Supabase not configured"}

            # Calls the get_user_last_active() SQL function (create it via the
            # Supabase SQL editor):
            #   create or replace function get_user_last_active()
            #   returns table(user_id uuid, last_active timestamptz)
            #   language sql security definer as $$
            #     select user_id, max(created_at) as last_active
            #     from app_logs where user_id is not null group by user_id;
            #   $$;
            result = client.rpc("get_user_last_active").execute()
            app_active = {
                row["user_id"]: row["last_active"]
                for row in (result.data or [])
            }
            # web_logs is small and has no matching SQL function; fold its
            # activity in from the most recent rows, taking the user from
            # context.userId when the column is blank.
            web_active = {}
            web_rows = (
                client.table("web_logs")
                .select("user_id, context, created_at")
                .order("created_at", desc=True)
                .limit(5000)
                .execute()
                .data or []
            )
            for row in web_rows:
                uid = row.get("user_id") or (row.get("context") or {}).get("userId")
                if uid and row["created_at"] > (web_active.get(uid) or ""):
                    web_active[uid] = row["created_at"]

            auth_result = self.get_auth_users()
            all_users = auth_result.get("users", [])

            with_activity, without_activity = [], []
            for u in all_users:
                u = dict(u)
                u["last_active_app"] = app_active.get(u["id"])
                u["last_active_web"] = web_active.get(u["id"])
                u["last_active"] = max(
                    filter(None, [u["last_active_app"], u["last_active_web"]]),
                    default=None,
                )
                (with_activity if u["last_active"] else without_activity).append(u)

            with_activity.sort(key=lambda u: u["last_active"], reverse=True)
            return {"users": with_activity + without_activity}
        except Exception as e:
            return {"users": [], "error": str(e)}

    def get_place_tags(self, page=1, page_size=50, search="", user_id="", approved=""):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"place_tags": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size

            # !inner so filters on the embedded tables actually exclude rows
            query = client.table("place_tags").select(
                "id, created_at, created_by, place_id, tag_id,"
                " places!inner(name, town, county),"
                " tags!inner(name, slug, category, is_approved)"
            )
            if user_id:
                query = query.eq("created_by", user_id)
            if approved == "approved":
                query = query.eq("tags.is_approved", "true")
            elif approved == "unapproved":
                query = query.eq("tags.is_approved", "false")
            if search:
                # Quotes/backslashes would break out of the quoted or() value
                term = search.replace("\\", "").replace('"', "")
                query = query.or_(
                    f'places.name.ilike."*{term}*",tags.name.ilike."*{term}*"'
                )

            result = (
                query
                .order("created_at", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )

            rows = []
            for r in (result.data or []):
                place = r.get("places") or {}
                tag = r.get("tags") or {}
                rows.append({
                    "id": r["id"],
                    "created_at": r.get("created_at"),
                    "created_by": r.get("created_by"),
                    "place_id": r.get("place_id"),
                    "place_name": place.get("name") or "",
                    "place_town": place.get("town") or "",
                    "place_county": place.get("county") or "",
                    "tag_id": r.get("tag_id"),
                    "tag_name": tag.get("name") or "",
                    "tag_slug": tag.get("slug") or "",
                    "tag_category": tag.get("category") or "",
                    "tag_approved": bool(tag.get("is_approved")),
                })
            return {"place_tags": rows, "page": page, "page_size": page_size}
        except Exception as e:
            return {"place_tags": [], "error": str(e)}

    def get_place_tag_users(self):
        """Distinct user ids that have applied at least one tag, for the filter dropdown."""
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"user_ids": [], "error": "Supabase not configured"}
            result = (
                client.table("place_tags")
                .select("created_by")
                .not_.is_("created_by", "null")
                .order("created_at", desc=True)
                .limit(10000)
                .execute()
            )
            seen = []
            for r in (result.data or []):
                uid = r.get("created_by")
                if uid and uid not in seen:
                    seen.append(uid)
            return {"user_ids": seen}
        except Exception as e:
            return {"user_ids": [], "error": str(e)}

    # ── Tag moderation ────────────────────────────────────────────────────
    # These call the *_service RPCs from supabase_migration_tag_admin_service.sql.
    # The app's own admin_* RPCs gate on a JWT is_admin claim, which the secret
    # key this app connects with does not carry.

    def get_pending_tags(self, limit=100, offset=0):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"tags": [], "error": "Supabase not configured"}
            result = client.rpc(
                "get_admin_pending_tags_service",
                {"p_limit": limit, "p_offset": offset},
            ).execute()
            return {"tags": result.data or []}
        except Exception as e:
            return {"tags": [], "error": self._rpc_error(e)}

    def get_approved_tags(self):
        """Approved tags, used as the target list when merging."""
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"tags": [], "error": "Supabase not configured"}
            result = (
                client.table("tags")
                .select("id, name, slug, category")
                .eq("is_approved", True)
                .order("name")
                .execute()
            )
            return {"tags": result.data or []}
        except Exception as e:
            return {"tags": [], "error": str(e)}

    def approve_tag(self, tag_id, category):
        if not category:
            return {"error": "Pick a category before approving"}
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.rpc(
                "admin_approve_tag_service",
                {"p_tag_id": tag_id, "p_category": category},
            ).execute()
            return {"success": True}
        except Exception as e:
            return {"error": self._rpc_error(e)}

    def reject_tag(self, tag_id):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.rpc("admin_reject_tag_service", {"p_tag_id": tag_id}).execute()
            return {"success": True}
        except Exception as e:
            return {"error": self._rpc_error(e)}

    def merge_tag(self, source_id, target_id):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.rpc(
                "admin_merge_tag_service",
                {"p_source_id": source_id, "p_target_id": target_id},
            ).execute()
            return {"success": True}
        except Exception as e:
            return {"error": self._rpc_error(e)}

    def get_tag_removal_requests(self, limit=100, offset=0):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"requests": [], "error": "Supabase not configured"}
            result = client.rpc(
                "get_admin_tag_removal_requests_service",
                {"p_limit": limit, "p_offset": offset},
            ).execute()
            return {"requests": result.data or []}
        except Exception as e:
            return {"requests": [], "error": self._rpc_error(e)}

    def execute_removal_request(self, request_id):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.rpc(
                "admin_execute_removal_request_service", {"p_request_id": request_id}
            ).execute()
            return {"success": True}
        except Exception as e:
            return {"error": self._rpc_error(e)}

    def dismiss_removal_request(self, request_id):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.rpc(
                "admin_dismiss_removal_request_service", {"p_request_id": request_id}
            ).execute()
            return {"success": True}
        except Exception as e:
            return {"error": self._rpc_error(e)}

    @staticmethod
    def _rpc_error(exc):
        """A missing *_service function means the migration hasn't been run yet;
        say so rather than surfacing a bare PGRST202."""
        text = str(exc)
        if "PGRST202" in text or "Could not find the function" in text:
            return (
                "Tag moderation RPCs not found — run "
                "supabase_migration_tag_admin_service.sql in the Supabase SQL editor"
            )
        return text

    def get_subscription_starts(self):
        """Every row that has ever subscribed, for the dashboard chart.

        Returns the whole table (paged internally) rather than a page, so the
        frontend can re-bucket by date range without another round-trip.
        """
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"subscriptions": [], "error": "Supabase not configured"}
            rows = []
            page_size = 1000
            offset = 0
            while True:
                result = (
                    client.table("subscriptions")
                    .select("user_id, first_subscribed_at, product_id, is_subscribed")
                    .not_.is_("first_subscribed_at", "null")
                    .order("first_subscribed_at", desc=True)
                    .range(offset, offset + page_size - 1)
                    .execute()
                )
                batch = result.data or []
                rows.extend(batch)
                if len(batch) < page_size:
                    break
                offset += page_size
            return {"subscriptions": rows}
        except Exception as e:
            return {"subscriptions": [], "error": str(e)}

    def get_subscriptions(self, page=1, page_size=50, status="active"):
        """Current subscription state from public.subscriptions (one row per user).

        status: "active" (is_subscribed), "lapsed" (not is_subscribed), or "" for all.
        """
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"subscriptions": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size

            query = client.table("subscriptions").select(
                "user_id, is_subscribed, product_id, expires_at, platform,"
                " first_subscribed_at, last_checked_at, updated_at"
            )
            if status == "active":
                query = query.eq("is_subscribed", True)
            elif status == "lapsed":
                query = query.eq("is_subscribed", False)

            result = (
                query
                # Newest subscribers first; rows that never subscribed have a
                # null first_subscribed_at and sort to the bottom
                .order("first_subscribed_at", desc=True, nullsfirst=False)
                .range(offset, offset + page_size - 1)
                .execute()
            )

            subscriptions = []
            for row in (result.data or []):
                product_id = row.get("product_id") or ""
                if "yearly" in product_id:
                    sub_type = "yearly"
                elif "monthly" in product_id:
                    sub_type = "monthly"
                else:
                    sub_type = "unknown"
                subscriptions.append({
                    "user_id": row.get("user_id"),
                    "is_subscribed": bool(row.get("is_subscribed")),
                    "product_id": product_id,
                    "subscription_type": sub_type,
                    "expires_at": row.get("expires_at"),
                    "platform": row.get("platform") or "",
                    "first_subscribed_at": row.get("first_subscribed_at"),
                    "last_checked_at": row.get("last_checked_at"),
                    "updated_at": row.get("updated_at"),
                })
            return {"subscriptions": subscriptions, "page": page, "page_size": page_size}
        except Exception as e:
            return {"subscriptions": [], "error": str(e)}

    def update_photo_comment(self, photo_id, comment):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.table("visit_photos").update({"comment": comment}).eq("id", photo_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def update_visit_published(self, visit_id, published):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.table("visits").update({"published": bool(published)}).eq("id", visit_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def update_visit_comments(self, visit_id, public_comments):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"error": "Supabase not configured"}
            client.table("visits").update({"public_comments": public_comments}).eq("id", visit_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def download_visit_photo(self, url, filename):
        try:
            downloads_dir = os.path.join(os.path.expanduser("~"), "Downloads")
            os.makedirs(downloads_dir, exist_ok=True)
            dest = os.path.join(downloads_dir, filename)
            urllib.request.urlretrieve(url, dest)
            return {"success": True, "path": dest}
        except Exception as e:
            return {"error": str(e)}

    def choose_output_folder(self):
        result = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        if result and len(result) > 0:
            folder = result[0]
            cfg = load_config()
            cfg["output_folder"] = folder
            save_config(cfg)
            return {"folder": folder}
        return None

    def _image_to_data_url(self, img):
        buffer = io.BytesIO()
        fmt = "JPEG"
        mime = "image/jpeg"
        if img.mode == "RGBA":
            fmt = "PNG"
            mime = "image/png"
        img.save(buffer, format=fmt, quality=90)
        b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
        return f"data:{mime};base64,{b64}"
