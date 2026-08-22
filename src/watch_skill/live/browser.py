"""A live browser, watched as pixels *and* as structure.

Playwright's sync API is thread-affine: every call must happen on the thread
that created the driver. So this module owns exactly one thread, and that
thread does everything — launch, navigate, listen, screenshot, shut down.
Callers interact through two queues (frames out, commands in) and never touch
a Playwright object. That constraint is not incidental; it is the reason the
capture loop, the event listeners, and the shutdown path cannot race.

Both channels run at once and neither substitutes for the other:

* **Pixels** — a JPEG per tick, at the session's analysis frame rate, fed into
  the same scene-change / OCR / clip machinery as every other live source. A
  browser session produces real frames, so `what did the user actually see`
  stays answerable.
* **Structure** — navigation, console, page errors, failed requests, DOM and
  accessibility changes, downloads, popups, dialogs, crashes. Cheap, exact,
  and impossible to recover from pixels alone.

Everything on the structured side came from a hostile document. It is bounded,
redacted, stamped with a navigation epoch, and marked ``page_authored`` before
it leaves this module. None of it can name a tool, approve an action, or claim
a browser-level event kind.
"""
from __future__ import annotations

import json
import os
import platform
import queue
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from watch_skill.errors import WatchSkillError
from watch_skill.live import browser_pool as pool
from watch_skill.live.browser_events import (
    MAX_SNAPSHOT_NODES,
    BrowserEvent,
    BrowserEventKind,
    BrowserTarget,
    Redaction,
    redact_headers,
    redact_text,
    redact_url,
    reject_forged_kind,
)
from watch_skill.live.browser_policy import (
    NavigationPolicy,
    check_navigation,
)
from watch_skill.live.source import CapturedFrame, CaptureError
from watch_skill.live.types import LiveSourceSpec

# Chromium flags. Each one is here for a stated reason; a flag nobody can
# justify is a flag that will eventually weaken something.
_CHROMIUM_ARGS = [
    "--disable-background-networking",      # no component/variations fetches
    "--disable-component-update",           # no silent binary updates
    "--disable-domain-reliability",         # no telemetry beacons
    "--no-default-browser-check",
    "--no-first-run",
    "--disable-sync",
    "--metrics-recording-only",
    "--disable-breakpad",                   # no crash uploads
    "--disable-features=MediaRouter,OptimizationHints,Translate",
]

# The page-side reporter. It owns two channels and nothing else: DOM mutation
# summaries and accessibility-relevant attribute changes. It sends *summaries*,
# never document content in bulk — a MutationObserver on a busy page can fire
# thousands of times a second, and forwarding that verbatim would be a
# self-inflicted denial of service.
_INIT_SCRIPT = r"""
(() => {
  if (window.__watchSkillInstalled) { return; }
  window.__watchSkillInstalled = true;

  const MAX_TARGETS = 10;
  const THROTTLE_MS = 200;
  const A11Y_ATTRS = new Set(['role', 'aria-label', 'aria-hidden', 'aria-expanded',
    'aria-checked', 'aria-disabled', 'aria-invalid', 'aria-live', 'aria-selected',
    'aria-busy', 'disabled', 'hidden', 'tabindex']);

  let stopped = false;

  const send = (kind, payload) => {
    if (stopped) { return; }
    try {
      if (typeof window.__watchSkillReport === 'function') {
        window.__watchSkillReport(JSON.stringify({ kind: kind, payload: payload }));
      }
    } catch (err) { /* a page that breaks the reporter loses only reporting */ }
  };

  const describe = (el, attributeName) => {
    if (!el || el.nodeType !== 1) { return null; }
    let cls = '';
    try { cls = typeof el.className === 'string' ? el.className : ''; } catch (e) { cls = ''; }
    return {
      tag: (el.tagName || '?').toLowerCase(),
      id: String(el.id || '').slice(0, 80),
      cls: cls.slice(0, 120),
      attribute: attributeName || null,
      value: attributeName ? String(el.getAttribute(attributeName) || '').slice(0, 120) : null,
      text: String(el.textContent || '').trim().slice(0, 160)
    };
  };

  let domPending = null;
  let a11yPending = null;
  let timer = null;

  const flush = () => {
    timer = null;
    if (domPending) { send('dom_mutation', domPending); domPending = null; }
    if (a11yPending) { send('accessibility_change', a11yPending); a11yPending = null; }
  };

  const schedule = () => { if (timer === null) { timer = setTimeout(flush, THROTTLE_MS); } };

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const isA11y = rec.type === 'attributes' && A11Y_ATTRS.has(rec.attributeName);
      const bucket = isA11y ? 'a11y' : 'dom';
      let acc = isA11y ? a11yPending : domPending;
      if (!acc) {
        acc = { added: 0, removed: 0, attributes: 0, text: 0, targets: [] };
        if (isA11y) { a11yPending = acc; } else { domPending = acc; }
      }
      if (rec.type === 'childList') {
        acc.added += rec.addedNodes.length;
        acc.removed += rec.removedNodes.length;
      } else if (rec.type === 'attributes') {
        acc.attributes += 1;
      } else if (rec.type === 'characterData') {
        acc.text += 1;
      }
      if (acc.targets.length < MAX_TARGETS) {
        const target = rec.type === 'characterData' ? rec.target.parentElement : rec.target;
        const described = describe(target, rec.attributeName);
        if (described) { acc.targets.push(described); }
      }
      void bucket;
    }
    schedule();
  });

  const attach = () => {
    if (!document.documentElement) { return; }
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true
    });
  };

  // Called by Watch Skill immediately before teardown. Without it the page
  // keeps calling the binding while the context is being closed, and each
  // reply lands on a dead channel — which Playwright reports as an
  // unretrieved TargetClosedError traceback on a perfectly clean exit.
  window.__watchSkillStop = () => {
    stopped = true;
    try { observer.disconnect(); } catch (err) { /* already gone */ }
    if (timer !== null) { clearTimeout(timer); timer = null; }
    domPending = null;
    a11yPending = null;
    return true;
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  } else {
    attach();
  }
})();
"""


