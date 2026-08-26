"""The comparison chart, drawn from the raw result.

A chart in a repository is a claim, and the usual way it goes wrong is that
it stops matching the numbers beside it — someone edits a figure, or draws it
once by hand and never redraws it. So this renders straight from the same
result object the report reads, with no data of its own, and is regenerated
every time the report is.

The layout is a grid of small panels, one per measured axis, with each bar's
value printed above it. Three rules keep it from flattering anyone:

* **A tie is drawn as a tie** — equal bars, labelled. Watch Skill and a
  provider that both shell out to the same `ffmpeg` agree exactly, and hiding
  that would make the rest of the chart untrustworthy.
* **Only axes measured on both sides appear.** There is no bar for something
  one side does not do; that is a capability difference and belongs in prose.
* **Lower-is-better axes are drawn to scale and marked**, not silently
  inverted. The taller bar there is the worse one, and the panel says so —
  quietly flipping the geometry would make the number and the picture
  disagree.

Plain SVG: no library, no web fonts. It paints its own white background on
purpose — a first version left it transparent with dark text, which vanished
the moment anyone opened it in a dark-mode viewer. A committed image cannot
resolve the reader's CSS variables or know their theme, so it carries its own
ground and looks identical everywhere.
"""
from __future__ import annotations

import math
from typing import Any

OURS = "#2a78d6"
THEIRS = "#eb6834"
PAPER = "#ffffff"
INK = "#18181b"
MUTED = "#52525b"
FAINT = "#8b8b93"
RULE = "#d4d4d8"

# Applied as an attribute on every text element rather than through a
# `<style>` block: GitHub strips embedded stylesheets from SVGs it serves,
# and a chart whose type sizes vanish renders as overlapping default text.
_FONT = "system-ui,-apple-system,Segoe UI,Roboto,Helvetica,sans-serif"

_COLS = 4
_PANEL_W = 246
_PLOT_H = 178
_BAR_W = 50
_BAR_GAP = 20
_PAD = 30
_PANEL_LABEL_H = 62


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _format(value: float, unit: str) -> str:
    if unit == "%":
        return f"{value:.0f}" if float(value).is_integer() else f"{value:.1f}"
    if unit.startswith("s"):
        return f"{value:.3f}"
    return f"{value:g}"


def _wrap(text: str, width: int = 22) -> list[str]:
    words, lines, current = text.split(), [], ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) > width and current:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines[:2]


