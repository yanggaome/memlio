# mem

A proposed lightweight personal memory tool for Codex, Claude Code, and the terminal.

Save bookmarks, notes, and pictures with minimal effort. Find the original later by describing what you vaguely remember.

**Status: planning.** There is no implementation yet. Commands below describe the intended interface.

```text
# Claude Code
/mem store https://example.com/article
/mem store Idea: track competitor pricing with screenshots
/mem retrieve that article about reliable background jobs

# Codex
$mem store ...
$mem retrieve ...

# Terminal
mem store "An idea to revisit"
mem store /absolute/path/to/image.png
mem retrieve "the dark dashboard with orange charts"
```

The same personal collection should work across projects, sessions, and both agents on one machine.

Read [PLAN.md](PLAN.md) for the product proposal, existing-project research, architecture, implementation milestones, and acceptance criteria.

## Initial direction

- A standalone CLI, an MCP server, and small agent-specific skills.
- Preserve original content and the user's reason for saving it.
- Keep data local by default and independent of the search engine.
- Prototype QMD as a replaceable search component before committing to it.
- Start with explicit capture and retrieval; add device sync and a browser extension later.

## Repository scope

This repository contains the software design and, eventually, its implementation. Personal memory collections, credentials, downloaded models, and private evaluation data belong outside the repository.
