# Skills

## Overview

FlowHelm is an extensible agent platform. Skills extend what the agent can do — from composing emails to searching documents to automating workflows. A skill is a directory containing a `SKILL.md` file (agent instructions in Claude Code format) and optional supporting files. There are no skill categories or types — every skill uses the same format.

Users install skills via `flowhelm install <name>`. Skills are synced into agent containers at launch, where Claude Code auto-discovers them. Uninstalling is `flowhelm uninstall <name>`. See ADR-027.

## Two-Layer Architecture

Every service integration (Gmail, Telegram, WhatsApp, etc.) has two components:

| Layer | Lives in | Runs in | Purpose |
|---|---|---|---|
| Channel adapter | `src/channels/` (main repo) | Orchestrator process | Transport: receives/sends messages, always-on |
| Skill | `flowhelm-ai/flowhelm-skills/` | Agent container | Capability: teaches agent HOW to use the service |

The channel adapter is infrastructure (ADR-011: always-present, enabled by config). The skill is optional knowledge installed by the user. A user might enable the Gmail channel adapter (for email notifications) but choose not to install the `google-email` skill (because they don't want the agent composing emails). This separation gives users fine-grained control.

## SKILL.md Format

### Frontmatter

```yaml
---
name: google-email
description: Gmail — email etiquette, response formatting, and full API operations via the google_workspace MCP tool.
version: 1.0.0
requires:
  tools: [google_workspace]   # MCP tool dependencies
  channels: [gmail]           # Needs Gmail channel configured in FlowHelm
  skills: []                  # Skill dependencies (must be installed first)
  os: [linux, macos]          # OS restrictions (optional, default: all)
---
```

All frontmatter fields:

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | string | Unique skill identifier (lowercase, hyphens allowed) |
| `description` | Yes | string | One-line description. Claude Code uses this for skill discovery |
| `version` | Yes | string | Semver version (e.g., `1.0.0`) |
| `requires.tools` | No | string[] | MCP tools that must be available (e.g., `google_workspace`) |
| `requires.channels` | No | string[] | FlowHelm channels that must be configured |
| `requires.bins` | No | string[] | Binary dependencies (checked at install time) |
| `requires.env` | No | string[] | Environment variables required at runtime |
| `requires.skills` | No | string[] | Other skills that must be installed first |
| `requires.os` | No | string[] | OS restrictions (`linux`, `macos`). Default: all |

A skill with no `requires` block has no external dependencies and works everywhere.

### Body

The body contains agent instructions in markdown. This is loaded into Claude Code's context when the skill is invoked. Write instructions as if talking to the agent:

```markdown
---
name: data-analysis
description: Analyze CSV/JSON data files, generate statistics, and create visualizations.
version: 1.0.0
---

When the user asks you to analyze data, follow this process:

1. Read the data file using the Read tool
2. Identify column types (numeric, categorical, datetime)
3. Compute summary statistics
4. If visualization is requested, write a Python script using matplotlib
5. Present findings in a structured format

## Supported Formats
- CSV (with headers)
- JSON (array of objects)
- TSV

## Guidelines
- Always show row count and column summary first
- Flag missing values and outliers
- Use appropriate chart types (bar for categorical, line for time series)
```

## Skill Lifecycle

### Install

```
flowhelm install google-email
  -> Fetch registry.json from flowhelm-ai/flowhelm-skills
  -> Find "google-email" entry, download google-email/ directory
  -> Validate SKILL.md frontmatter (Zod schema)
  -> Check requires.skills dependencies (must be installed)
  -> Warn if requires.channels/bins/env not met (non-blocking)
  -> Copy to ~/.flowhelm/skills/google-email/
  -> Update ~/.flowhelm/skills/installed.json manifest
```

### Container Sync (on agent launch)

```
Container creation (WarmContainerRuntime.createWarmContainer):
  1. Read ~/.flowhelm/skills/installed.json
  2. Create staging directory: {dataDir}/skills-sync/{chatHash}/
  3. Copy each installed skill directory to staging
  4. Copy built-in skills (capabilities, status) from container image
  5. Bind-mount staging at /workspace/.claude/skills/ (read-only)
  6. Claude Code auto-discovers all skills on startup
```

### Discovery & Invocation

Claude Code discovers skills automatically from `/workspace/.claude/skills/`. Each subdirectory with a `SKILL.md` file becomes a `/skill-name` command. The skill's description field enables keyword matching — when a user's message relates to a skill's domain, Claude Code may suggest or invoke it.

Skills are lazy-loaded: only the matched skill's `SKILL.md` is read into context on invocation. Unmatched skills add zero token overhead. This is why `cliDisableSlashCommands` should remain `false` (default) when skills are installed — see ADR-026.

### Uninstall

```
flowhelm uninstall google-email
  -> Check no installed skills depend on this one (requires.skills)
  -> Remove ~/.flowhelm/skills/google-email/ directory
  -> Update ~/.flowhelm/skills/installed.json manifest
  -> Takes effect on next agent container launch
```

## Per-User Isolation

Each user's skills are stored in their own `~/.flowhelm/skills/` directory and synced only into their own agent containers. One user's skill installations have no effect on another user's agents. This is a natural consequence of FlowHelm's per-user container isolation — see docs/podman-isolation.md.

## Skill Store Layout

```
~/.flowhelm/skills/
├── installed.json            # Manifest: installed skills + metadata
├── google-email/             # Installed skill
│   └── SKILL.md
├── browser/
│   ├── SKILL.md
│   └── scripts/
│       └── browse.sh
└── data-analysis/
    └── SKILL.md
```

### installed.json

```json
[
  {
    "name": "google-email",
    "version": "1.0.0",
    "source": "registry",
    "installedAt": "2026-04-09T12:00:00Z",
    "requires": {
      "tools": ["google_workspace"],
      "channels": ["gmail"],
      "skills": [],
      "os": ["linux", "macos"]
    }
  }
]
```

## Built-In Skills

Two skills ship with the agent container image (`container-image/skills/`). These are always available regardless of user skill installations:

| Skill | Purpose |
|---|---|
| `capabilities` | Agent self-description — lists tools, channels, installed skills |
| `status` | System health report — memory stats, sessions, channel connectivity |

Built-in skills are copied into the container at `/workspace/.claude/skills/` alongside user-installed skills during container creation.

## Registry

Skills are distributed via the `flowhelm-ai/flowhelm-skills` GitHub repository. The registry index is a `registry.json` file at the repo root:

```json
{
  "version": 1,
  "skills": [
    {
      "name": "telegram",
      "description": "Telegram-specific message formatting, inline keyboards, media groups, polls, and chat actions.",
      "version": "1.0.0",
      "path": "skills/telegram",
      "sha256": "4c0eb5ef..."
    },
    {
      "name": "whatsapp",
      "description": "WhatsApp-specific message formatting, reactions, media handling, read receipts, and platform conventions.",
      "version": "1.0.0",
      "path": "skills/whatsapp",
      "sha256": "fda45e33..."
    },
    {
      "name": "voice",
      "description": "Voice message handling — transcription awareness, conversational tone, and audio-specific behavior.",
      "version": "1.0.0",
      "path": "skills/voice",
      "sha256": "a696ed5e..."
    },
    {
      "name": "browser",
      "description": "Web browsing — page fetching, content extraction, search, and web-based research workflows.",
      "version": "1.0.0",
      "path": "skills/browser",
      "sha256": "ea3042de..."
    },
    {
      "name": "google-email",
      "description": "Gmail — email etiquette, response formatting, and full API operations via the google_workspace MCP tool.",
      "version": "1.0.0",
      "path": "skills/google-email",
      "sha256": "935a83da..."
    },
    {
      "name": "google-calendar",
      "description": "Google Calendar API operations via the google_workspace MCP tool — events, agenda, scheduling, freebusy.",
      "version": "1.0.0",
      "path": "skills/google-calendar",
      "sha256": "f500de59..."
    },
    {
      "name": "google-contacts",
      "description": "Google Contacts (People API) operations via the google_workspace MCP tool — search, create, update, delete contacts.",
      "version": "1.0.0",
      "path": "skills/google-contacts",
      "sha256": "8db3b63a..."
    },
    {
      "name": "google-drive",
      "description": "Google Drive API operations via the google_workspace MCP tool — files, folders, sharing, upload, permissions.",
      "version": "1.0.0",
      "path": "skills/google-drive",
      "sha256": "c2088a8e..."
    },
    {
      "name": "google-tasks",
      "description": "Google Tasks API operations via the google_workspace MCP tool — task lists, tasks, due dates, completion.",
      "version": "1.0.0",
      "path": "skills/google-tasks",
      "sha256": "cb0668f3..."
    }
  ]
}
```

The `sha256` field is the SHA-256 hash of the `SKILL.md` file. When present, the client verifies integrity after download — a mismatched hash aborts installation. This is optional in Stage 1 but recommended for all published skills.

The CLI fetches `registry.json` via GitHub raw content (cached with TTL). Skill directories are downloaded via the GitHub API.

### Install Sources

`flowhelm install` supports three sources:

| Source | Example | Resolution |
|---|---|---|
| Registry (default) | `flowhelm install google-email` | Lookup in `registry.json` |
| Local directory | `flowhelm install ./my-skill/` | Copy from local path |
| Git URL | `flowhelm install https://github.com/user/my-skill.git` | Clone and extract |

### Registry Evolution

| Stage | Trigger | Implementation |
|---|---|---|
| Stage 1 (launch) | Default | GitHub repo with `registry.json`, `flowhelm install` fetches via GitHub API |
| Stage 2 (growth) | 50+ skills | Static index API, multiple sources |
| Stage 3 (scale) | 500+ skills | Full registry service (if warranted) |

The CLI abstraction (`flowhelm install <name>`) is stable across all stages.

## CLI Reference

```bash
# Install from registry
flowhelm install gmail

# Install from local directory
flowhelm install ./my-custom-skill/

# Install from Git URL
flowhelm install https://github.com/user/my-skill.git

# Uninstall (checks dependents)
flowhelm uninstall gmail

# List installed + built-in skills
flowhelm list

# Search the registry
flowhelm search gmail

# Show skill details
flowhelm info gmail

# Update all installed skills
flowhelm update

# Update a specific skill
flowhelm update gmail
```

## Chat-Based Administration

Users can manage skills entirely via their messaging app (Telegram, WhatsApp, etc.) without SSH access. The agent has MCP tools for skill administration:

| MCP Tool | Description |
|---|---|
| `install_skill` | Install a skill from the registry |
| `uninstall_skill` | Remove an installed skill |
| `list_skills` | List installed and available skills |
| `search_skills` | Search registry by keyword |

Example conversation:
```
User (Telegram): "I want to connect my Gmail"
Agent: calls install_skill("google-email") -> "Google Email skill installed."
Agent: calls update_config("channels.gmail.enabled", true) -> "Gmail channel enabled."
Agent: calls get_auth_url("google", ["gmail.readonly", "gmail.send"]) -> URL
Agent: "Please open this link to authorize Gmail: https://..."
```

See ADR-033.

## Developing Skills

### Template

```yaml
---
name: my-skill
description: One-line description of what this skill does.
version: 1.0.0
requires:
  channels: []
  bins: []
  env: []
  skills: []
---

[Agent instructions go here. Write as if you're briefing the agent.]
```

### Guidelines

1. **Keep instructions focused.** The body is loaded into context on invocation. Shorter is better.
2. **Declare all requirements.** If your skill needs a binary, env var, or channel, declare it in frontmatter. The installer warns users about unmet requirements.
3. **Use MCP tools.** Skills can reference MCP memory tools (`search_semantic`, `store_semantic`) for persistent state.
4. **Test with `flowhelm install ./path/`** to install from a local directory during development.
5. **Follow the naming convention.** Lowercase, hyphens for word separation: `data-analysis`, `web-scraper`, `code-review`.

### Contributing to the Registry

Skills are contributed via pull requests to `flowhelm-ai/flowhelm-skills`. See the [CONTRIBUTING guide](https://github.com/flowhelm-ai/flowhelm-skills/blob/main/CONTRIBUTING.md) for full details.

1. Create a directory under `skills/your-skill-name/`
2. Add `SKILL.md` with valid frontmatter
3. Add entry to `registry.json` with SHA-256 hash
4. Run `npx tsx scripts/validate.ts` to verify
5. Submit PR with description of what the skill does

## Design Alternatives Considered

| Dimension | Git-Merge Approach | FlowHelm |
|---|---|---|
| Skill types | Multiple categories (feature, utility, operational, container) | Single unified SKILL.md format |
| Install mechanism | Git merge into project (irreversible) | `flowhelm install` (reversible, per-user) |
| Removal | Manual file deletion | `flowhelm uninstall` (clean removal) |
| Channel relationship | Channels are skills (merged via git) | Channels are adapters + optional companion skills |
| Registry | None (separate repos per channel) | GitHub repo with `registry.json` |
| Multi-tenant | Impossible (fork model, single-user) | Per-user skill store + container sandbox |
| Dependency resolution | None | `requires.skills` + installer validation |
| Chat-based admin | No | MCP tools for install/uninstall via chat |

## Source Files

| File | Purpose |
|---|---|
| `src/skills/store.ts` | Per-user skill store (install, uninstall, list, dependency checks) |
| `src/skills/registry.ts` | Registry client (fetch, search, download from GitHub) |
| `src/config/schema.ts` | SKILL.md frontmatter Zod schema, installed manifest schema |
| `src/agent/warm-container-runtime.ts` | Container skill sync (copies skills to staging dir, bind-mounts) |
| `src/orchestrator/mcp-memory-server.ts` | Self-service MCP tools (install_skill, uninstall_skill, etc.) |
| `src/admin/cli.ts` | CLI commands (flowhelm install/uninstall/list/search/info/update) |
| `container-image/skills/` | Built-in skills (capabilities, status) |
| `tests/skills-store.test.ts` | SkillStore and registry tests |
| `tests/skills-cli.test.ts` | CLI command tests |
| `tests/mcp-admin-tools.test.ts` | Self-service MCP tool tests |
