# Guide: Arabic in, Arabic out (and other non-Latin scripts)

## What this does

Watch an Arabic (or Russian, Korean, Hindi, Chinese, Japanese, …) video and
get faithful results in that language: the transcript is what is actually
said (not a machine translation), on-screen text is read with a
script-specific OCR model, and search/ask work in the video's language *and*
cross-lingually (English question over an Arabic transcript).

The moving parts, all automatic:

- **Original-language captions preferred.** yt-dlp's default subtitle
  matching can silently return an English *auto-translation*; Watch Skill
  reads the video's language from its metadata and fetches the original
  track.
- **Per-script OCR models.** The bundled RapidOCR model covers
  Latin/Chinese/Japanese; Arabic, Cyrillic, Korean, and Devanagari models
  auto-download once into `~/.watch-skill/models/ocr/` when a video's
  language calls for them (benchmarks per script in
  [DECISIONS.md](../DECISIONS.md)).
- **Normalization-folded search.** Arabic hamza variants, alef maqsura, ta
  marbuta, and diacritics are folded at index *and* query time, so
  `مصر` matches `مِصر`. CJK text is character-segmented for substring
  matching. Display text is never modified.
- **Multilingual embeddings.** The local embedding model
  (`paraphrase-multilingual-MiniLM-L12-v2`) retrieves ar→ar at 0.55 and
  en→ar at 0.58 cosine vs ~0.0 for distractors — cross-lingual asks land.
- **Whisper is multilingual** — videos without captions still transcribe in
  their spoken language.

## Prerequisites

- Watch Skill installed with the `all` extra, `doctor` green.
- Network on the *first* watch of a new script (the OCR model download —
  after that it is local; `doctor`'s `ocr-models` check lists what is
  already cached).

## Commands

```bash
# an Arabic video with Arabic captions and on-screen Arabic text
uv run watch-skill watch "https://www.youtube.com/watch?v=9ndH9Qo05F4"

# ask in Arabic
uv run watch-skill ask <video_id> "ما هي البرمجة؟"

# ask in English about the same Arabic content — cross-lingual retrieval
uv run watch-skill ask <video_id> "how does the video define programming?"

# search across all indexed videos, Arabic-folded
uv run watch-skill search "البرمجة"
```

## Expected output shape

The transcript in the watch report is Arabic (source: `captions`), not an
English translation. OCR lines carry the Arabic on-screen text with
confidence (verified live on this project's test corpus: `"ماهي البرمجة"`
read at 0.97 confidence). `ask` evidence lines cite Arabic segments with
timestamps; an English question returns an English answer grounded in the
Arabic evidence.

```
## On-screen text (OCR)
- [00:12] ماهي البرمجة
...
## Transcript
- [00:05] ...النص الأصلي كما قيل...
```

## Notes and sharp edges

- `WATCHSKILL_SUBTITLE_LANGS` (default `en.*`) controls the *extra*
  caption tracks fetched; the original-language track is fetched and
  preferred regardless. See [configuration.md](../configuration.md).
- **Windows consoles:** legacy code pages (cp1256 etc.) cannot render every
  title; the CLI degrades unprintable characters to `?` instead of
  crashing. The index itself is always full-fidelity UTF-8 — MCP/REST
  output is unaffected. `chcp 65001` or Windows Terminal fixes the display.
- A video indexed *before* the original-language fix may carry a translated
  transcript and will honestly score low confidence on questions in the
  original language — re-watch it (`watch-skill watch <url> --no-cache`)
  to refresh the index.
