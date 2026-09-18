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

`memlio setup chrome` registers a native messaging host instead of an MCP server; see [Chrome extension](#chrome-extension) below.

After a restart, `claude mcp list` should show `memlio` as connected and `/memlio` appears as a skill. In Copilot CLI, `copilot mcp list` and `copilot skill list` show `memlio`. Copilot also reads `~/.agents/skills`, so after `memlio setup codex` it sees the Codex copy too; when both exist, the `~/.copilot/skills` copy takes precedence and only one `memlio` skill is listed.

## Letting the agent save files

The MCP server only reads files inside folders you allow, or inside the filesystem roots the client reports:

```sh
memlio setup claude --allow-path ~/Screenshots ~/Downloads
```

The terminal `memlio store /path/to/file` command needs no allowance; naming the file is the permission. Configuration changes take effect when the agent restarts the server.

## Chrome extension

The extension saves the tab you are looking at, as rendered in your signed-in browser, into the same collection the agents use. It has no storage of its own: Chrome starts a small memlio program on demand and passes it the page over a pipe. This is Chrome's native messaging mechanism, and it is the only way an extension can reach a program on your machine.

```sh
memlio setup chrome
```

Setup writes two files:

1. A launcher script at `<collection>/chrome-host.sh` that starts `memlio chrome-host` with the Node executable, package, and collection directory in use at setup time. Re-run setup after switching Node versions or moving the collection.
2. A host manifest named `com.memlio.host.json` in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` (macOS) or `~/.config/google-chrome/NativeMessagingHosts` (Linux). It points at the launcher and lists the extension ID that may call it.

Then load the extension:

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Choose **Load unpacked** and pick the `extension` folder that setup printed. From a checkout it is `extension/` in the repository; from a global install it is inside the installed package.
3. Check the ID Chrome shows against the one setup printed. They match unless the manifest was edited. If they differ, run `memlio setup chrome --extension-id <id>`.

Click the toolbar button, or press Alt+Shift+M, on any web page. The popup shows how many items the collection holds when the host is reachable. Add a note, optionally tick the screenshot box, and save. The reply names the saved ID. If the same page was already saved with the same note, for example from an agent whose fetch was blocked, the existing item is completed with the page text and screenshot instead of being duplicated. Chrome's internal pages and the Web Store cannot be captured.

The extension asks for three permissions: `activeTab` (the page you invoked it on), `scripting` (to read that page's text), and `nativeMessaging` (to reach the host). It never reads other tabs and sends nothing anywhere but the local host.

Windows is not supported yet; the host manifest lives in the registry there.

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
- **The extension popup says the host is not registered**. Run `memlio setup chrome`, then reload the extension on `chrome://extensions`.
- **The extension popup says this extension ID is not allowed**. Chrome loaded the extension under a different ID than the manifest key implies. Run `memlio setup chrome --extension-id <id>` with the ID shown on `chrome://extensions`.
- **The extension popup says the host exited early**. Run the launcher from a terminal to see the error: `~/.local/share/memlio/chrome-host.sh` prints it and waits for input (press Ctrl+C). The usual cause is a Node path that no longer exists; re-run `memlio setup chrome`.
