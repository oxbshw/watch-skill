# Vision provider benchmark

- Machine: Windows-10-10.0.19045-SP0
- Date: 2026-08-08
- Task: transcribe all text in a frame; metric is char-hit rate (multiset recall of ground-truth characters)
- Cost: the provider's own reported input tokens x the dated price in `src/watch_skill/vision/prices.json`

_No provider ran: none of the sixteen had a key configured._

Skipped:

- `anthropic` — no key: set WATCHSKILL_ANTHROPIC_API_KEY
- `custom` — no key: set WATCHSKILL_CUSTOM_API_KEY
- `deepseek` — no key: set WATCHSKILL_DEEPSEEK_API_KEY
- `fireworks` — no key: set WATCHSKILL_FIREWORKS_API_KEY
- `gemini` — no key: set WATCHSKILL_GEMINI_API_KEY
- `groq` — no key: set WATCHSKILL_GROQ_API_KEY
- `minimax` — no key: set WATCHSKILL_MINIMAX_API_KEY
- `mistral` — no key: set WATCHSKILL_MISTRAL_API_KEY
- `moonshot` — no key: set WATCHSKILL_MOONSHOT_API_KEY
- `ollama` — no default model — pass --model
- `openai` — no key: set WATCHSKILL_OPENAI_API_KEY
- `openrouter` — no key: set WATCHSKILL_OPENROUTER_API_KEY
- `qwen` — no key: set WATCHSKILL_QWEN_API_KEY
- `together` — no key: set WATCHSKILL_TOGETHER_API_KEY
- `xai` — no key: set WATCHSKILL_XAI_API_KEY
- `zai` — no key: set WATCHSKILL_ZAI_API_KEY
