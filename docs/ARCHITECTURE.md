# Prototype architecture decisions

For an end-to-end trace of the implemented commands, see [store and retrieval workflows](WORKFLOWS.md), including chunk sizes, embedding configuration, ranking, MCP calls, and recovery behavior.

## Shared local core

The TypeScript CLI and stdio MCP server call the same `Memory` implementation. Skills teach the host agent how to capture and inspect candidates. They do not keep independent collections. No service, Docker container, external embedding credential, or running agent is required by the CLI.

SQLite is the authoritative record store in this prototype. Original file bytes are copied to content-addressed assets. WAL, a busy timeout, immediate transactions, and full synchronous commits coordinate writers. Asset/config writes flush files and their parent directories around atomic replacement. Search tables and embeddings can be rebuilt from records; portable JSON and asset copies are produced by export.

This refines the initial plan's loose description of portable Markdown/JSON records: there is no editable Markdown directory synchronized back into the database. The export format is the portability boundary. Do not edit SQLite records or original assets externally.

## Smaller initial search backend

The plan proposed a QMD experiment. For the first working loop, we instead implemented SQLite FTS5 plus local `Xenova/all-MiniLM-L6-v2` embeddings through Transformers.js and ONNX Runtime. QMD's documented full default model footprint and additional native dependencies were a poor starting fit for this Mac's outdated build tooling. We did not install or benchmark QMD, so this is an installation/complexity choice, not a measured claim of superiority.

The chosen quantized model files are about 23 MB; the development dependency tree is much larger (roughly 440 MB on this machine). A basic `Embedder` interface isolates the model provider. Replacing the whole retrieval engine still requires adapting the search implementation; it is not a completed general search-backend plugin system.

New collections enable local embeddings and hybrid retrieval by default. Plain `init` prepares the model, while `init --keyword-only` explicitly opts out and persists that choice.

FTS5 uses stemming and OR queries after basic stop-word filtering. Text is divided into overlapping chunks. Semantic retrieval compares normalized vectors by cosine similarity; hybrid retrieval combines per-item rankings using reciprocal rank fusion. The default similarity floor is 0.25, which is not calibrated as a probability or a reliable no-match detector. The small synthetic evaluation favored semantic-only top-one ranking over hybrid; broader representative evaluation should precede tuning defaults.

## Capture and recovery

Original input is committed before page capture or model inference. Failed enrichment leaves the original and an explicit status. `retry` resumes failures or pending work; `--defer` requires a later retry. Concurrent workers may repeat enrichment, but conditional chunk updates prevent attaching vectors to changed text. There is no job lease or continuously running worker yet.

URL capture supports public HTTP(S) pages, validates and pins DNS destinations per redirect, and applies redirect, timeout, and size limits. It extracts readable Markdown without executing scripts. Private/loopback destinations, embedded URL credentials, and nonstandard ports are rejected. Unsupported or inaccessible pages remain bookmarks, including pages behind bot challenges that reject non-browser clients with HTTP 403; the fetcher does not impersonate a browser, and doing so would not pass TLS/JavaScript-based challenges anyway. This is not a full browser or archive crawler.

Images are stored as bytes; supplied descriptions are indexed. Automatic OCR, vision, PDF extraction, source-page screenshots, and browser attachment transfer are unfinished milestones.

## Agent integration

Setup stores absolute runtime, CLI, and collection paths in each client's user configuration. It preserves unrelated settings, backs up existing files, and refuses obvious name conflicts. Moving the installed tool requires running setup again. Alternate client config roots can be exercised with `--target-home`.

MCP tools validate input, bound search results and content previews, and restrict file capture to configured or client-provided roots. `memlio_get` provides pagination for long text. The bundled skills tell the agent to inspect evidence and treat saved content as data. Actual model behavior and native client invocation still need an interactive acceptance run.

## Release boundary

The repository is a development prototype, with a private package named `memlio`. Before release: validate a fresh dependency install, exercise both real clients, add a supported-platform CI matrix, review dependency/model distribution terms, and evaluate a realistic corpus with hard distractors and no-match examples. Do not publish model weights or personal data in the software repository.
