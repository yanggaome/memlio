# Memlio

A personal memory for Claude Code and Codex. Save a bookmark, note, or picture from inside the agent; find it later, in any project or session, by describing what you remember.

**Status: working local prototype, not yet published.** Memlio runs as a local MCP server with a `/memlio` skill for Claude Code and a `$memlio` skill for Codex. Both agents share one collection on your machine: SQLite records, copies of saved files, a keyword index, and local embeddings for natural-language search. No external embedding API and no cloud storage. A standalone CLI is also included for scripting, backup, and use without an agent.

See [how storing and retrieval work](docs/WORKFLOWS.md) for the complete flow: capture, chunking, keyword indexing, local embeddings, ranking, and the agent/MCP reasoning loop.

## Quick start

### 1. Install Node and build

Requires Node.js 22.13+. Development and native dependencies have been tested on an Intel Mac with Node 24.19 and 24.21 and pnpm 11.19.0.

If Node is not installed, a user-space install through [nvm](https://github.com/nvm-sh/nvm) needs no sudo or compiler and works on older macOS releases where Homebrew would build Node from source:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new shell, then:
nvm install 24
npm install --global pnpm@11.19.0
```

Then build and prepare the collection. `init` creates `~/.local/share/memlio` and downloads the ~23 MB local embedding model once, so the first save from an agent does not wait on a download:

```sh
cd /path/to/memlio
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js init
```

### 2. Register with Claude Code and/or Codex

```sh
node dist/cli.js setup claude
node dist/cli.js setup codex          # add --dry-run to preview changes
```

Setup registers the MCP server and installs the bundled skill, preserving unrelated client settings and backing up existing configuration files. It records the absolute path of the Node executable that ran it, so run it with the Node you want the server to use (for example the nvm-installed one, not an application-bundled copy). Keep the checkout in place afterward; re-run setup if you move it.

Restart the client. In Claude Code, `claude mcp list` should show `memlio: … - ✔ Connected`, and `/memlio` appears as a skill in a new session.

### 3. Save and recall from the agent

```text
# Claude Code
/memlio store https://example.com/article
/memlio store https://example.com/article why this page matters to me
/memlio store /absolute/path/to/dashboard.png dark dashboard with orange charts
/memlio retrieve that article about background jobs

# Codex
$memlio store A useful thought for later
$memlio retrieve that thought about background jobs
```

The skill hands the whole argument string to the agent: the first URL, path, or quoted text is what gets saved, and free text after it becomes the note. On retrieve, the agent searches the collection, inspects likely matches, and answers with the original link or file plus excerpts as evidence. Results are candidates, not guaranteed matches; the agent is instructed to say so when matches are weak or absent, and to treat saved content as data rather than instructions.

## Using Memlio from an agent

**Notes and bookmarks** need nothing extra. A bookmark is fetched immediately for a readable text snapshot; if the fetch fails, the bookmark is still saved with an error and the note remains searchable.

**Files** through MCP require a client-provided filesystem root or an explicitly allowed folder, because the server will not read arbitrary paths on the agent's behalf:

```sh
node dist/cli.js init --allow-path /absolute/path/to/screenshots
```

Direct CLI file arguments authorize reading that selected file. A pasted image attachment is not automatically available to the server as bytes; it needs an accessible file path for the original to be preserved. Automatic OCR and image understanding are not implemented; a description supplied by you or the agent is what makes a picture searchable.

**Duplicates:** saving the same content with the same title and note is deduplicated to the existing record. Saving it again with a different note creates a second record rather than updating the first; delete the older one if you no longer want it (`/memlio` can delete an explicitly identified item, or use `memlio delete <id> --yes`).

**Configuration changes** (semantic mode, allowed paths) are read at server startup. Restart the client after changing them.

**What has been exercised:** MCP transport and fresh-session persistence with the official SDK client, and the Claude Code path interactively: `setup claude`, a restart, `/memlio store` of an arXiv abstract and a blog post (captured and embedded), a bot-challenged page (saved as a bookmark with an error), and `/memlio retrieve` finding the paper by a paraphrased description. The Codex interactive workflow remains to be exercised.

## What gets saved

- **Notes:** original text and your context.
- **Bookmarks:** original URL, context, and an attempted readable Markdown snapshot with capture time and final URL. This is a text snapshot, not raw HTML, a screenshot, or a complete site archive. Login-only pages, JavaScript-only pages, and sites behind bot challenges (for example Cloudflare's managed challenge, which returns HTTP 403 to non-browser clients regardless of user agent) fail to capture; the bookmark remains saved with an error, and `retry` will not get past a bot challenge. To make such a bookmark findable, save it with a note describing the page, or paste the page text as a note with the URL as context.
- **Files:** a copy of the original bytes, independent of the source path. Text extraction currently covers `.txt`, `.md`, `.csv`, and `.json`. Images and other binaries rely on supplied descriptions; PDF text extraction is not implemented.

Storage defaults to `~/.local/share/memlio`: `memory.sqlite` holds the authoritative records and rebuildable search tables, `assets/` holds copied files, and `models/` holds the cached embedding model. Override the location with `MEMLIO_HOME` or `memlio --home /path/to/collection ...`, and re-run setup so the clients point at the new path. Keep the collection outside your source repository.

Search is hybrid keyword/vector by default. Embeddings are computed locally with a quantized MiniLM model; nothing is sent to an embedding API. Website capture contacts the saved website; the first model setup contacts Hugging Face. Content retrieved through Codex or Claude enters that agent's context and follows its data handling settings. Saved pages are treated as untrusted data.

## Standalone CLI

Everything the agent does is also available directly, without an agent or an API key. To use `memlio` from any directory, link the checkout:

```sh
pnpm link --global
memlio doctor
```

The direct `node /absolute/path/to/memlio/dist/cli.js` form also works. In iTerm2, the shell's PATH must include your Node installation; installing the Codex desktop app alone does not provide these commands on PATH. The package is named `memlio` and remains private until release; there is no public `npm install -g memlio` yet.

```sh
memlio store "Try weekly screenshots of competitor pricing"
memlio store https://example.com/article --note "For my queue project"
memlio store /absolute/path/to/dashboard.png \
  --description "Dark dashboard with orange charts and a left sidebar"
printf '%s\n' 'A longer note from another command' | memlio store --stdin

memlio retrieve "competitor pricing"                 # Hybrid search by default
memlio retrieve "orange charts" --kind file --limit 5
memlio retrieve "queue project" --mode keyword
memlio get <item-id>
memlio status
memlio delete <item-id> --yes
```

Absolute paths, `./paths`, and `../paths` are recognized as files. For a bare filename, use `--kind file`. Use `--kind note` for literal text resembling a URL or path.

Saving normally completes capture and indexing before returning, but preserves originals first. Use `--defer` for an immediate save and run `memlio retry` later. There is no background daemon yet.

### Semantic search options

New collections enable local embeddings and hybrid search. `memlio init` downloads/prepares the model on first use; saving without initialization also loads the model when needed. To opt out of embeddings and model downloads, use `memlio init --keyword-only`; later `init` calls preserve that explicit preference. To re-enable it and cover previously saved items:

```sh
memlio init --semantic       # Re-enable after an explicit keyword-only opt-out
memlio reindex               # Adds embeddings to previously saved content
```

After the model is cached, `MEMLIO_OFFLINE=1 memlio retrieve "..."` works without network access; `MEMLIO_OFFLINE=1` also disables bookmark fetching. `MEMLIO_MODEL_CACHE` optionally selects a shared model cache.

### Backup and recovery

```sh
memlio export /path/to/new-backup-directory
memlio --home /path/to/restored-collection init
memlio --home /path/to/restored-collection import /path/to/new-backup-directory
memlio --home /path/to/restored-collection retry
```

Export includes original assets and JSON records, but not model files or derived embeddings. A fresh restored collection defaults to semantic mode, and `retry` generates its missing embeddings; an existing explicit keyword-only preference is preserved until `init --semantic` re-enables it. `reindex` rebuilds search tables from stored records; it cannot repair a lost primary database. Deleting an item does not erase older exports or perform forensic disk erasure.

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
