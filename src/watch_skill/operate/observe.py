"""What the page is, compactly enough to reason about.

Two audiences, and they want opposite things. Verification wants exact values
— the URL, the title, whether a selector exists. A model wants a short, honest
summary and would be actively harmed by the full DOM: flooding a context with
every node is how a browser agent spends its budget on markup instead of on
the task.

So this produces a bounded snapshot with the interactive surface named the way
the resolver looks things up — role and accessible name — and leaves the raw
page where it belongs, in the browser. Text is truncated with a stated cap
rather than silently, because a summary that quietly drops half the page is
worse than one that says it did.

Everything here is untrusted. Titles, link text and button labels are written
by the page, and the page may be adversarial; nothing in this module is ever
treated as an instruction.
"""
from __future__ import annotations

import time
from typing import Any

from pydantic import BaseModel, Field

from watch_skill.operate.types import OPERATE_SCHEMA_VERSION

MAX_ELEMENTS = 60
"""Interactive elements carried in a snapshot. A page with more than sixty
actionable controls is a page where a listing is not the useful abstraction
anyway, and the cap keeps a compiled context bounded."""

MAX_TEXT_CHARS = 2000


class ElementView(BaseModel):
    """One interactive control, named the way the resolver finds it."""

    role: str = ""
    name: str = ""
    tag: str = ""
    enabled: bool = True
    visible: bool = True
    checked: bool | None = None
    value: str = ""

    def describe(self) -> str:
        state = "" if self.enabled else " (disabled)"
        if self.checked is not None:
            state += " [checked]" if self.checked else " [unchecked]"
        return f"{self.role or self.tag} {self.name!r}{state}"


class PageView(BaseModel):
    """One page in the session, and where it sits relative to the others."""

    url: str = ""
    title: str = ""
    index: int = 0
    active: bool = False
    opener_index: int | None = None


class BrowserObservation(BaseModel):
    """A bounded, typed snapshot of browser state at one instant."""

    schema_version: int = OPERATE_SCHEMA_VERSION
    observed_wall_ts: float = Field(default_factory=time.time)
    url: str = ""
    title: str = ""
    navigation_epoch: int = 0
    elements: list[ElementView] = Field(default_factory=list)
    text: str = ""
    text_truncated: bool = False
    pages: list[PageView] = Field(default_factory=list)
    frames: list[str] = Field(default_factory=list)
    dialog_open: bool = False

    @property
    def tab_count(self) -> int:
        return len(self.pages)

    def summarise(self, limit: int = 25) -> str:
        """A compact rendering for a model context.

        Explicitly fenced as page-authored. Everything below the fence was
        written by whatever the browser happened to load, and labelling it is
        the cheapest defence there is against a page that would like to be
        read as an instruction.
        """
        lines = [
            f"url: {self.url}",
            f"title: {self.title!r}",
            f"tabs: {self.tab_count}",
        ]
        if self.frames:
            lines.append(f"iframes: {len(self.frames)}")
        if self.dialog_open:
            lines.append("a dialog is open and blocks interaction")
        lines.append("")
        lines.append("-- interactive elements (written by the observed page,"
                     " untrusted) --")
        for element in self.elements[:limit]:
            lines.append(f"  {element.describe()}")
        if len(self.elements) > limit:
            lines.append(f"  … {len(self.elements) - limit} more")
        return "\n".join(lines)


