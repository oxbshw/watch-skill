# Capture capabilities

What this machine can actually record — established by probing, never
assumed.

```bash
watch-skill capture-capabilities
```

Also available as the `capture_capabilities` MCP tool and
`GET /v1/capture-capabilities`.

## The rule

A capability is **never** reported `available` because a code path for it
exists. Every `available` was established by finding the binary, the input
device in *this* ffmpeg build, or the Python runtime the path actually needs.

Each entry reports how its answer was reached:

| `verified` | Means |
|---|---|
| `machine_tested` | A capture was actually performed here by the test suite |
| `probed` | Dependencies checked here and now — binary present, device compiled in, driver importable |
| `not_tested` | Nobody checked. Never paired with `available` |

And a status:

| `status` | Means |
|---|---|
| `available` | Probed, and expected to work |
| `degraded` | The mechanism is present but something unprobeable stands in the way — usually an OS permission that can only be discovered by attempting a capture |
| `unavailable` | Will not work; `repair` says what would change that |
| `untested` | Unknown |

## Live vs recorded

Two different things, and the matrix covers both:

- **Recorded capture** — `capture`, `loop_start`: record for N seconds, then
  analyse. Browser, screen, and window capture work here.
- **Live sessions** — `start_live_watch`: analyse while recording. Only
  `file_replay` and `stream` are implemented as live sources today.

A kind reported `available` for recorded capture is not thereby a live source.

## Platform matrix

| Kind | Windows | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| `file_replay` | ffmpeg `-re` | ffmpeg `-re` | ffmpeg `-re` | ffmpeg `-re` |
| `stream` | ffmpeg | ffmpeg | ffmpeg | ffmpeg |
| `browser` | Playwright | Playwright | Playwright | Playwright |
| `screen` | `gdigrab` | `avfoundation`, **degraded** | `x11grab` | **unavailable** |
| `window` | `gdigrab`, exact title | **unavailable** | **unavailable** | **unavailable** |
| `camera` | `dshow`, **degraded** | `avfoundation`, **degraded** | `v4l2`, **degraded** | `v4l2`, **degraded** |
| `microphone` | `dshow`, **degraded** | `avfoundation`, **degraded** | `alsa`, **degraded** | `alsa`, **degraded** |
| `webrtc` | **unavailable** | **unavailable** | **unavailable** | **unavailable** |

### Why several of those are honest rather than green

**macOS screen** is `degraded`, not `available`. The AVFoundation device is
present, but Screen Recording permission cannot be probed without attempting a
capture, and only the OS can answer. **ScreenCaptureKit is not implemented** —
this is the AVFoundation path, and it has not been machine-tested by this
build.

**Linux Wayland screen** is `unavailable`. Wayland refuses `x11grab` by
design, and the PipeWire / `xdg-desktop-portal` ScreenCast path is not
implemented here. The probe reports the missing portal so the message is
actionable, but a portal being installed would not make this work.

**Camera and microphone** are `degraded` wherever the ffmpeg device layer
exists. A device layer being present is not a device being present, and
enumerating one costs a real capture attempt on every platform.

**`window` outside Windows** is unavailable: per-window capture is implemented
for `gdigrab` only. Capture the full screen and crop, or use browser capture
for a page.

**WebRTC** has no implementation. Push frames through the SDK instead
(`LiveSourceKind.PUSHED`).

## What CI verifies

Capability *detection* is tested on every platform in CI: the shape of every
entry, that no `available` carries `verified: not_tested`, and that every
`unavailable` carries a repair or an explicit limitation.

Actual hardware capture is not tested in CI — there is no camera, no
microphone, and no desktop session on the runners. That is why `verified`
exists as a field: it distinguishes what was probed from what was proved.

`file_replay` is the one kind marked `machine_tested`, because the live
end-to-end suite really does capture through it on every run.