@dataclass
class BrowserFailure:
    """Why a browser session stopped, when it was not asked to."""

    code: str
    message: str
    fix: str = ""
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"error": self.code, "message": self.message,
                "fix": self.fix, "details": self.detail}


@dataclass
class BrowserOptions:
    """How one browser session is launched and bounded."""

    url: str
    policy: NavigationPolicy
    fps: float = 2.0
    headless: bool = True
    viewport_width: int = 1280
    viewport_height: int = 800
    jpeg_quality: int = 70
    navigation_timeout_ms: int = 20_000
    screenshot_timeout_ms: int = 5_000
    evaluate_timeout_ms: int = 5_000
    shutdown_timeout_s: float = 45.0
    lease_timeout_s: float = 60.0
    """How long to wait for a browser slot before refusing. Refusing is a real
    outcome here rather than a failure mode to tune away: a caller told "the
    machine is busy" can retry, where a caller killed by the OOM killer
    cannot."""

    """Generous on purpose. A cold Chromium — first launch on a machine, empty
    profile, cold page cache — takes several seconds to close, and a tight
    budget here would turn an ordinary slow shutdown into a spurious "the
    browser leaked" failure. The escalation path below is what makes a long
    budget safe: past it, the tree is killed rather than merely reported."""
    max_events: int = 20_000
    """Ceiling on structured events for the whole session. A page in a console
    loop can emit faster than anything downstream drains; past this the
    structured channel stops and says so, rather than filling the disk."""

    capture_request_metadata: bool = True

    adopt_popups: bool = False
    """Whether a popup is kept and watched, or recorded and closed.

    Off by default, and the default is the security position: an observed page
    that can open windows nobody is looking at can do work the session would
    report nothing about, so in observer mode a popup is evidence and then it
    is gone.

    Operator mode turns this on, because a `target="_blank"` link is often the
    task itself, and the objection was never to popups — it was to *unwatched*
    surfaces. An adopted popup is enumerated in the page graph and appears in
    every observation, so it is watched. The context-level route handler
    already applies the navigation policy to every page in the context,
    popups included, so the boundary is unchanged."""

    @classmethod
    def from_spec(cls, spec: LiveSourceSpec, policy: NavigationPolicy) -> BrowserOptions:
        detail = spec.detail or {}
        target = spec.target
        if target.startswith("browser:"):
            target = target.split(":", 1)[1]
        return cls(
            url=target,
            policy=policy,
            fps=min(spec.fps, 10.0),
            headless=bool(detail.get("headless", True)),
            viewport_width=int(detail.get("viewport_width", 1280)),
            viewport_height=int(detail.get("viewport_height", 800)),
        )


