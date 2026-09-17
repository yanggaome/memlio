# Prototype validation

> Historical record. These runs predate the simplification that removed `init`, `retry`, `reindex`, `doctor`, `--mode`, `--defer`, and the keyword-only setting, and renamed `retrieve` to `find`. Behaviour described below still holds unless it refers to one of those commands. The automated suite now has 27 tests (26 without the cached model).

Tested on an Intel Mac, macOS 13.7.8, Node v24.19.0. Results are from this checkout, not upstream benchmark claims.

## Automated checks

23 tests pass with the cached local model supplied. This covers separate CLI processes and unrelated working directories, eight concurrent writers, concurrent duplicate saves, preservation after source-file deletion, file-root restrictions, failed URL capture, readable text extraction, public destination filtering, rebuild/delete behavior, shared assets, export/import, traversal rejection, embedding-provider failure, type/date filters, config preservation/conflicts, real stdio MCP requests through the official SDK, and offline semantic retrieval across new processes.

The default suite runs 22 tests and skips the real-model test unless `MEMLIO_MODEL_CACHE` points to already downloaded model files. The real-model child processes force offline mode. Do not set global `MEMLIO_OFFLINE=1` for the full suite: the private-network capture test deliberately exercises destination validation instead of the offline short circuit.

TypeScript compilation passes. No tests use a personal memory collection. A live `example.com` bookmark capture succeeded and preserved readable text after network access was available; earlier network failure retained the bookmark with an explicit error.

Skill instructions were reviewed manually. The bundled Codex skill validator could not run because the available Python installations lack PyYAML. Claude's `argument-hint` is client-specific and is outside that validator's allowed frontmatter keys. Native skill invocation was tested in GitHub Copilot CLI 1.0.85 on macOS on 2026-09-16: `/memlio status`, a store, and a find in prompt mode each invoked the skill and the expected memlio tool. Claude Code and Codex invocation have not been tested the same way.

## Synthetic retrieval experiment

Corpus: 100 text records, consisting of 30 deliberately distinguishable target records and 70 similar warehouse receipts used as distractors. Five targets contain written image descriptions, not image embeddings or OCR output. Thirty handcrafted queries target one record each. No agent rewrites queries. Fixtures and benchmark code are in `scripts/evaluate.mjs`.

Model: `Xenova/all-MiniLM-L6-v2`, quantized q8, mean pooling, normalized vectors. Model files were already cached; model download time is excluded. All searches run in the same process after indexing.

| Mode | Correct first result | Intended item in first five | Median query | p95 query |
| --- | ---: | ---: | ---: | ---: |
| Keyword | 12/30 | 16/30 (53.3%) | 0.86 ms | 1.08 ms |
| Semantic | 28/30 | 29/30 (96.7%) | 7.66 ms | 11.77 ms |
| Hybrid | 22/30 | 29/30 (96.7%) | 10.47 ms | 15.64 ms |

The combined record-creation and indexing run took 1.72 seconds, including model initialization from disk. Peak reported process RSS was about 176 MiB. Model cache disk usage was 23 MiB; the full development dependency tree was 440 MiB. Search timings exclude fresh CLI startup and should not be presented as end-to-end command latency. Filesystem durability was strengthened after this timing run; ingest timing has not been remeasured. The final offline regression verifies model loading and retrieval after that change.

The missed semantic query was “fix my squeaky bike,” targeting a bicycle-chain maintenance note. Two of three queries for nonexistent memories returned five weak candidates; one returned no results. This highlights the need for evidence inspection and better no-match evaluation. Similarity is not a confidence probability.

The corpus is small and its distractors are easy. The result supports continued prototyping, not a general recall guarantee or completion of the original real-world acceptance target. Multilingual queries, near-duplicate articles, long documents, genuine image recall, large collections, and agent-assisted retrieval remain unmeasured. QMD was not benchmarked.

## Packaging and release checks

The package is assembled locally with existing dependencies. Its source checkout and packaged executable/skill paths are checked using an isolated temporary directory. This is not a fresh dependency installation: the package check reuses this checkout's installed dependencies.

A separate npm bootstrap download was rejected by automatic approval review because the workspace was out of credits. It was not retried through another route. Fresh npm installation, Linux and additional Node versions, real Codex/Claude/Copilot CLI round trips, the original-code license, CI, and GitHub/npm publication remain pending.

## Memlio rename validation

The repo, package, CLI, MCP server/tools, agent skills, and environment variables now use `memlio` / `MEMLIO_*`. The default collection is `~/.local/share/memlio`. There are no legacy aliases or migration paths. All 21 tests passed after the rename, including the real local-model test and fresh-server MCP integration. The seven issues recorded in the separate self-review remain outside this naming change.

## Semantic search default

New collections enable embeddings and hybrid search by default. The offline real-model regression now exercises plain `init` and default retrieval. Additional regressions cover saving without initialization, default hybrid retrieval, explicit keyword-only initialization with an empty offline model cache, preservation of that preference on later initialization/path changes, and failed attempts to re-enable embeddings without a cached model. General storage and MCP transport tests explicitly use keyword-only collections to avoid incidental model downloads. All 23 tests and TypeScript compilation pass.

## Claude Code interactive acceptance

Run on the same Intel Mac with Node v24.21.0 installed through nvm; the machine had no Node on PATH beforehand, and Homebrew could not install one (no write access to `/usr/local/Cellar`, and it would have compiled Node and its dependencies from source on macOS 13). `memlio setup claude` registered the MCP server with the nvm Node path and installed the skill; `claude mcp list` reported the server connected after a restart.

Through the `/memlio` skill in a live session: an arXiv abstract and a Hugging Face blog post were captured and embedded; `https://ifm.ai/k2/` was saved as a bookmark with `captureError` HTTP 403 from a Cloudflare managed challenge (`cf-mitigated: challenge`; a browser user agent also received 403); re-saving the same URL deduplicated, and re-saving with a title and note created a second record, after which the bare one was deleted through `memlio_delete`. `/memlio retrieve llm as judge from netflix` returned the arXiv paper first in hybrid mode with keyword and semantic (0.50) evidence. The collection lives in `~/.local/share/memlio` with user-only file permissions.

The 23-test suite also passes under the nvm Node. Under the Node bundled inside ChatGPT.app, the real-model test fails at `dlopen` because pnpm's extracted `onnxruntime_binding.node` is unsigned; ad-hoc signing or using a separately installed Node resolves it.
