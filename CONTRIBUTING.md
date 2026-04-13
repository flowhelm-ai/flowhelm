# Contributing to FlowHelm

Thank you for your interest in contributing to FlowHelm. This document covers how to contribute and the requirements for doing so.

## License and Contributor Terms

FlowHelm uses a source-available license based on MIT with additional conditions for commercial use. See [LICENSE](LICENSE) for the full text.

All contributors must sign the [Contributor License Agreement](CLA.md) before their first PR can be merged. A GitHub bot will prompt you automatically — just comment `I have read the CLA Document and I hereby sign the CLA` on your pull request. You only need to do this once.

## Code Contributions

### Before You Start

1. Check existing issues to see if your idea is already discussed
2. For significant features, open an issue first to discuss the approach
3. Read the relevant `docs/*.md` files for the area you're working on
4. Read the relevant `docs/*.md` files for context on design decisions

### Development Setup

```bash
git clone https://github.com/flowhelm-ai/flowhelm.git
cd flowhelm
npm install
npm run build
npm run test
```

### Pull Request Process

1. Create a feature branch from `main`
2. Write code following the project conventions
3. Add tests for new functionality
4. Run `npm run check` (typecheck + lint + test)
5. Commit with conventional commit messages (`feat:`, `fix:`, `sec:`, etc.)
6. Open a PR with a clear description of what and why
7. Sign the [CLA](CLA.md) when prompted by the bot (first PR only)

### Code Quality Standards

- TypeScript strict mode — no `any` types without documented justification
- All public functions must have JSDoc comments
- New features must include unit tests
- Integration tests for container and channel interactions
- Linting passes with zero warnings

## Security Contributions

If you discover a security vulnerability, **do NOT open a public issue**. Instead, email security@flowhelm.ai with details. We will respond within 48 hours and coordinate a fix before public disclosure.

## Documentation Contributions

Documentation improvements are welcome and don't require the full CLA process for typo fixes and minor corrections. For substantial documentation additions (new guides, architecture changes), the CLA applies.

## What We're Looking For

- Container runtime improvements (Podman patterns, security hardening)
- Channel adapter contributions (Discord, Slack, Signal)
- Voice pipeline providers (Deepgram, Azure Speech, local alternatives)
- Gmail pipeline enhancements (better filtering, attachment handling)
- Multi-tenant improvements (resource monitoring, alerting)
- Multi-model support (OpenAI, Gemini, local models)
- Web dashboard UI (admin panel, user management, monitoring)
- Test coverage improvements
- Documentation and guides

## What We're NOT Looking For

- Docker support (Podman is a deliberate architectural choice)