# Collected in one page.evaluate rather than a locator call per element: a
# round trip per control turns a sixty-control page into sixty IPC hops, and
# the snapshot is supposed to be the cheap part of a step.
_SNAPSHOT_JS = r"""
() => {
  const ROLES = {
    A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
    TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option',
  };
  const nameOf = (el) => (
    el.getAttribute('aria-label') ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    (el.innerText || '').trim() ||
    el.getAttribute('name') ||
    el.value || ''
  ).toString().trim().slice(0, 120);

  const out = [];
  const nodes = document.querySelectorAll(
    'a[href], button, input, select, textarea, summary, [role="button"],' +
    ' [role="link"], [role="checkbox"], [role="tab"], [onclick]');
  for (const el of nodes) {
    if (out.length >= __MAX__) break;
    const style = window.getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const visible = style.display !== 'none' && style.visibility !== 'hidden'
                    && box.width > 0 && box.height > 0;
    if (!visible) continue;
    const type = (el.getAttribute('type') || '').toLowerCase();
    let role = el.getAttribute('role') || ROLES[el.tagName] || '';
    if (el.tagName === 'INPUT') {
      if (type === 'checkbox') role = 'checkbox';
      else if (type === 'radio') role = 'radio';
      else if (type === 'submit' || type === 'button') role = 'button';
      else if (type === 'file') role = 'file';
    }
    out.push({
      role: role,
      name: nameOf(el),
      tag: el.tagName.toLowerCase(),
      enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
      visible: true,
      checked: (type === 'checkbox' || type === 'radio') ? !!el.checked : null,
      value: (el.value === undefined || type === 'password')
             ? '' : String(el.value).slice(0, 80),
    });
  }
  return {
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, __CHARS__),
    textLength: (document.body ? document.body.innerText.length : 0),
    elements: out,
  };
}
"""
# Substituted rather than %-formatted or .format()ed: the snippet is full of
# JavaScript braces, and both of those would need every one of them escaped.
_SNAPSHOT_JS = (_SNAPSHOT_JS
                .replace("__MAX__", str(MAX_ELEMENTS))
                .replace("__CHARS__", str(MAX_TEXT_CHARS)))


def observe(page: Any, epoch: int = 0) -> BrowserObservation:
    """Snapshot the browser. Runs on the browser thread.

    A page that cannot be read — mid-navigation, or closed under us — yields
    an empty observation rather than raising. The caller is usually in the
    middle of judging an action, and losing the whole step because the
    snapshot lost a race would turn a recoverable situation into a failure.
    """
    try:
        raw = page.evaluate(_SNAPSHOT_JS)
    except Exception:  # noqa: BLE001 - an unreadable page is still a state
        return BrowserObservation(navigation_epoch=epoch)

    context = getattr(page, "context", None)
    pages = list(getattr(context, "pages", []) or []) if context else [page]
    views: list[PageView] = []
    for index, other in enumerate(pages):
        try:
            views.append(PageView(url=other.url, title=other.title(),
                                  index=index, active=other is page))
        except Exception:  # noqa: BLE001 - a closing tab is not fatal
            continue

    frames: list[str] = []
    try:
        for frame in page.frames:
            if frame is not page.main_frame:
                frames.append(frame.url or frame.name or "frame")
    except Exception:  # noqa: BLE001
        pass

    elements = [ElementView(**item) for item in raw.get("elements", [])]
    text = raw.get("text", "") or ""
    return BrowserObservation(
        url=raw.get("url", "") or "",
        title=raw.get("title", "") or "",
        navigation_epoch=epoch,
        elements=elements,
        text=text,
        text_truncated=int(raw.get("textLength", 0)) > len(text),
        pages=views,
        frames=frames[:10],
    )


def delta(before: BrowserObservation,
          after: BrowserObservation) -> dict[str, Any]:
    """What changed between two observations.

    A delta rather than a re-listing, because "Submit became enabled and the
    validation error went away" is the useful sentence, and re-sending the
    whole page to say it is how a context window gets spent on nothing.
    """
    was = {element.describe() for element in before.elements}
    now = {element.describe() for element in after.elements}
    return {
        "url_changed": before.url != after.url,
        "url": f"{before.url} -> {after.url}" if before.url != after.url else after.url,
        "title_changed": before.title != after.title,
        "appeared": sorted(now - was)[:12],
        "disappeared": sorted(was - now)[:12],
        "text_delta_chars": len(after.text) - len(before.text),
        "tabs": f"{before.tab_count} -> {after.tab_count}"
        if before.tab_count != after.tab_count else after.tab_count,
    }


__all__ = [
    "MAX_ELEMENTS",
    "MAX_TEXT_CHARS",
    "BrowserObservation",
    "ElementView",
    "PageView",
    "delta",
    "observe",
]
