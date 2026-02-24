# Visit History Image Helper

Pywebview desktop app for cropping images to a fixed aspect ratio with auto-enhance, rotation, zoom, and photo credit watermark overlay.

## Project structure

- `app.py` — Entry point; creates the pywebview window and wires up the API
- `backend.py` — Python API exposed to the frontend (file dialogs, image processing, crop/save)
- `web/index.html` — Single-page UI
- `web/style.css` — Dark theme styles
- `web/app.js` — Frontend state, canvas rendering, event handlers
- `config.json` — Runtime config (crop dimensions, output folder, webp quality); auto-created on first run

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
- Crop coordinates are computed in canvas space and converted to image space in `save_crop()`
- All saved images are output as WebP
