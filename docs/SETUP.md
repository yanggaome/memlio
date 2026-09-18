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

Override the location with `--home <dir>` or `MEMLIO_HOME`. The directory is chosen when a command starts: the flag wins, then the variable, then the default above. `memlio setup` writes the directory in use into the agent's MCP registration, so the agent keeps using that collection until setup is run again. Keep it outside any source repository.

## Environment variables

| Variable             | Effect                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `MEMLIO_HOME`        | Collection directory.                                                                                 |
| `MEMLIO_MODEL_CACHE` | Shared model cache directory instead of `<home>/models`.                                              |
| `MEMLIO_OFFLINE=1`   | Never download the model and never fetch pages. Search falls back to keywords if the model is absent. |

## Backup, restore, and moving to another device

Export copies the collection to a new directory. Import merges an export into a collection.

```sh
memlio export ~/memlio-backup
memlio import ~/memlio-backup
```

Export writes `records.json` and copies of the original files under `assets/`. The destination must not exist yet and must be outside the collection. Nothing in the export depends on the machine it came from, so the directory can be copied anywhere.

Import adds every record whose content is not already present, reports how many were imported and how many were duplicates, rebuilds the keyword index, and computes embeddings if the model is available. Importing the same export twice is safe. Embeddings and the model itself are not part of the export; `memlio repair` recreates anything missing.

To move to another device, run `memlio export` on the old one, copy the directory across, install memlio on the new one, run `memlio import` there, then `memlio setup <client>` as usual. On a fresh machine the default collection is empty, so the import becomes the whole collection and the agent finds it with no extra flags.

To restore into a separate collection instead of merging, give import a different home:

```sh
memlio --home ~/memlio-restored import ~/memlio-backup
```

The agent does not follow this automatically: its registration still points at the collection that was in use when setup last ran. Re-run setup with the same `--home` and restart the agent to switch it, and pass `--home` (or set `MEMLIO_HOME`) on terminal commands too.

```sh
memlio --home ~/memlio-restored setup claude
```

## Common problems

- **`Semantic search unavailable: The local embedding model is not downloaded`** appears as a warning on search. Run any command with network access, or `memlio repair`, and the model downloads.
- **A bookmark shows `Page capture failed: The site blocked automated capture`**. The site uses a bot challenge; the bookmark is saved. Add a note describing the page, or paste its text as a separate note.
- **`memlio` is not found in the terminal**. The shell's PATH must include your Node installation's global `bin` directory (`npm prefix -g`). From a source checkout, use `node /path/to/memlio/dist/cli.js` or `pnpm link --global`.
- **The agent says the memlio tools are unavailable**. Run `memlio setup <client>` again and restart the agent.
