"""A synthetic window showing only generated content.

Run as its own process, not a thread: Tk is not thread-safe, and driving it
from a background thread while pytest runs on the main one segfaults the
interpreter on Windows. A separate process is also closer to what a real
capture target is.

    python _fixture_window.py --title T --seconds 30 --flip-after 3
"""
from __future__ import annotations

import argparse
import sys
import tkinter as tk


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--title", default="WatchSkillCaptureFixture")
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--flip-after", type=float, default=3.0)
    args = parser.parse_args(argv)

    root = tk.Tk()
    root.title(args.title)
    root.geometry("640x360+60+60")
    label = tk.Label(root, text="READY", font=("Consolas", 56),
                     bg="#0b3d2e", fg="white")
    label.pack(fill="both", expand=True)

    def flip() -> None:
        label.config(text="ERROR 502", bg="#7a1616")

    root.after(int(args.flip_after * 1000), flip)
    root.after(int(args.seconds * 1000), root.destroy)
    # Tell the parent the window is up, so it never captures a blank frame.
    root.after(300, lambda: (print("READY", flush=True)))
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