class BrowserSource:
    """A Chromium page, producing frames and structured events while it runs.

    Satisfies the same ``LiveSource`` protocol as the ffmpeg-backed sources —
    ``frames()``, ``stop()``, ``running`` — so the session pipeline treats it
    identically, and adds ``drain_events()`` for the structured channel.
    """

    def __init__(self, options: BrowserOptions, out_dir: Path,
                 session_id: str = "") -> None:
        self.options = options
        self.out_dir = out_dir
        self.session_id = session_id or f"browser_{uuid.uuid4().hex[:8]}"
        self.failure: BrowserFailure | None = None

        self._frames: queue.Queue[CapturedFrame | None] = queue.Queue(maxsize=256)
        self._events: queue.Queue[BrowserEvent] = queue.Queue(maxsize=4096)
        self._commands: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._stop = threading.Event()
        # Distinct from ``_stop``. ``_stop`` means "the loop should end",
        # which is also true when the page closes or the process is killed.
        # This one means "we asked for it" — the only way to tell a normal
        # shutdown from a browser that died, and therefore the only way to
        # report a death honestly instead of as a clean finish.
        self._stop_requested = threading.Event()
        self._ready = threading.Event()
        self._thread: threading.Thread | None = None
        self._started_monotonic = 0.0
        self._frame_index = 0
        self._event_seq = 0
        self._navigation_epoch = 0
        self._events_dropped = 0
        self._blocked_navigations: list[dict[str, Any]] = []
        # A per-session profile directory. Two reasons: no cookie or cache
        # bleed between sessions, and — because Windows locks files inside a
        # live profile — whether it can be deleted afterwards is a real,
        # checkable answer to "did every browser process actually exit".
        self._profile_dir = out_dir.parent / f"profile_{self.session_id}"
        self._closed_cleanly = False
        self._lease: pool.Lease | None = None
        self._lease_reclaimed = False
        self._stragglers_killed: list[int] = []
        self._tree_gone: bool | None = None

    # --- LiveSource protocol ------------------------------------------------

    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        if self._thread is not None:
            return
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._profile_dir.mkdir(parents=True, exist_ok=True)
        self._thread = threading.Thread(target=self._run, name="ws-browser",
                                        daemon=True)
        self._thread.start()
        # Surface a launch failure to the caller rather than as a session that
        # exists but never emits: `start_live` opens the source before the
        # session row is written precisely so this can still raise.
        if not self._ready.wait(timeout=60.0):
            self.stop()
            raise CaptureError(
                "the browser did not become ready within 60s",
                code="live.browser.launch_timeout",
                fix="run `watch-skill capture-capabilities`; if chromium is "
                    "missing, `playwright install chromium` installs it",
            )
        if self.failure is not None:
            self.stop()
            raise CaptureError(
                self.failure.message,
                code=self.failure.code,
                fix=self.failure.fix or "run `watch-skill capture-capabilities`",
                details=self.failure.detail,
            )

    def frames(self):  # noqa: ANN201 - Iterator[CapturedFrame], matches protocol
        if self._thread is None:
            self.start()
        while True:
            try:
                frame = self._frames.get(timeout=0.5)
            except queue.Empty:
                if not self.running:
                    return
                continue
            if frame is None:      # sentinel: the browser thread is finished
                return
            yield frame

    def stop(self) -> None:
        """Ask the browser to close, then make sure it did.

        Ordering matters: the stop flag is set first so the capture loop stops
        taking screenshots of a page that is being torn down, and the sentinel
        goes in last so a consumer blocked on ``frames()`` returns instead of
        waiting out its timeout.
        """
        self._stop_requested.set()
        self._stop.set()
        thread = self._thread
        if thread is not None and thread.is_alive():
            thread.join(timeout=self.options.shutdown_timeout_s)
            if thread.is_alive():  # pragma: no cover - a wedged driver
                # A graceful close did not happen, so stop asking. Killing is
                # the only thing left that keeps the promise "cancellation
                # closes every browser process", and a leaked Chromium is
                # worse than an ungraceful exit — it keeps rendering a page
                # nobody is watching, holding a profile nobody will read.
                killed = self._kill_stragglers()
                self._note_failure(BrowserFailure(
                    code="live.browser.shutdown_timeout",
                    message="the browser did not close within "
                            f"{self.options.shutdown_timeout_s:g}s; "
                            f"{len(killed)} process(es) were killed",
                    fix="the frames and events captured before the timeout "
                        "remain queryable; finalize the session to keep them",
                    detail={"killed_pids": killed},
                ))
        self._tree_gone = self._remove_profile()
        # The lease is released by `_run`'s finally clause, on the browser
        # thread. If that thread had to be killed rather than joined, nobody
        # ran it — and a lease nothing will ever release makes the budget
        # permanently one smaller for the life of the process. Every later
        # session then fails for a reason that has nothing to do with it.
        #
        # Bounded wait, then reclaim. Waiting forever would trade a leak for a
        # hang, which is not an improvement.
        deadline = time.monotonic() + 5.0
        while self._lease is not None and not self._lease.released:
            if time.monotonic() > deadline:
                pool.release(self._lease)
                self._lease_reclaimed = True
                break
            time.sleep(0.05)
        self._lease = None
        try:
            self._frames.put_nowait(None)
        except queue.Full:  # pragma: no cover - a full queue already unblocks
            pass

    # --- structured channel -------------------------------------------------

    def drain_events(self, limit: int = 256) -> list[BrowserEvent]:
        """Take whatever structured events have accumulated. Never blocks."""
        drained: list[BrowserEvent] = []
        while len(drained) < limit:
            try:
                drained.append(self._events.get_nowait())
            except queue.Empty:
                break
        return drained

    def navigate(self, url: str) -> None:
        """Queue a navigation. Checked by policy on the browser thread."""
        self._commands.put(("navigate", url))

    def call(self, fn: Any, timeout: float = 30.0) -> Any:
        """Run ``fn(page)`` on the browser thread and return what it returns.

        Playwright's sync API binds every object to the thread that created
        it, which is why this class already funnels `navigate` and `evaluate`
        through a queue. Those are fire-and-forget; an action needs its result
        and its exception back, so this is the same queue with a reply slot.

        This is the primitive the whole operator runtime is built on: it means
        actions execute on the one thread that owns the page, in order,
        interleaved with the capture loop, with no second browser stack and no
        lock of our own.
        """
        if not self.running:
            raise CaptureError(
                "the browser is not running",
                code="live.browser.not_running",
                fix="start the session before driving it")
        box: dict[str, Any] = {}
        done = threading.Event()
        self._commands.put(("call", (fn, box, done)))
        if not done.wait(timeout):
            raise CaptureError(
                f"a browser call did not return within {timeout:.0f}s",
                code="live.browser.call_timeout",
                fix="the page may be blocked by a dialog or a navigation")
        if "error" in box:
            raise box["error"]
        return box.get("value")

    def evaluate(self, expression: str) -> None:
        """Queue a page evaluation, for governed corrections only.

        Deliberately fire-and-forget with no return value: this exists so an
        *approved* correction can act on the page, not so a caller can use the
        watched page as a general-purpose script host.
        """
        self._commands.put(("evaluate", expression))

    def diagnostics(self) -> dict[str, Any]:
        return {
            "navigation_epoch": self._navigation_epoch,
            "frames_captured": self._frame_index,
            "events_emitted": self._event_seq,
            "events_dropped": self._events_dropped,
            "blocked_navigations": list(self._blocked_navigations[-10:]),
            "closed_cleanly": self._closed_cleanly,
            "process_tree_gone": self._tree_gone,
            "killed_pids": list(self._stragglers_killed),
            "policy": self.options.policy.to_dict(),
            "failure": self.failure.to_dict() if self.failure else None,
            "resources": pool.diagnostics(),
            "holds_lease": self._lease is not None and not self._lease.released,
            "lease_reclaimed_by_stop": self._lease_reclaimed,
        }

    def process_tree_gone(self) -> bool:
        """Whether every browser process for this session has actually exited.

        Not a guess, and not a scan that could be fooled by a renamed binary.
        Chromium holds an exclusive lock on files inside its profile directory
        for as long as it lives, so a profile that deletes cleanly is proof
        the tree is gone — on Windows especially, where the OS refuses to
        unlink a mapped file. ``stop()`` records the answer at the moment it
        matters; asking later re-checks rather than assuming.
        """
        if self._tree_gone:
            return True
        self._tree_gone = self._remove_profile()
        return self._tree_gone

    def _remove_profile(self) -> bool:
        if not self._profile_dir.exists():
            return True
        shutil.rmtree(self._profile_dir, ignore_errors=True)
        return not self._profile_dir.exists()

    def _kill_stragglers(self) -> list[int]:
        """Kill only the processes launched for *this* session.

        Matched by this session's unique profile path appearing in the command
        line, never by process name. "Kill chrome.exe" would take the
        operator's own browser with it, which is an unacceptable way to clean
        up after ourselves.
        """
        marker = str(self._profile_dir)
        pids = _pids_with_marker(marker)
        killed: list[int] = []
        for pid in pids:
            if _kill_tree(pid):
                killed.append(pid)
        self._stragglers_killed.extend(killed)
        return killed

    # --- the browser thread -------------------------------------------------

    def _run(self) -> None:
        try:
            from playwright.sync_api import sync_playwright  # noqa: PLC0415
        except ImportError:
            self._note_failure(BrowserFailure(
                code="live.browser.playwright_missing",
                message="playwright is not installed",
                fix="pip install 'watch-skill[loop]' && playwright install chromium",
            ))
            self._ready.set()
            self._frames.put(None)
            return

        context = None
        playwright = None
        try:
            # Lease a slot before spending any memory. Refusing here — with a
            # reason naming what else is running — is a far better outcome
            # than the OS killing this process, or some unrelated allocation
            # elsewhere failing because a browser took the last of the RAM.
            self._lease = pool.acquire(
                f"live:{self.session_id}",
                timeout=self.options.lease_timeout_s)
            playwright = sync_playwright().start()
            context = self._launch(playwright)
            page = context.pages[0] if context.pages else context.new_page()
            self._wire(context, page)
            self._started_monotonic = time.monotonic()
            self._ready.set()
            self._open(page, self.options.url)
            self._loop(page)
        except Exception as exc:  # noqa: BLE001 - any driver fault ends the session
            self._note_failure(_failure_from(exc))
            self._ready.set()
        finally:
            # Recorded BEFORE the sentinel, so a consumer that returns from
            # `frames()` can read the failure that ended the session. A
            # browser nobody asked to stop has stopped for a reason, and
            # reporting that as an ordinary end-of-source would let a killed
            # or crashed page read as a complete recording.
            if not self._stop_requested.is_set():
                self._note_failure(BrowserFailure(
                    code="live.browser.ended_unexpectedly",
                    message="the browser exited without being asked to",
                    fix="the frames and events captured before it died remain "
                        "queryable; finalize the session to keep them",
                    detail={"frames_captured": self._frame_index,
                            "events_emitted": self._event_seq},
                ))
            self._shutdown(context, playwright)
            # The lease goes back after the processes are actually gone, not
            # before: releasing it earlier would let the next browser start
            # while this one's memory is still resident, which is exactly the
            # overlap the budget exists to prevent.
            pool.release(self._lease)
            self._lease = None
            self._frames.put(None)

    def _launch(self, playwright: Any) -> Any:
        options = self.options
        return playwright.chromium.launch_persistent_context(
            user_data_dir=str(self._profile_dir),
            headless=options.headless,
            args=_CHROMIUM_ARGS,
            viewport={"width": options.viewport_width,
                      "height": options.viewport_height},
            # No stored credentials, no downloads to disk, no permissions.
            # A watched page gets the least authority that still renders.
            accept_downloads=False,
            java_script_enabled=True,
            bypass_csp=False,
            ignore_https_errors=False,
            permissions=[],
        )

    def _wire(self, context: Any, page: Any) -> None:
        """Attach every listener before the first navigation.

        Before, not after: a listener registered post-navigation misses the
        console error thrown during load, which is the one most worth having.
        """
        context.set_default_timeout(self.options.navigation_timeout_ms)
        context.set_default_navigation_timeout(self.options.navigation_timeout_ms)
        context.expose_binding("__watchSkillReport", self._on_page_report)
        context.add_init_script(_INIT_SCRIPT)
        context.route("**/*", self._on_route)

        page.on("console", self._on_console)
        page.on("pageerror", self._on_page_error)
        page.on("requestfailed", self._on_request_failed)
        page.on("framenavigated", self._on_frame_navigated)
        page.on("download", self._on_download)
        page.on("popup", self._on_popup)
        page.on("dialog", self._on_dialog)
        page.on("crash", self._on_crash)
        page.on("close", self._on_close)
        page.on("load", self._on_load)
        if self.options.capture_request_metadata:
            page.on("response", self._on_response)

    def _open(self, page: Any, url: str) -> None:
        decision = check_navigation(url, self.options.policy)
        if not decision.allowed:
            self._blocked_navigations.append(
                {"url": decision.url, "reason": decision.reason})
            decision.raise_if_denied()
        # The epoch is NOT bumped here. `framenavigated` on the main frame is
        # the single place it advances, so one page change counts once —
        # whether it came from this method, a redirect, or the page's own
        # script. Incrementing in both places made an operator-driven
        # navigation look like two.
        try:
            page.goto(url, wait_until="domcontentloaded",
                      timeout=self.options.navigation_timeout_ms)
        except Exception as exc:  # noqa: BLE001 - a failed load is evidence
            self._emit(BrowserEventKind.NAVIGATION_FAILED,
                       f"navigation failed: {type(exc).__name__}",
                       {"url": _public_url(url), "error": str(exc)[:300]},
                       page_authored=False)
            return
        self._emit(BrowserEventKind.NAVIGATION, "navigated",
                   {"url": _public_url(url), "epoch": self._navigation_epoch},
                   page_authored=False)

    def _loop(self, page: Any) -> None:
        """Screenshot on a fixed cadence, servicing browser events in between.

        ``page.wait_for_timeout`` is what makes this work: the sync API pumps
        its event loop while waiting, so console messages, request failures and
        DOM reports are delivered *between* screenshots on this same thread —
        no second thread, no lock, no reentrancy.
        """
        interval = 1.0 / max(self.options.fps, 0.1)
        next_tick = time.monotonic()
        while not self._stop.is_set():
            self._drain_commands(page)
            if page.is_closed():
                return
            self._capture(page)
            next_tick += interval
            wait = max(0.0, next_tick - time.monotonic())
            if wait <= 0:
                # Falling behind: resync rather than accumulating debt, which
                # would otherwise turn into a burst of back-to-back captures.
                next_tick = time.monotonic()
                wait = 0.005
            # Sliced, so a command queued mid-wait is serviced in tens of
            # milliseconds rather than after the rest of the frame interval.
            # `wait_for_timeout` is still what pumps Playwright's event loop,
            # so console messages and request failures keep arriving between
            # slices exactly as before.
            try:
                remaining = wait
                while remaining > 0 and not self._stop.is_set():
                    if not self._commands.empty():
                        break
                    slice_s = min(0.05, remaining)
                    page.wait_for_timeout(slice_s * 1000)
                    remaining -= slice_s
            except Exception:  # noqa: BLE001 - a closing page ends the loop
                return

    def _capture(self, page: Any) -> None:
        index = self._frame_index + 1
        path = self.out_dir / f"f_{index:06d}.jpg"
        staging = path.with_suffix(".part")
        try:
            data = page.screenshot(type="jpeg",
                                   quality=self.options.jpeg_quality,
                                   timeout=self.options.screenshot_timeout_ms,
                                   caret="initial", animations="allow")
        except Exception as exc:  # noqa: BLE001 - a busy page skips a frame
            if page.is_closed():
                return
            self._emit(BrowserEventKind.PERFORMANCE, "screenshot skipped",
                       {"reason": type(exc).__name__}, page_authored=False)
            return
        # Written aside and renamed: a reader watching this directory must
        # never see a half-written JPEG, and OCR silently misreads truncated
        # images rather than failing.
        staging.write_bytes(data)
        staging.replace(path)
        self._frame_index = index
        frame = CapturedFrame(
            path=path,
            media_ts=time.monotonic() - self._started_monotonic,
            wall_ts=time.time(),
            index=index,
        )
        try:
            self._frames.put_nowait(frame)
        except queue.Full:
            # The consumer is behind. Dropping the newest frame keeps the
            # queue's oldest-first ordering meaningful; the session's own
            # bounded stages already count what analysis skipped.
            pass

    def _drain_commands(self, page: Any) -> None:
        while True:
            try:
                name, payload = self._commands.get_nowait()
            except queue.Empty:
                return
            if name == "call":
                fn, box, done = payload
                try:
                    box["value"] = fn(page)
                except BaseException as exc:  # noqa: BLE001 - returned to caller
                    box["error"] = exc
                finally:
                    done.set()
            elif name == "navigate":
                self._open(page, str(payload))
            elif name == "evaluate":
                try:
                    page.evaluate(str(payload))
                except Exception as exc:  # noqa: BLE001 - report, never raise
                    self._emit(BrowserEventKind.PAGE_ERROR,
                               "evaluate failed",
                               {"error": str(exc)[:300]}, page_authored=False)

    def _shutdown(self, context: Any, playwright: Any) -> None:
        """Close the page, the context, then the driver — in that order.

        Stopping the driver last is what actually guarantees no orphan: the
        Playwright driver kills the browsers it spawned when it exits, so even
        a context that refuses to close cleanly does not leave a process
        behind. ``process_tree_gone()`` is how a test checks that claim rather
        than trusting this comment.
        """
        if context is not None:
            # Quiesce in this order: stop the page talking to us, then stop
            # intercepting its requests, then close. Each step removes a
            # source of in-flight work that would otherwise be answered into
            # a closing channel — and Playwright prints those failures as
            # tracebacks on an ordinary clean exit, which is how operators
            # learn to ignore tracebacks.
            for page in _safe_attr(context, "pages", []) or []:
                try:
                    page.evaluate(
                        "() => window.__watchSkillStop && window.__watchSkillStop()")
                except Exception:  # noqa: BLE001 - a closed page needs no quiescing
                    continue
            try:
                context.unroute_all(behavior="ignoreErrors")
            except Exception:  # noqa: BLE001 - an already-dead context needs nothing
                pass
            try:
                context.close()
                self._closed_cleanly = True
            except Exception:  # noqa: BLE001 - a crashed context is already gone
                self._closed_cleanly = False
        if playwright is not None:
            try:
                playwright.stop()
            except Exception:  # noqa: BLE001 - nothing left to do about it
                pass

    # --- listeners ----------------------------------------------------------

    def _on_route(self, route: Any, request: Any) -> None:
        """The second navigation gate: redirects and page-initiated documents.

        Checking only the URL the operator passed would be checking the one
        URL an attacker does not control. A page that redirects to the cloud
        metadata endpoint, or an iframe pointed at the LAN, is stopped here.
        """
        try:
            if request.resource_type not in ("document", "iframe"):
                route.continue_()
                return
            decision = check_navigation(request.url, self.options.policy)
            if decision.allowed:
                route.continue_()
                return
            self._blocked_navigations.append(
                {"url": decision.url, "reason": decision.reason})
            self._emit(BrowserEventKind.NAVIGATION_FAILED,
                       f"blocked by navigation policy: {decision.reason}",
                       {"url": _public_url(request.url),
                        "reason": decision.reason,
                        "resource_type": request.resource_type},
                       page_authored=False)
            route.abort("blockedbyclient")
        except Exception:  # noqa: BLE001 - a dead route is not an error
            return

    def _on_console(self, message: Any) -> None:
        kind = BrowserEventKind.CONSOLE
        redaction = Redaction()
        text = redact_text(_safe_attr(message, "text", ""), redaction, "text")
        self._emit(kind, f"console.{_safe_attr(message, 'type', 'log')}: {text[:200]}",
                   {"level": _safe_attr(message, "type", "log"), "text": text,
                    "location": _location(message)},
                   redaction=redaction)

    def _on_page_error(self, error: Any) -> None:
        redaction = Redaction()
        text = redact_text(str(error), redaction, "message")
        self._emit(BrowserEventKind.PAGE_ERROR,
                   f"uncaught page exception: {text[:200]}",
                   {"message": text}, redaction=redaction)

    def _on_request_failed(self, request: Any) -> None:
        redaction = Redaction()
        failure = _safe_attr(request, "failure", "") or ""
        self._emit(BrowserEventKind.REQUEST_FAILED,
                   f"request failed: {_public_url(_safe_attr(request, 'url', ''))}",
                   {"url": redact_url(_safe_attr(request, "url", ""), redaction),
                    "method": _safe_attr(request, "method", ""),
                    "resource_type": _safe_attr(request, "resource_type", ""),
                    "failure": redact_text(str(failure), redaction, "failure",
                                           limit=200)},
                   redaction=redaction)

    def _on_response(self, response: Any) -> None:
        """Bounded response metadata. Never a body.

        Bodies are not read at all — not truncated, not hashed, not stored.
        Reading one would mean a page could put a credential in a response and
        have Watch Skill write it to disk on its behalf.
        """
        try:
            status = int(_safe_attr(response, "status", 0))
        except (TypeError, ValueError):
            return
        # Successful sub-resources are noise at this volume. Failures, and the
        # document itself, are the evidence worth keeping.
        request = _safe_attr(response, "request", None)
        resource = _safe_attr(request, "resource_type", "") if request else ""
        if status < 400 and resource != "document":
            return
        redaction = Redaction()
        headers: dict[str, str] = {}
        try:
            headers = redact_headers(dict(response.headers), redaction)
        except Exception:  # noqa: BLE001 - headers are best effort
            headers = {}
        self._emit(BrowserEventKind.RESPONSE,
                   f"response {status} {_public_url(_safe_attr(response, 'url', ''))}",
                   {"url": redact_url(_safe_attr(response, "url", ""), redaction),
                    "status": status, "resource_type": resource,
                    "headers": headers},
                   redaction=redaction)

    def _on_frame_navigated(self, frame: Any) -> None:
        is_main = _safe_attr(frame, "parent_frame", None) is None
        if is_main:
            self._navigation_epoch += 1
        redaction = Redaction()
        self._emit(BrowserEventKind.URL_CHANGED,
                   f"{'page' if is_main else 'frame'} navigated",
                   {"url": redact_url(_safe_attr(frame, "url", ""), redaction),
                    "is_main_frame": is_main,
                    "epoch": self._navigation_epoch},
                   redaction=redaction, page_authored=False,
                   target=BrowserTarget(
                       frame_url=_public_url(_safe_attr(frame, "url", "")),
                       is_main_frame=is_main,
                       frame_id=_safe_attr(frame, "name", "") or ""))

    def _on_load(self, page: Any) -> None:
        timing: dict[str, Any] = {}
        try:
            timing = json.loads(page.evaluate(
                "() => { const n = performance.getEntriesByType('navigation')[0];"
                " return JSON.stringify(n ? {domContentLoaded: n.domContentLoadedEventEnd,"
                " load: n.loadEventEnd, type: n.type,"
                " transfer: n.transferSize || 0} : {}); }"
            ) or "{}")
        except Exception:  # noqa: BLE001 - timing is a nicety, never required
            timing = {}
        self._emit(BrowserEventKind.PERFORMANCE, "page load complete",
                   {"timing": timing}, page_authored=False)

    def _on_download(self, download: Any) -> None:
        redaction = Redaction()
        self._emit(BrowserEventKind.DOWNLOAD, "download attempted (refused)",
                   {"url": redact_url(_safe_attr(download, "url", ""), redaction),
                    "suggested_filename": redact_text(
                        _safe_attr(download, "suggested_filename", ""),
                        redaction, "suggested_filename", limit=200),
                    "accepted": False},
                   redaction=redaction, page_authored=False)

    def _on_popup(self, popup: Any) -> None:
        redaction = Redaction()
        url = _safe_attr(popup, "url", "")
        self._emit(BrowserEventKind.POPUP, "popup opened",
                   {"url": redact_url(url, redaction)},
                   redaction=redaction, page_authored=False)
        if self.options.adopt_popups:
            # Kept, and therefore watched: it joins the page graph and shows up
            # in every observation from here on. That is what makes keeping it
            # acceptable — the original objection was to a surface nobody was
            # looking at, not to popups as such.
            return
        # Otherwise recorded and closed: a page that can open unwatched windows
        # can do work the session would report nothing about.
        try:
            popup.close()
        except Exception:  # noqa: BLE001
            pass

    def _on_dialog(self, dialog: Any) -> None:
        redaction = Redaction()
        message = redact_text(_safe_attr(dialog, "message", ""), redaction,
                              "message", limit=500)
        self._emit(BrowserEventKind.DIALOG,
                   f"dialog ({_safe_attr(dialog, 'type', 'alert')}) dismissed",
                   {"type": _safe_attr(dialog, "type", "alert"),
                    "message": message, "accepted": False},
                   redaction=redaction)
        # Dismissed, never accepted. An accepted `confirm()` is the page
        # obtaining a decision from an agent that never made one.
        try:
            dialog.dismiss()
        except Exception:  # noqa: BLE001
            pass

    def _on_crash(self, page: Any) -> None:
        self._emit(BrowserEventKind.TARGET_CRASHED, "the browser page crashed",
                   {"url": _public_url(_safe_attr(page, "url", ""))},
                   page_authored=False)
        self._note_failure(BrowserFailure(
            code="live.browser.page_crashed",
            message="the watched page crashed",
            fix="the events and frames captured before the crash remain "
                "queryable; finalize the session to keep them",
        ))
        self._stop.set()

    def _on_close(self, page: Any) -> None:
        self._emit(BrowserEventKind.TARGET_CLOSED, "the browser page closed",
                   {}, page_authored=False)
        self._stop.set()

    def _on_page_report(self, source: Any, payload: str) -> None:
        """Handle a report from page JavaScript. Nothing here is trusted.

        The page chooses the string it sends, so the kind it claims is mapped
        onto the two channels a page is allowed to own, and every field is
        bounded and redacted before it becomes an event.
        """
        redaction = Redaction()
        try:
            data = json.loads(payload) if isinstance(payload, str) else dict(payload)
        except (TypeError, ValueError):
            return
        if not isinstance(data, dict):
            return
        kind = reject_forged_kind(str(data.get("kind", "")))
        body = data.get("payload")
        if not isinstance(body, dict):
            body = {}
        targets = body.get("targets")
        clean_targets: list[dict[str, Any]] = []
        if isinstance(targets, list):
            for entry in targets[:MAX_SNAPSHOT_NODES]:
                if not isinstance(entry, dict):
                    continue
                clean_targets.append({
                    key: redact_text(str(entry.get(key, "")), redaction,
                                     f"target.{key}", limit=200)
                    for key in ("tag", "id", "cls", "attribute", "value", "text")
                    if entry.get(key) is not None
                })
        detail = {
            "added": _bounded_int(body.get("added")),
            "removed": _bounded_int(body.get("removed")),
            "attributes": _bounded_int(body.get("attributes")),
            "text": _bounded_int(body.get("text")),
            "targets": clean_targets,
        }
        frame = _safe_attr(source, "frame", None) if source is not None else None
        target = BrowserTarget(
            frame_url=_public_url(_safe_attr(frame, "url", "")) if frame else "",
            is_main_frame=(_safe_attr(frame, "parent_frame", None) is None
                           if frame else True),
        )
        summary = ("DOM changed" if kind is BrowserEventKind.DOM_MUTATION
                   else "accessibility state changed")
        self._emit(kind, f"{summary} ({detail['added']}+/{detail['removed']}-/"
                   f"{detail['attributes']} attrs)", detail,
                   redaction=redaction, target=target, page_authored=True)

    # --- emission -----------------------------------------------------------

    def _emit(self, kind: BrowserEventKind, summary: str,
              detail: dict[str, Any], *,
              redaction: Redaction | None = None,
              target: BrowserTarget | None = None,
              page_authored: bool = True) -> None:
        if self._event_seq >= self.options.max_events:
            return
        self._event_seq += 1
        if self._event_seq == self.options.max_events:
            summary = (f"structured browser events stopped at "
                       f"{self.options.max_events} for this session")
            kind, detail, page_authored = (BrowserEventKind.PERFORMANCE,
                                           {"reason": "max_events"}, False)
        media_ts = (time.monotonic() - self._started_monotonic
                    if self._started_monotonic else 0.0)
        event = BrowserEvent(
            session_id=self.session_id,
            kind=kind,
            seq=self._event_seq,
            media_ts=media_ts,
            wall_ts=time.time(),
            navigation_epoch=self._navigation_epoch,
            target=target or BrowserTarget(),
            summary=redact_text(summary, redaction or Redaction(), "summary",
                                limit=400),
            detail=detail,
            redaction=redaction or Redaction(),
            page_authored=page_authored,
        )
        try:
            self._events.put_nowait(event)
        except queue.Full:
            self._events_dropped += 1

    def _note_failure(self, failure: BrowserFailure) -> None:
        if self.failure is None:
            self.failure = failure


