import os
import webview
from backend import Api, load_config


def main():
    load_config()

    api = Api()
    web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

    window = webview.create_window(
        "Visit History Image Helper",
        url=os.path.join(web_dir, "home.html"),
        js_api=api,
        # Sized for the place image manager, which puts the place list and both
        # crops on screen at once; the other screens just get more room.
        width=1400,
        height=900,
        min_size=(1000, 650),
    )
    api.set_window(window)

    webview.start(debug=False)


if __name__ == "__main__":
    main()
