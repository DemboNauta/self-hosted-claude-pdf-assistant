# Docs for the next Claude Code session

Read in this order before touching code:

1. [`HANDOFF.md`](HANDOFF.md): where the work stopped, what to do next and how
   the owner likes to work. **Start here.**
2. [`../CLAUDE.md`](../CLAUDE.md): conventions (naming, language, commits, no API
   key). Mandatory.
3. [`DECISIONS.md`](DECISIONS.md): every product decision taken with the owner,
   plus the provisional ones Claude took. Don't reopen them without asking.
4. [`FEATURES.md`](FEATURES.md): status of every SPEC feature ID.
5. The reference you need for the task:
   - [`ARCHITECTURE.md`](ARCHITECTURE.md): code map, request flow, key modules.
   - [`CLAUDE_INTEGRATION.md`](CLAUDE_INTEGRATION.md): Agent SDK usage, prompts,
     MCP tools, citations, sessions, fake Claude for tests.
   - [`API.md`](API.md): REST endpoints and the `/ws/chat` protocol.
   - [`DATA_MODEL.md`](DATA_MODEL.md): tables, migrations, anchors, file layout
     under `DATA_DIR`.
   - [`DEVELOPMENT.md`](DEVELOPMENT.md): running, testing and debugging on the
     owner's Windows PC, plus gotchas.
   - [`DEPLOYMENT.md`](DEPLOYMENT.md): VPS deployment, what is done and what is
     left.

`SPEC.md` (repo root, Spanish) remains the source of truth for product scope.
At the end of a session, update `HANDOFF.md`, and `FEATURES.md` if the status of
any feature changed.
