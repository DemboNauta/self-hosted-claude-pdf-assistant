# PdfClaudeAsistant — working notes for Claude Code

Self-hosted study assistant: PDF viewer + Claude (via the owner's Claude
subscription through the Claude Agent SDK, never an API key) with annotations,
memory and spaced repetition. Single user.

## Conventions

- **Language:** UI text in Spanish; code, identifiers, comments, docs and
  commit messages in English.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`, `build:`, `ci:`…), optional scope, e.g.
  `feat(viewer): add thumbnail navigation`. Reference feature IDs from the spec
  (e.g. `F-VIS-01`) in the body when relevant.
- **No co-author or attribution trailers** in commits (no `Co-Authored-By`,
  no session links). Never list Claude as a co-author.
- **No Anthropic API usage:** never add `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `@anthropic-ai/sdk` or direct calls to
  `api.anthropic.com`. Claude is reached only through
  `@anthropic-ai/claude-agent-sdk` with the subscription session.
- Ask before implementing anything marked **[DECISIÓN ABIERTA]** in the spec.
- Work phase by phase; do not start a phase until the previous one meets its
  acceptance criteria.

## Status

- Spec received only up to section 8 (data model). Sections 9–15 (phases,
  open decisions, full conventions) are pending from the owner.
- Current phase: **not started** — waiting for the rest of the spec.
