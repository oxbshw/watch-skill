# Perception benchmark

- Machine: Windows-10-10.0.19045-SP0, 8 GB RAM, CPU-only
- Date: 2026-07-11
- Metric: char-hit rate (normalized multiset recall of ground-truth chars)
- Peak RSS is process-wide and cumulative — read it as 'high-water mark by then'

| backend | fixture | char-hit | latency (s) | peak RSS (MB) |
|---|---|---|---|---|
| rapidocr | screen_text | 100% | 10.64 | 358 |
| rapidocr | subtitles | 100% | 2.16 | 430 |
| rapidocr | arabic_rtl | 94% | 2.44 | 430 |
| rapidocr | cjk | 100% | 2.17 | 452 |
| rapidocr | sea_lao | 0% | 2.75 | 452 |
| rapidocr | mixed_script | 81% | 1.72 | 452 |
| router (multi-script) | screen_text | 100% | 2.5 | 452 |
| router (multi-script) | subtitles | 100% | 2.19 | 452 |
| router (multi-script) | arabic_rtl | 88% | 3.55 | 452 |
| router (multi-script) | cjk | 100% | 2.17 | 452 |
| router (multi-script) | sea_lao | 0% | 2.33 | 452 |
| router (multi-script) | mixed_script | 98% | 3.34 | 452 |
| vision (ollama:moondream) | screen_text | 79% | 96.2 | 452 |
| vision (ollama:moondream) | subtitles | 100% | 43.2 | 452 |
| vision (ollama:moondream) | arabic_rtl | 18% | 46.03 | 452 |
| vision (ollama:moondream) | cjk | 0% | 50.36 | 452 |
| vision (ollama:moondream) | sea_lao | 0% | 46.94 | 452 |
| vision (ollama:moondream) | mixed_script | 58% | 50.05 | 452 |

tesseract: not installed on this machine at bench time — the sea_lao row above is the RapidOCR reading gap the fallback exists for.
