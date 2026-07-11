# Cost benchmark

- Machine: Windows-10-10.0.19045-SP0, 8 GB RAM, CPU-only
- Date: 2026-07-11
- Load: 4 videos (12 s of footage), 6 questions (2 repeats)
- Prices: src/watch_skill/vision/prices.json (as of 2026-07-11)

| approach | est. tokens | est. $ | notes |
|---|---|---|---|
| watch-skill, fully offline | ~5,868 | $0.00 | measured: 5 questions answered, 5 cache hits, 939s wall |
| raw frames into context | ~18,890 | $0.0019 | computed from the same index: 15 frames x every question, priced at the cheapest paid model ($0.1/Mtok) |
| watch-skill, Gemini free tier | (not run) | $0 by tariff | no GEMINI_API_KEY configured on this machine at bench time — token path identical to offline plus verify calls |

Spend split (offline arm): {'cache_hits': 5, 'text_first': 2067, 'local_escalation': 0, 'vision_call': 3409, 'response_frames': 392, 'usd_spent_total': 0.0}

The ratio is the story: ~3x fewer tokens than shipping frames, before the cache makes repeats free.
