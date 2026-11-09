# Symphony Machine

A personal, foreground workflow runner. The repository is public; the runtime and credentials are private.

- Keep the architecture single-process: TypeScript, Node 24+, SQLite, Codex app-server, Linear MCP, system git and gh.
- Never commit credentials, OAuth stores, local configuration, logs, databases, or worktrees. Never print tokens. Use existing Codex/gh login and supported MCP OAuth flows.
- Linear is the authority for requirements and human decisions. GitHub is the authority for PR/CI/merge facts. SQLite tracks execution and recovery, not a second requirements database.
- Poll external state with code; invoke agents only for meaningful work. Preserve user-configurable concurrency and foreground/tmux operation.
- Use execFile/spawn argument arrays, never interpolate issue content into shell commands.
- No bypass of branch protection. Merge only the reviewed head into the configured target. Cleanup only owned resources after verified merge, with no active agent or dirty worktree.
- Execution may not change requirements or silently grant human approval. Escalate through Linear. Automated maintenance must follow the configured policy.
- Keep implementations proportional to this single-user system. No speculative distributed queues, public API, multi-tenant auth, or product UI beyond the read-only dashboard.
- Keep the dashboard in the foreground runner's Node process. It has no workflow mutation routes, login or application authentication. Bind to loopback by default; LAN bind settings and Tailscale Serve belong to private local configuration.
- Dashboard columns reflect Linear state, separately from agent status. Show completion/blocked timestamps only from Linear evidence; unknown historical times stay unknown. Keep ticket projections in memory and use SQLite execution references for history, not a second requirements store.
- Render ticket titles and findings as text, accept only HTTP(S) links, and keep resume commands shell-quoted and copy-only. Use project tabs, desktop Kanban and vertically stacked phone sections; preserve maintenance history and session disclosures during polling.
- Never restart or interrupt a live runner merely to apply dashboard edits or publish source. Leave process lifecycle actions to explicit user authorization.
- Run npm run check and npm test for behavioral changes. Tests should cover requirements and actual regression risks, not mirror implementation.
- Use GPT-6.1 Sol with xhigh reasoning for delegated development when subagents are useful (user-authorized for this repository).
