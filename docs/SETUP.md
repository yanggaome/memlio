# Setup and troubleshooting

## Installing Node

Memlio needs Node.js 22.13 or newer for its built-in SQLite. If you do not have Node, [nvm](https://github.com/nvm-sh/nvm) installs it in your home directory without sudo or a compiler:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
# open a new shell, then:
nvm install 24
npm install --global pnpm
```

Run `memlio setup` with the Node you want the agent to use. Setup records the absolute path of that Node executable and of the installed `memlio` package, so re-run setup after switching Node versions or reinstalling the package.

The Node bundled inside ChatGPT.app cannot load the ONNX runtime that pnpm extracts (unsigned binary). Use a separately installed Node.

## What `setup` does

`memlio setup claude`, `memlio setup codex`, or `memlio setup copilot`:

1. Adds an MCP server entry named `memlio` to `~/.claude.json`, `~/.codex/config.toml`, or `~/.copilot/mcp-config.json`, keeping every other setting and leaving one backup copy next to the file. Copilot CLI files follow `COPILOT_HOME` when it is set.
2. Installs the bundled skill at `~/.claude/skills/memlio/SKILL.md`, `~/.agents/skills/memlio/SKILL.md`, or `~/.copilot/skills/memlio/SKILL.md`.
3. Downloads the embedding model into the collection directory if it is not there yet. If the download fails, setup still succeeds; keyword search works, and the model is fetched on the first use with network access.

Add `--dry-run` to see the paths without writing anything. Setup refuses to overwrite a `memlio` server or skill it did not create.

After a restart, `claude mcp list` should show `memlio` as connected and `/memlio` appears as a skill. In Copilot CLI, `copilot mcp list` and `copilot skill list` show `memlio`. Copilot also reads `~/.agents/skills`, so after `memlio setup codex` it sees the Codex copy too; when both exist, the `~/.copilot/skills` copy takes precedence and only one `memlio` skill is listed.

## Letting the agent save files

The MCP server only reads files inside folders you allow, or inside the filesystem roots the client reports:

```sh
memlio setup claude --allow-path ~/Screenshots ~/Downloads
```

The terminal `memlio store /path/to/file` command needs no allowance; naming the file is the permission. Configuration changes take effect when the agent restarts the server.

## Where the data lives

```text
~/.local/share/memlio/
  config.json      allowed folders
  memory.sqlite    records, keyword index, embeddings
  assets/          copies of saved files, named by content hash
  models/          the cached embedding model
```

Override the location with `--home <dir>` or `MEMLIO_HOME`, then re-run setup so the agents point at it. Keep it outside any source repository.

## Environment variables

| Variable             | Effect                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `MEMLIO_HOME`        | Collection directory.                                                                                 |
| `MEMLIO_MODEL_CACHE` | Shared model cache directory instead of `<home>/models`.                                              |
| `MEMLIO_OFFLINE=1`   | Never download the model and never fetch pages. Search falls back to keywords if the model is absent. |

## Backup and restore

```sh
memlio export /path/to/new-backup-directory
memlio --home /path/to/restored import /path/to/new-backup-directory
```

Export writes `records.json` and copies of the original files. Import restores them, rebuilds the keyword index, and computes embeddings if the model is available. Embeddings and the model itself are not part of the export; `memlio repair` recreates anything missing.

## Common problems

- **`Semantic search unavailable: The local embedding model is not downloaded`** appears as a warning on search. Run any command with network access, or `memlio repair`, and the model downloads.
- **A bookmark shows `Page capture failed: The site blocked automated capture`**. The site uses a bot challenge; the bookmark is saved. Add a note describing the page, or paste its text as a separate note.
- **`memlio` is not found in the terminal**. The shell's PATH must include your Node installation's global `bin` directory (`npm prefix -g`). From a source checkout, use `node /path/to/memlio/dist/cli.js` or `pnpm link --global`.
- **The agent says the memlio tools are unavailable**. Run `memlio setup <client>` again and restart the agent.
