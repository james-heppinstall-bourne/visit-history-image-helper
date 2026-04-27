import base64
import io
import json
import os
import time

import webview
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

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
    "supabase_url": "",
    "supabase_key": "",
}


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
            img = self._original_image.copy()
            img = ImageOps.autocontrast(img, cutoff=1)
            img = ImageEnhance.Sharpness(img).enhance(1.3)
            img = ImageEnhance.Color(img).enhance(1.1)
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

    def _upload_to_supabase(self, file_path, place_id):
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
            client.table("places").update({"image_path": filename}).eq("id", place_id).execute()
            return {"success": True}
        except Exception as e:
            return {"error": str(e)}

    def save_crop(self, canvas_width, canvas_height, crop_box, img_transform, enhanced, filename="", rotation=0, credit="", place_id=None):
        """
        Save the cropped region from the original image.

        canvas_width/height: the canvas dimensions
        crop_box: {x, y, width, height} of the crop overlay on canvas
        img_transform: {x, y, scale, rotation} of the image on canvas
        enhanced: bool - whether to apply auto-enhance before saving
        filename: custom output filename (without extension)
        rotation: rotation angle in degrees
        """
        if self._original_image is None:
            return {"error": "No image loaded"}

        try:
            cfg = load_config()
            img = self._original_image.copy()

            if enhanced:
                img = ImageOps.autocontrast(img, cutoff=1)
                img = ImageEnhance.Sharpness(img).enhance(1.3)
                img = ImageEnhance.Color(img).enhance(1.1)

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

            target_w = cfg["crop_width"]
            target_h = cfg["crop_height"]
            cropped = cropped.resize((target_w, target_h), Image.LANCZOS)

            if credit:
                draw = ImageDraw.Draw(cropped, "RGBA")
                font_size = 20
                try:
                    font = ImageFont.truetype("arial.ttf", font_size)
                except OSError:
                    font = ImageFont.load_default()
                bbox = draw.textbbox((0, 0), credit, font=font)
                tw = bbox[2] - bbox[0]
                th = bbox[3] - bbox[1]
                padding = 8
                rx = target_w - tw - padding * 2
                ry = target_h - th - padding * 2
                draw.rectangle(
                    [rx, ry, rx + tw + padding * 2, ry + th + padding * 2],
                    fill=(0, 0, 0, 128),
                )
                draw.text((rx + padding, ry + padding), credit, fill="white", font=font)

            output_folder = cfg["output_folder"]
            if not os.path.isabs(output_folder):
                output_folder = os.path.join(
                    os.path.dirname(os.path.abspath(__file__)), output_folder
                )
            os.makedirs(output_folder, exist_ok=True)

            # Use custom filename if provided, otherwise fall back to original + timestamp
            if filename:
                out_path = os.path.join(output_folder, f"{filename}.webp")
            else:
                base_name = os.path.splitext(
                    os.path.basename(self._current_image_path)
                )[0]
                timestamp = int(time.time())
                out_path = os.path.join(output_folder, f"{base_name}_{timestamp}.webp")

            if cropped.mode == "RGBA":
                cropped = cropped.convert("RGB")
            cropped.save(out_path, "WEBP", quality=cfg["webp_quality"])

            result = {"success": True, "path": out_path}

            if place_id is not None:
                upload_result = self._upload_to_supabase(out_path, place_id)
                if upload_result.get("error"):
                    result["supabase_error"] = upload_result["error"]
                else:
                    result["uploaded"] = True

            return result
        except Exception as e:
            return {"error": str(e)}

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

    def get_logs_for_user(self, user_id, page=1, page_size=100):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"logs": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size
            result = (
                client.table("app_logs")
                .select("id, created_at, level, category, message, context, exception_type, exception_message, stack_trace, device_platform, device_version, app_version")
                .eq("user_id", user_id)
                .order("created_at", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            return {"logs": result.data, "page": page, "page_size": page_size}
        except Exception as e:
            return {"logs": [], "error": str(e)}

    def get_all_logs(self, page=1, page_size=100, level=""):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"logs": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size
            query = (
                client.table("app_logs")
                .select("id, created_at, user_id, level, category, message, context, exception_type, exception_message, stack_trace, device_platform, device_version, app_version")
            )
            if level:
                query = query.eq("level", level)
            result = (
                query
                .order("created_at", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            return {"logs": result.data, "page": page, "page_size": page_size}
        except Exception as e:
            return {"logs": [], "error": str(e)}

    def get_visits(self, page=1, page_size=50):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"visits": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size
            result = (
                client.table("visits")
                .select("id, user_id, place_id, visited_at, notes, rating, is_favorite, nhle_list_entry, nhle_name, nhle_grade, cadw_fid, cadw_name, cadw_grade, public_comments")
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
            last_active_map = {
                row["user_id"]: row["last_active"]
                for row in (result.data or [])
            }

            auth_result = self.get_auth_users()
            all_users = auth_result.get("users", [])

            with_activity, without_activity = [], []
            for u in all_users:
                u = dict(u)
                u["last_active"] = last_active_map.get(u["id"])
                (with_activity if u["last_active"] else without_activity).append(u)

            with_activity.sort(key=lambda u: u["last_active"], reverse=True)
            return {"users": with_activity + without_activity}
        except Exception as e:
            return {"users": [], "error": str(e)}

    def get_subscriptions(self, page=1, page_size=50):
        try:
            client = self._get_supabase_client()
            if client is None:
                return {"subscriptions": [], "error": "Supabase not configured"}
            offset = (page - 1) * page_size

            # Find successful subscription purchase logs:
            # [SUB] PurchaseSubscriptionAsync for visithistory_subscription_yearly/monthly
            # followed by [PAYWALL] PurchaseSubscriptionAsync returned: Success
            # We query for the [SUB] line which contains the subscription type
            result = (
                client.table("app_logs")
                .select("id, created_at, user_id, message")
                .like("message", "%[SUB] PurchaseSubscriptionAsync for visithistory_subscription_%")
                .order("created_at", desc=True)
                .range(offset, offset + page_size - 1)
                .execute()
            )
            logs = result.data or []
            subscriptions = []
            for log in logs:
                msg = log.get("message", "")
                if "visithistory_subscription_yearly" in msg:
                    sub_type = "yearly"
                elif "visithistory_subscription_monthly" in msg:
                    sub_type = "monthly"
                else:
                    sub_type = "unknown"
                subscriptions.append({
                    "id": log["id"],
                    "user_id": log.get("user_id"),
                    "created_at": log.get("created_at"),
                    "subscription_type": sub_type,
                })
            return {"subscriptions": subscriptions, "page": page, "page_size": page_size}
        except Exception as e:
            return {"subscriptions": [], "error": str(e)}

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
