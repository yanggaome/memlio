# Architecture decisions

For an end-to-end trace of the commands see [WORKFLOWS](WORKFLOWS.md).

## One local core, two front ends

The CLI and the stdio MCP server share one `Memory` class. The skills teach the host agent how to call the five MCP tools and how to inspect evidence; they hold no logic of their own. Nothing runs in the background: no daemon, no container, no external service, no API key.

## SQLite is the record store

Records are JSON rows in SQLite. WAL mode, a busy timeout, `BEGIN IMMEDIATE` transactions, and full synchronous commits let separate CLI processes and a long-running MCP server write to the same file. Original file bytes are copied into content-addressed files under `assets/`, written atomically and fsynced. The chunk, keyword, and vector tables are derived and can be rebuilt from the records with `repair`. `export` produces the portable form: `records.json` plus the asset copies.

## Small local search instead of a search engine

FTS5 plus a 23 MB quantized MiniLM model covers keyword and paraphrase recall for a personal collection without a vector database, a reranker, or a multi-gigabyte model download. The `Embedder` interface isolates the model so a different local or remote provider can be substituted; the ranking code itself is not pluggable.

Semantic search is always on. If the model cannot be loaded, search runs on keywords and says so in a warning, and pending embeddings are completed by the next search that has the model. This replaces an earlier explicit keyword-only mode: one fewer setting, one fewer command, and no client restart after changing it.

## Originals before enrichment

A save commits the record and keyword index first, then fetches the page and computes embeddings. Both steps write their failure onto the record. `store` therefore never loses the thing you asked to keep, and `status` and `repair` deal with the rest.

## URL capture is deliberately narrow

Public HTTP(S) only, DNS resolved and checked per redirect and pinned to the socket, standard ports, size and time limits, no script execution, no browser impersonation. Pages that reject non-browser clients are saved as bookmarks with a clear error. A headless browser would capture more and cost far more in dependencies and surface area.

## Agent integration by configuration, not by plugin

`setup` writes the MCP server entry and the skill file into each client's user-level configuration, keeps unrelated settings, keeps one backup, and refuses to overwrite entries it did not create. The file capture boundary for MCP is a list of allowed folders plus the client's reported roots, enforced in the server, not in the prompt.

## Not yet

npm publication, a fresh-install CI matrix, Linux validation, OCR and PDF extraction, browser-assisted capture, and an evaluation on a realistic personal corpus with hard distractors.
