# Memlio

A personal memory for Claude Code and Codex. Save a bookmark, note, or picture from inside the agent; find it later, from any project or session, by describing what you remember.

Everything stays on your machine: SQLite records, copies of saved files, a keyword index, and a small local embedding model for natural-language search. No accounts, no cloud, no API keys. A `memlio` command line is included for scripting and backups.

**Status:** early release, MIT-licensed. Tested on macOS with Node 24.

## Install

Requires Node.js 22.13 or newer. See [docs/SETUP.md](docs/SETUP.md) if you need to install Node first.

```sh
npm install -g @yanggao7/memlio
memlio setup claude     # and/or: memlio setup codex
```

`setup` registers the MCP server and the `/memlio` skill with the agent and downloads the 23 MB embedding model once. Restart the agent afterward.

To run from a checkout instead: `pnpm install --frozen-lockfile && pnpm build`, then use `node dist/cli.js` in place of `memlio`.

## Use

From Claude Code (`/memlio`) or Codex (`$memlio`):

```text
/memlio store https://example.com/article why this page matters to me
/memlio store /absolute/path/to/dashboard.png dark dashboard with orange charts
/memlio store A thought I want to keep
/memlio find that article about background jobs
```

The first URL, path, or quoted text is what gets saved; the rest becomes your note. On `find`, the agent searches the shared collection, reads the likely matches, and answers with the original link or file plus excerpts. Weak or missing matches are reported as such.

The same collection from a terminal:

```sh
memlio store "Try weekly screenshots of competitor pricing"
memlio store https://example.com/article --note "For my queue project"
memlio find "competitor pricing"
memlio status
```

## Good to know

- **Bookmarks** are fetched once for a readable text snapshot. Login-only, JavaScript-only, and bot-protected pages cannot be captured; the bookmark is still saved and your note stays searchable.
- **Files** are copied, so deleting the original does not lose the memory. Text is extracted from `.txt`, `.md`, `.csv`, and `.json`. Images and PDFs rely on the description you give them; there is no OCR.
- **Saving files from the agent** needs permission: `memlio setup claude --allow-path ~/Screenshots`. The terminal command can save any file you name.
- **Saving the same thing twice** with the same note returns the existing item. A different note creates a second item.
- **Search** combines keyword and semantic matching. If the model is missing, search still works on keywords and says so.
- **Data** lives in `~/.local/share/memlio`. Back it up with `memlio export <new-dir>` and restore with `memlio import <dir>`. `memlio repair` retries failed captures and rebuilds the search index.

More detail: [setup and troubleshooting](docs/SETUP.md), [how storing and search work](docs/WORKFLOWS.md), [architecture decisions](docs/ARCHITECTURE.md), [validation results](docs/VALIDATION.md), and the [original plan](PLAN.md).

## Development

```sh
pnpm test                                        # builds, then runs the suite without the model
MEMLIO_MODEL_CACHE=~/.local/share/memlio/models pnpm test   # also runs the real-model test
pnpm check                                       # types and formatting
```

## License

[MIT](LICENSE).
