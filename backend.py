import base64
import io
import json
import os
import time

import webview
from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps


CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
DEFAULT_CONFIG = {
    "crop_width": 1200,
    "crop_height": 600,
    "output_folder": "./output",
    "webp_quality": 80,
}


def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r") as f:
            return json.load(f)
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

    def save_crop(self, canvas_width, canvas_height, crop_box, img_transform, enhanced, filename="", rotation=0, credit=""):
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

            return {"success": True, "path": out_path}
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
