# Memlio

Save a bookmark, note, or picture now. Find it later by describing what you remember.

**Status: working local prototype, not yet published.** Written in TypeScript, with a CLI, an MCP server, and skills for Codex and Claude Code. One collection works across terminal sessions and project directories.

See [how storing and retrieval work](docs/WORKFLOWS.md) for the complete flow: capture, chunking, keyword indexing, local embeddings, ranking, and the agent/MCP reasoning loop.

## Install from source

Requires Node.js 22.13+; development and native dependencies have been tested on an Intel Mac with Node 24.19. Use Node 24+ with pnpm 11.19.0 for the reproducible development setup:

```sh
cd /path/to/memlio
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
node dist/cli.js store "An idea to revisit"
node dist/cli.js retrieve "idea"
```

If you already have Node and npm, install pnpm with `npm install --global pnpm@11.19.0`. In iTerm2, the shell's PATH must include your Node installation; installing the Codex desktop app alone does not provide these commands on PATH.

To use `memlio` from any directory, link this checkout:

```sh
pnpm link --global
memlio doctor
```

The direct `node /absolute/path/to/memlio/dist/cli.js` form also works. Keep the checkout in place after linking or registering clients. The package is named `memlio` and remains private until release; there is no public `npm install -g memlio` release yet.

## Save and recall

```sh
memlio store "Try weekly screenshots of competitor pricing"
memlio store https://example.com/article --note "For my queue project"
memlio store /absolute/path/to/dashboard.png \
  --description "Dark dashboard with orange charts and a left sidebar"
printf '%s\n' 'A longer note from another command' | memlio store --stdin

memlio retrieve "competitor pricing"                 # Hybrid search by default
memlio get <item-id>
memlio status
```

Absolute paths, `./paths`, and `../paths` are recognized as files. For a bare filename, use `--kind file`. Use `--kind note` for literal text resembling a URL or path. Exact repeated content with the same title/context is deduplicated; adding different context creates another record.

Local natural-language similarity search is enabled by default. `memlio init` downloads/prepares the quantized MiniLM model on first use. Saving without initialization also loads the model when embeddings are needed. To re-enable semantic search after opting out and cover previously saved items:

```sh
memlio init --semantic       # Re-enable after an explicit keyword-only opt-out
memlio reindex               # Adds embeddings to previously saved content
memlio retrieve "that idea for monitoring rival companies"
memlio retrieve "orange charts" --kind file --limit 5
memlio retrieve "queue project" --mode keyword
```

New collections use hybrid keyword/vector search by default. Use `memlio init --keyword-only` to opt out of embeddings and model downloads; later `init` calls preserve that explicit preference. Results are candidates with evidence, not guaranteed matches. The agent can inspect them and refine its query. Direct CLI retrieval also works without an agent or an API key.

The downloaded model files total about 23 MB. Node dependencies add substantially more disk space. After the model is cached, `MEMLIO_OFFLINE=1 memlio retrieve "..."` works without network access. `MEMLIO_OFFLINE=1` also disables bookmark fetching. `MEMLIO_MODEL_CACHE` optionally selects a shared model cache.

## Connect Codex and Claude Code

```sh
memlio setup codex --dry-run
memlio setup codex
memlio setup claude
```

Setup registers an MCP server and installs the bundled personal skill, preserving unrelated client settings and backing up existing configuration files. Restart each client afterward.

```text
# Codex
$memlio store A useful thought for later
$memlio retrieve that thought about background jobs

# Claude Code
/memlio store https://example.com/article
/memlio retrieve that article about background jobs
```

Both registrations use the same absolute collection path and Node executable. File capture through MCP requires a client-provided filesystem root or an explicitly allowed folder:

```sh
memlio init --allow-path /absolute/path/to/screenshots
```

Restart a running MCP server/client after changing semantic mode or allowed paths; its configuration is loaded at startup.

Direct CLI file arguments authorize reading that selected file. Pasted agent attachments still need an accessible file path for their original bytes to be preserved. Automatic OCR and image understanding are not implemented; descriptions supplied by you or an agent make pictures searchable.

MCP transport and fresh-session persistence have been tested with the official SDK client. The real Codex-to-Claude interactive workflow remains to be exercised; setup has not modified your personal client configuration automatically.

## What gets saved

- **Notes:** original text and your context.
- **Bookmarks:** original URL, context, and an attempted readable Markdown snapshot with capture time and final URL. This is a text snapshot, not raw HTML, a screenshot, or a complete site archive. Login-only pages, JavaScript-only pages, and sites behind bot challenges (for example Cloudflare's managed challenge, which returns HTTP 403 to non-browser clients regardless of user agent) fail to capture; the bookmark remains saved with an error, and `retry` will not get past a bot challenge. To make such a bookmark findable, store it with a `--note` describing the page, or paste the page text as a note with the URL as context.
- **Files:** a copy of the original bytes, independent of the source path. Text extraction currently covers `.txt`, `.md`, `.csv`, and `.json`. Images and other binaries rely on supplied descriptions; PDF text extraction is not implemented.

Storage defaults to `~/.local/share/memlio`. Override it with `MEMLIO_HOME` or `memlio --home /path/to/collection ...`. SQLite contains the authoritative records and rebuildable search tables; copied assets live alongside it. Keep the collection outside your source repository.

Saving normally completes capture and indexing before returning, but preserves originals first. Use `--defer` for an immediate save and run `memlio retry` later. There is no background daemon yet. Fetching and local inference are independent of an active agent session.

```sh
memlio store https://example.com --defer
memlio retry
memlio export /path/to/new-backup-directory
memlio --home /path/to/restored-collection init  # Prepare the default local embedding model
memlio --home /path/to/restored-collection import /path/to/new-backup-directory
memlio --home /path/to/restored-collection retry
memlio delete <item-id> --yes
```

Export includes original assets and JSON records, but not model files or derived embeddings. `reindex` rebuilds search tables from stored records; it cannot repair a lost primary database. Deleting an item does not erase older exports or perform forensic disk erasure.

A fresh restored collection defaults to semantic mode; `retry` generates its missing embeddings. An existing explicit keyword-only preference is preserved until `init --semantic` re-enables it.

No external embedding API is used. Website capture contacts the saved website; the first model setup contacts Hugging Face. Content retrieved through Codex or Claude enters that agent's context and follows its data handling settings. Saved pages are treated as untrusted data.

## Development and current limits

```sh
pnpm test
pnpm check
MEMLIO_MODEL_CACHE=/path/to/downloaded/models pnpm test
MEMLIO_MODEL_CACHE=/path/to/downloaded/models MEMLIO_OFFLINE=1 pnpm eval
pnpm pack
```

The real-model regression test skips unless `MEMLIO_MODEL_CACHE` is set; the other tests do not download models. The evaluation is synthetic, with no private collection data. See [validation results](docs/VALIDATION.md), [architecture decisions](docs/ARCHITECTURE.md), and the [original plan and milestone status](PLAN.md).

Current scope is a single user's Mac. Semantic search scans vectors in memory and is intended for small collections; large-library performance, multilingual quality, OCR, browser-assisted snapshots, device sync, fresh-install testing, Linux support, and the original-code license decision remain release work. pnpm dependency build scripts are disabled for the tested Mac prebuilt binaries; other platforms may need different installation handling.