def render_chart(axes: list[Any], *, title: str = "") -> str:
    """A GLM-style panel grid, one panel per comparable axis."""
    rows = [
        a for a in axes
        if a.watch_skill and a.provider
        and a.watch_skill.value is not None and a.provider.value is not None
    ]
    if not rows:
        return (
            '<svg xmlns="http://www.w3.org/2000/svg" width="620" height="60" '
            'role="img" aria-label="No comparable axes were measured">'
            f'<text x="14" y="34" font-family="sans-serif" font-size="14" '
            f'fill="{INK}">No axis was measured on both sides.</text></svg>'
        )

    columns = min(_COLS, len(rows))
    grid_rows = math.ceil(len(rows) / columns)
    width = _PAD * 2 + columns * _PANEL_W
    head = 104
    height = head + grid_rows * (_PLOT_H + _PANEL_LABEL_H) + _PAD

    ties = sum(1 for a in rows if a.verdict == "tie")
    # Deliberately not a scoreline. This is a preview of a days-old release,
    # and "ahead on 5, behind on 0" reads as a league table rather than as a
    # set of measurements — which invites the reader to take the count as the
    # finding instead of the numbers.
    subtitle = (
        f"{len(rows)} axes measured on the same files, with the same scorer, "
        f"on the same machine"
        + (f" · {ties} exact tie" + ("s" if ties != 1 else "") if ties else "")
    )

    out: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" '
        f'aria-label="{_escape(title or "Benchmark comparison")}. {_escape(subtitle)}">',
        # Its own ground. Without this the chart is transparent, and every
        # label disappears against a dark-mode background.
        f'<rect width="{width}" height="{height}" fill="{PAPER}"/>',
    ]
    if title:
        out.append(
            f'<text font-family="{_FONT}" font-size="20" font-weight="600" x="{_PAD}" y="36" fill="{INK}">{_escape(title)}</text>'
        )
    out.append(
        f'<text font-family="{_FONT}" font-size="13" x="{_PAD}" y="58" fill="{MUTED}">{_escape(subtitle)}</text>'
    )
    out += [
        f'<rect x="{_PAD}" y="74" width="12" height="12" rx="3" fill="{OURS}"/>',
        f'<text font-family="{_FONT}" font-size="13" font-weight="500" x="{_PAD + 19}" y="84" fill="{INK}">Watch Skill</text>',
        f'<rect x="{_PAD + 126}" y="74" width="12" height="12" rx="3" fill="{THEIRS}"/>',
        f'<text font-family="{_FONT}" font-size="13" font-weight="500" x="{_PAD + 145}" y="84" fill="{INK}">'
        'Adversal MCP 0.1.4</text>',
        f'<line x1="{_PAD}" y1="97" x2="{width - _PAD}" y2="97" '
        f'stroke="{RULE}" stroke-width="1"/>',
    ]

    for index, axis in enumerate(rows):
        col, row = index % columns, index // columns
        x0 = _PAD + col * _PANEL_W
        y0 = head + row * (_PLOT_H + _PANEL_LABEL_H)
        baseline = y0 + _PLOT_H

        ours = float(axis.watch_skill.value)
        theirs = float(axis.provider.value)
        # Percentages are drawn against 100, not against the taller bar, so 90%
        # does not look like a perfect score. Other units have no natural
        # ceiling and are normalised within their own panel; a shared axis
        # would squash an IoU against a percentage.
        top = 100.0 if axis.unit == "%" else (max(ours, theirs) or 1.0)
        usable = _PLOT_H - 26

        centre = x0 + _PANEL_W / 2
        left = centre - _BAR_W - _BAR_GAP / 2

        # A faint ceiling line on percentage panels, so a bar's height can be
        # read as a share of 100 rather than only against its neighbour.
        if axis.unit == "%":
            out.append(
                f'<line x1="{left - 10:.1f}" y1="{baseline - usable:.1f}" '
                f'x2="{left + 2 * _BAR_W + _BAR_GAP + 10:.1f}" '
                f'y2="{baseline - usable:.1f}" stroke="{RULE}" stroke-width="1" '
                f'stroke-dasharray="3 3"/>'
            )
        for offset, (value, colour) in enumerate(
            ((ours, OURS), (theirs, THEIRS))
        ):
            bar_h = max(3.0, value / top * usable)
            bar_x = left + offset * (_BAR_W + _BAR_GAP)
            bar_y = baseline - bar_h
            out.append(
                f'<rect x="{bar_x:.1f}" y="{bar_y:.1f}" width="{_BAR_W}" '
                f'height="{bar_h:.1f}" rx="3" fill="{colour}"/>'
            )
            out.append(
                f'<text font-family="{_FONT}" font-size="13" font-weight="600" x="{bar_x + _BAR_W / 2:.1f}" '
                f'y="{bar_y - 8:.1f}" fill="{colour}" text-anchor="middle">'
                f'{_escape(_format(value, axis.unit))}</text>'
            )
        out.append(
            f'<line x1="{x0 + 16}" y1="{baseline + 0.5}" x2="{x0 + _PANEL_W - 16}" '
            f'y2="{baseline + 0.5}" stroke="{RULE}" stroke-width="1"/>'
        )

        name_lines = _wrap(axis.name)
        for line_no, line in enumerate(name_lines):
            out.append(
                f'<text font-family="{_FONT}" font-size="12.5" font-weight="500" x="{centre:.1f}" y="{baseline + 22 + line_no * 16}" '
                f'fill="{INK}" text-anchor="middle">{_escape(line)}</text>'
            )
        unit_y = baseline + 24 + len(name_lines) * 16
        # Every axis that reaches this chart should be higher-is-better — the
        # builder converts error metrics into hit rates for exactly that
        # reason. The marker stays anyway: if one ever slips through, a reader
        # must not be left reading a taller bar as a better result.
        unit_note = (
            axis.unit if axis.higher_is_better
            else f"{axis.unit} · lower is better"
        )
        out.append(
            f'<text font-family="{_FONT}" font-size="11" x="{centre:.1f}" y="{unit_y}" fill="{FAINT}" '
            f'text-anchor="middle">{_escape(unit_note)}</text>'
        )
        if axis.verdict == "tie":
            out += [
                f'<rect x="{centre - 17:.1f}" y="{unit_y + 7}" width="34" height="16" '
                f'rx="8" fill="#f4f4f5"/>',
                f'<text font-family="{_FONT}" font-size="11" x="{centre:.1f}" y="{unit_y + 19}" '
                f'fill="{MUTED}" text-anchor="middle">tie</text>',
            ]

    out.append("</svg>")
    return "\n".join(out) + "\n"