# --- helpers ----------------------------------------------------------------


def _pids_with_marker(marker: str) -> list[int]:
    """Every process whose command line contains this exact string.

    Deliberately narrow. The marker is a per-session profile path containing a
    random session id, so a match is proof the process was launched by this
    source and nothing else.
    """
    if not marker:
        return []
    if platform.system() == "Windows":
        return _pids_windows(marker)
    return _pids_proc(marker)


def _quote_powershell(value: str) -> str:
    """A PowerShell single-quoted literal for ``value``.

    Doubling is how a single quote is escaped inside a single-quoted
    PowerShell string. The marker is currently built from a generated session
    id and cannot contain one, so this closes a class rather than a live hole:
    `BrowserSource` takes `session_id` from its caller, the marker is derived
    from it, and interpolating it raw put the value inside a quoted string
    where one apostrophe would end the literal and the rest would be parsed as
    code.
    """
    return "'" + value.replace("'", "''") + "'"


def _pids_windows(marker: str) -> list[int]:  # pragma: no cover - escalation path
    pattern = _quote_powershell(f"*{marker}*")
    script = (
        "Get-CimInstance Win32_Process | "
        f"Where-Object {{ $_.CommandLine -like {pattern} }} | "
        "Select-Object -ExpandProperty ProcessId"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, timeout=30,
            encoding="utf-8", errors="replace",
        )
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(line) for line in (result.stdout or "").split()
            if line.strip().isdigit()]


