# Symphony Machine

A personal, foreground workflow runner. The repository is public; the runtime and credentials are private.

- Keep the architecture single-process: TypeScript, Node 24+, SQLite, Codex app-server, Linear MCP, system git and gh.
- Never commit credentials, OAuth stores, local configuration, logs, databases, or worktrees. Never print tokens. Use existing Codex/gh login and supported MCP OAuth flows.
- Linear is the authority for requirements and human decisions. GitHub is the authority for PR/CI/merge facts. SQLite tracks execution and recovery, not a second requirements database.
- Poll external state with code; invoke agents only for meaningful work. Preserve user-configurable concurrency and foreground/tmux operation.
- Use execFile/spawn argument arrays, never interpolate issue content into shell commands.
- No bypass of branch protection. Merge only the reviewed head into the configured target. Cleanup only owned resources after verified merge, with no active agent or dirty worktree.
- Execution may not change requirements or silently grant human approval. Escalate through Linear. Automated maintenance must follow the configured policy.
- Keep implementations proportional to this single-user system. No speculative distributed queues, public API, multi-tenant auth, or product UI.
- Run npm run check and npm test for behavioral changes. Tests should cover requirements and actual regression risks, not mirror implementation.
- Use GPT-6.1 Sol with xhigh reasoning for delegated development when subagents are useful (user-authorized for this repository).
