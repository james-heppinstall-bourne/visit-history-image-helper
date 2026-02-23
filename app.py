import os
import webview
from backend import Api, load_config


def main():
    load_config()

    api = Api()
    web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

    window = webview.create_window(
        "Image Crop Helper",
        url=os.path.join(web_dir, "index.html"),
        js_api=api,
        width=1000,
        height=750,
        min_size=(800, 600),
    )
    api.set_window(window)

    webview.start(debug=False)


if __name__ == "__main__":
    main()