def _pids_proc(marker: str) -> list[int]:  # pragma: no cover - escalation path
    pids: list[int] = []
    proc = Path("/proc")
    if not proc.is_dir():
        return pids
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            cmdline = (entry / "cmdline").read_bytes().replace(b"\0", b" ").decode(
                "utf-8", "replace")
        except OSError:
            continue
        if marker in cmdline:
            pids.append(int(entry.name))
    return pids


def _kill_tree(pid: int) -> bool:  # pragma: no cover - escalation path
    if platform.system() == "Windows":
        try:
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True, timeout=30,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return result.returncode == 0
    try:
        os.kill(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        return False
    return True


def _bounded_int(value: Any, ceiling: int = 100_000) -> int:
    try:
        return max(0, min(int(value), ceiling))
    except (TypeError, ValueError):
        return 0


def _safe_attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read a Playwright attribute that may be a property, a method, or gone.

    Playwright's Python API mixes properties (``request.url``) with methods
    (``request.failure``) and both change between versions; a listener that
    raises takes the whole browser thread down with it.
    """
    if obj is None:
        return default
    try:
        value = getattr(obj, name)
    except Exception:  # noqa: BLE001
        return default
    if callable(value):
        try:
            return value()
        except Exception:  # noqa: BLE001
            return default
    return value


def _location(message: Any) -> dict[str, Any]:
    location = _safe_attr(message, "location", None)
    if not isinstance(location, dict):
        return {}
    return {"url": _public_url(str(location.get("url", ""))),
            "line": location.get("lineNumber"),
            "column": location.get("columnNumber")}


def _public_url(url: str) -> str:
    """A URL safe to put in a summary: no query string, bounded length."""
    redaction = Redaction()
    text = redact_url(url or "", redaction, "url")
    return text.split("?", 1)[0][:200]


def _failure_from(exc: Exception) -> BrowserFailure:
    name = type(exc).__name__
    message = str(exc)[:400]
    if isinstance(exc, WatchSkillError):
        return BrowserFailure(code=exc.code, message=exc.message,
                              fix=exc.fix or "", detail=exc.details)
    if "executable doesn't exist" in message.lower() or "playwright install" in message.lower():
        return BrowserFailure(
            code="live.browser.chromium_missing",
            message="chromium is not installed for playwright",
            fix="playwright install chromium",
            detail={"exception": name},
        )
    return BrowserFailure(
        code="live.browser.launch_failed",
        message=f"the browser could not be driven: {name}: {message}",
        fix="run `watch-skill capture-capabilities` to see what this machine "
            "can record",
        detail={"exception": name},
    )


def browser_source(spec: LiveSourceSpec, out_dir: Path,
                   session_id: str = "") -> BrowserSource:
    """Build a browser source from a live spec, under a resolved policy."""
    policy = _policy_from_spec(spec)
    options = BrowserOptions.from_spec(spec, policy)
    decision = check_navigation(options.url, policy)
    # Refused here, before Chromium starts: launching a browser to then
    # refuse its only navigation wastes a second and leaves a profile behind.
    decision.raise_if_denied()
    return BrowserSource(options, out_dir, session_id=session_id)


def _policy_from_spec(spec: LiveSourceSpec) -> NavigationPolicy:
    detail = spec.detail or {}
    hosts = detail.get("allowed_hosts") or []
    blocked = detail.get("blocked_hosts") or []
    return NavigationPolicy(
        allow_loopback=bool(detail.get("allow_loopback", False)),
        allow_private_networks=bool(detail.get("allow_private_networks", False)),
        allowed_hosts=frozenset(str(h).lower() for h in hosts),
        blocked_hosts=frozenset(str(h).lower() for h in blocked),
        resolve=bool(detail.get("resolve_hosts", True)),
    )


__all__ = [
    "BrowserFailure",
    "BrowserOptions",
    "BrowserSource",
    "browser_source",
]
