# 15 — Private offline workflow

This example builds a short clip locally, extracts its on-screen text, indexes it, and asks
a question without permitting cloud speech or vision services. It is a compact check for
air-gapped or sensitive-video workflows.

## Run

```bash
uv run --no-sync python examples/15-private-offline-workflow/offline_workflow.py
```

The script sets `WATCHSKILL_COST_POLICY=offline_only`, disables cloud STT, and uses a
temporary data directory. No URL is fetched and no frame or audio payload is sent to a
provider.

Expected result:

```text
indexed: ...
answer: Evidence:
- [00:01] (ocr) RELEASE 1.4.0
cloud calls allowed: no
```

With no local language model running, the honest offline result is the timestamped OCR
evidence rather than synthesized prose. If an Ollama model is available, the same evidence
may be summarized into a sentence. If the script cannot find ffmpeg, run
`watch-skill doctor --fix` first.

For a permanent offline configuration, put these values in `.env`:

```dotenv
WATCHSKILL_COST_POLICY=offline_only
WATCHSKILL_CLOUD_STT_ENABLED=false
WATCHSKILL_VISION_CHEAP_PROVIDER=ollama
WATCHSKILL_VISION_STRONG_PROVIDER=ollama
```

See [Configuration](../../docs/configuration.md) for model and storage settings.
