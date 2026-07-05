# 05 — Arabic in, Arabic out (multilingual)

Index an Arabic video with its **original** Arabic captions, then ask it a
question in Arabic and get Arabic evidence back verbatim with timestamps.
The same machinery covers Russian, Korean, Hindi, Chinese, Japanese, …:
original-language caption preference, per-script OCR models, and
normalization-folded search (`مصر` matches `مِصر`).

Needs network only for the first index (download + captions + one-time OCR
model). Asking runs fully offline. Full background:
[docs/guides/arabic-in-arabic-out.md](../../docs/guides/arabic-in-arabic-out.md).

Files:

- `index_arabic.py`  — watches an Arabic programming intro with
  `WATCHSKILL_SUBTITLE_LANGS=ar-orig,ar` so the Arabic tracks are fetched
  (the default only downloads `en.*` extras)
- `ask_in_arabic.py` — asks the indexed video "ما موضوع الفيديو؟"
  ("what is the video about?")

## Run

```
uv run --no-sync python examples/05-multilingual-arabic/index_arabic.py
uv run --no-sync python examples/05-multilingual-arabic/ask_in_arabic.py
```

Both take overrides: a URL for the first, `<video> <question>` for the
second. CLI equivalent:

```
set WATCHSKILL_SUBTITLE_LANGS=ar-orig,ar
uv run --no-sync watch-skill watch "https://www.youtube.com/watch?v=9ndH9Qo05F4"
uv run --no-sync watch-skill ask <video_id> "ما موضوع الفيديو؟"
```

## Example output

`ask_in_arabic.py` (real run on this machine, local-only mode — no vision
provider, so the engine returns the honest evidence list; note the
evidence is the actual Arabic transcript, not a translation):

```
question: ما موضوع الفيديو؟

The video does not clearly show an answer to: 'ما موضوع الفيديو؟'.
No guess is being made. The closest indexed moments are:
- [02:54] (segment) يعني لو قلت لك ما هي الاكواد هتقول لي ايه? هتقول لي هي
- [03:56] (segment) عنده حق بقى. طيب هو في دي الكبير ما كنش عنده حق. ولا مرار
- [02:38] (segment) انا ما قلتلوش تحديدا في كل قطعة هيعمل ايه? هيقوم عامل اخطاء
- [01:32] (segment) ويجمع لي الاشكال بتاعة لعبة الليجو. زي ما انت اكيد عارف
- [03:08] (segment) علشان ما يحصلش اخطاء والبرنامج يتنفز معنا بنجاح. الله عليك. هي
If the answer should be visible, try get_moment on a timestamp above, or re-watch with a focused start/end window.

(confidence: 0.32 | verified: False)
```

With a vision/LLM provider configured, the same command synthesizes a
verified Arabic answer from that evidence instead of listing it.

Windows console note: both scripts force UTF-8 stdout so the Arabic text
survives printing on legacy code pages; use Windows Terminal or
`chcp 65001` for correct display.
