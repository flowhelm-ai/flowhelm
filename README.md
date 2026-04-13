# FlowHelm

**Your AI agent, your helm.**

FlowHelm is a secure, multi-tenant AI agent orchestrator. Run personal AI agents for yourself or your whole team on a single server. Each user gets their own isolated, extensible agent — with built-in channels (Telegram, WhatsApp, Gmail, Calendar, voice) and a skills system for adding new capabilities, integrations, and workflows.

## What Makes FlowHelm Different

**Extensible agent platform.** FlowHelm ships with built-in channels and skills, but it's designed to grow. Anyone can build custom skills, channel adapters, and tool integrations — install what you need, remove what you don't. Your agent does what you tell it to.

**Podman rootless, not Docker.** No root daemon. No shared process. Each user's containers run in separate UID namespaces — one user literally cannot see another's containers. Compliant-ready for PCI-DSS, SOC 2, and HIPAA.

**Per-user credential proxy.** API keys never enter agent containers. A dedicated proxy container holds credentials and injects them at the network layer. Prompt injection can't extract what the agent doesn't have.

**Multi-tenant by design.** `flowhelm admin add-user` provisions an isolated agent in 60 seconds. Resource limits enforced via cgroups v2. Not a bolt-on — built from day one.

**Gmail Pub/Sub streaming pull.** Real-time email notifications in 2-3 seconds. No exposed ports, no webhooks, no tunnels.

**Voice commands.** Send voice notes on Telegram or WhatsApp. FlowHelm transcribes and executes.

## Quick Start

```bash
# On a fresh Ubuntu 24.04 VM
curl -fsSL https://flowhelm.ai/install.sh | bash
flowhelm admin init
flowhelm admin add-user yourname
ssh flowhelm-yourname@localhost
flowhelm setup
```

## Requirements

**Linux (production):** Ubuntu 24.04 LTS, 4 GB RAM minimum, Podman 4.0+, Node.js 22+
**macOS (development):** Apple Silicon M1+, macOS Tahoe (26), 8 GB RAM minimum

## Documentation

- [Architecture](docs/architecture.md) — System overview, component responsibilities, data flow
- [Installation](docs/installation.md) — Install script, admin commands, user setup wizard
- [Deployment](docs/deployment.md) — Always-on operation, crash recovery, backups
- [Security Model](docs/security-model.md) — Isolation boundaries, threat model, compliance
- [Podman Isolation](docs/podman-isolation.md) — Rootless containers, UID namespaces, SELinux
- [Credential Proxy](docs/credential-proxy.md) — Per-user MITM proxy, credential injection
- [Multi-Tenant](docs/multi-tenant.md) — User lifecycle, resource limits, port allocation
- [Database](docs/database.md) — PostgreSQL schema, message queue, crash recovery
- [Memory](docs/memory.md) — Cognitive memory system, embeddings, identity layer
- [Sessions](docs/sessions.md) — Warm container lifecycle, PG backup/restore
- [Agent Runtime](docs/claude-integration.md) — CLI and SDK runtimes, token optimization
- [Channels](docs/channels.md) — Telegram, WhatsApp, Gmail adapters
- [Channel Container](docs/channel-container.md) — Unified channel container, HTTP API
- [Gmail Pipeline](docs/gmail-pipeline.md) — Pub/Sub streaming, IMAP, email filtering
- [Voice Pipeline](docs/voice-pipeline.md) — Service container, whisper.cpp transcription
- [Auth Bridge](docs/auth-bridge.md) — Headless OAuth, QR code auth flow
- [Skills](docs/skills.md) — SKILL.md format, registry, per-user store

## License

FlowHelm uses a [source-available license](LICENSE) based on MIT.

**Free for personal use** — you may run FlowHelm with up to **2 managed users** at no cost. The admin account used for installation and configuration does not count toward this limit.

**Commercial license required** for deployments with 3 or more managed users, or for offering FlowHelm as a hosted service. Contact [license@flowhelm.ai](mailto:license@flowhelm.ai) for commercial licensing.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributors must sign a CLA.
