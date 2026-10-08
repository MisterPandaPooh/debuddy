# Local model comparison — 2026-10-08

`node bench/compare.mjs` on an Apple M4 Pro (48 GB), Ollama 0.35, Q4 quantizations.
Four statements of `getUser()` with the production prompt; **facts** = 5 regex checks
(Watch mentions the throw / the null, Does uses the resolved callee instead of "calls X"…);
**judge** = `qwen3-coder:30b-a3b` grading each answer 0 (wrong) / 1 (true but shallow) / 2 (useful).
With four cases, ±1 judge point is noise; the tiers are what matters.

| size GB | model | format | facts | judge | ms/line |
|---|---|---|---|---|---|
| 0.4 | qwen2.5-coder:0.5b | 4/4 | 5/5 | 6/8 | 194 |
| 0.5 | qwen3:0.6b | 3/4 | 4/5 | 4/8 | 274 |
| 0.8 | gemma3:1b | 4/4 | 5/5 | 5/8 | 406 |
| 1.0 | qwen2.5-coder:1.5b | 4/4 | 5/5 | 2/8 | 307 |
| 1.3 | llama3.2:1b | 4/4 | 5/5 | 1/8 | 300 |
| 1.4 | qwen3:1.7b | 4/4 | 5/5 | 5/8 | 328 |
| 1.5 | granite3.3:2b | 4/4 | 4/5 | 8/8 | 599 |
| 1.8 | smollm2:1.7b | 4/4 | 5/5 | 7/8 | 587 |
| 1.9 | **qwen2.5-coder:3b** (default) | 4/4 | 4–5/5 | 7–8/8 | 420–490 |
| 2.0 | llama3.2:3b | 4/4 | 5/5 | 7/8 | 450 |
| 2.5 | qwen3:4b | 0/4 | 1/5 | 0/8 | 1462 |
| 3.3 | gemma3:4b | 4/4 | 3/5 | 7/8 | 1047 |
| 4.4 | mistral:7b | 4/4 | 5/5 | 8/8 | 1455 |
| 4.7 | qwen2.5-coder:7b | 4/4 | 4/5 | 7/8 | 860 |
| 9.0 | qwen2.5:14b-instruct-q4_K_M | 4/4 | 5/5 | 8/8 | 2012 |
| 18.0 | qwen3-coder:30b-a3b-q4_K_M | 4/4 | 5/5 | 6–8/8 | 700 |

## Reading

- **Above ~2 GB, latency doubles or triples without a visible gain in correctness**: the
  deterministic context (resolved callees, types, test titles, throw sites) does the heavy
  lifting, so the prompt does not need a bigger model.
- `qwen2.5-coder:0.5b` is a real option for very constrained machines: correct, shallow, 190 ms.
- `qwen3:4b` leaks its reasoning into the answer even with `think: false` / `/no_think`;
  `gemma3:4b` invents "calls X" on resolved callees. Neither is usable with this prompt.
- `qwen3-coder:30b-a3b` (MoE, 3B active) is as fast as a 3B dense model; only its 18 GB
  footprint keeps it out of the recommendations.

## Recommendation (shown in the model picker)

| Tier | Model | Size |
|---|---|---|
| minimum | `qwen2.5-coder:0.5b` | 0.4 GB |
| default | `qwen2.5-coder:3b` | 1.9 GB |
| alternative | `llama3.2:3b` | 2.0 GB |
| better, slower | `qwen2.5-coder:7b` | 4.7 GB |
| max (9 GB) | `qwen2.5:14b-instruct-q4_K_M` | 9.0 GB |
