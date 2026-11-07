# Symphony Machine

A personal Linear → Codex → GitHub workflow runner. Runs in the foreground. No hosted service, Desktop dependency, GitHub merge queue, or API-key billing integration.

You handle intake, issues marked `needs-human`, and Blocked work. The machine polls approved tickets, executes them in isolated Git worktrees, reviews PRs, merges them serially per repository, and removes merged worktrees and branches. It also diagnoses failing target-branch CI and periodically creates bounded maintenance tickets.

## Requirements

- Node.js 24+, npm, Git, GitHub CLI, and a current Codex CLI supporting `app-server` and automatic approval review. Protocol tested with Codex CLI 0.167.0.
- `codex login` with your ChatGPT account. Symphony uses Codex-managed OAuth; it never extracts or copies your ChatGPT tokens.
- `gh auth login` or your existing `GH_TOKEN` environment. Git fetch/push must work non-interactively. The configured remote must refer to the configured GitHub repository.
- Your Symphony workflow at `~/.agents/workflows/WORKFLOW.md`, or a configured alternate path.
- A Linear project per managed repository, existing workflow states and a `needs-human` label. Use team/project IDs when names are ambiguous.
- Target-branch CI and repository protections appropriate to autonomous merges, including requiring the PR branch to be up to date. The runner never uses `--admin` or bypasses branch protection.

The public repository contains no credentials, local configuration, database, sessions, or worktrees. Runtime data defaults to `~/.local/state/symphony-machine`; Codex uses its normal local session/auth storage.

## Install and configure

```bash
npm ci
cp symphony.example.yaml symphony.yaml
```

Edit the ignored `symphony.yaml`: repository path, GitHub owner/repo, target branch (`master` or `main`), Linear team/project IDs, actual state names, and required CI workflows. No token belongs in this file. Every configured project must map to exactly one repository. This version executes code tickets with a PR; it does not publish non-code-only tickets or deployments.

There are two independent Linear MCP clients:

1. The controller uses the official MCP SDK for deterministic polling and status changes.
2. Codex agents use Codex's MCP configuration for reading contracts, workpads, and discussions.

Authorize both against the same Linear workspace:

```bash
# Codex's own MCP registration and OAuth (skip add if already configured).
codex mcp add linear --url https://mcp.linear.app/mcp
codex mcp login linear

# Controller OAuth: prints a URL; open it on this computer and complete consent.
npm start -- linear-login --config symphony.yaml
```

The controller stores its own OAuth registration/refresh token in a private `linear-auth/linear-oauth.json` (directory mode 700, file mode 600). It does not read Desktop or Codex credentials. A connection available in a Desktop chat is not automatically a standalone controller credential. The login callback listens only on loopback and closes after login.

```bash
npm start -- doctor --config symphony.yaml
```

Doctor checks installed git/gh, repository paths, workflow availability, Codex ChatGPT login, agent MCP availability, and a controller Linear read. It does not execute an agent task or test GitHub write privileges. `gh` and Git must already have access to each configured remote.

## Run

```bash
npm start -- run --config symphony.yaml
```

The process owns an independent `codex app-server --listen stdio://` child. No daemon or system service is installed.

- First `Ctrl+C`: stop admitting new jobs and drain active jobs.
- Second `Ctrl+C`: interrupt active turns, preserve worktrees and save continuation information.
- Restart the same command to reconcile and resume interrupted jobs.
- One runner may use a data directory at a time; a stale process lock is reclaimed on restart.

Polling intervals, concurrency, and maintenance settings reload while running. Invalid edits leave the previous configuration active. Repository/runtime/auth-path changes require restart. Lowering concurrency never kills an active job.

```bash
npm start -- status --config symphony.yaml
npm start -- pause --repo all --config symphony.yaml
npm start -- resume --repo all --config symphony.yaml
npm start -- pause --repo my-project --config symphony.yaml
npm start -- retry --issue TEAM-123 --config symphony.yaml
```

Pause stops new dispatch/merge work for the selected scope; active agents finish. Retry returns an existing failed/blocked execution to Todo (or a review-only job to review); it does not remove `needs-human`. Resolve the human decision and remove that label explicitly when appropriate. Normal resumption is also possible by moving the ticket back to Todo in Linear.

## Default schedule and capacity

| Work                                             | Default    |
| ------------------------------------------------ | ---------- |
| Todo/dependencies and interrupted executions     | 30 seconds |
| Review candidates                                | 60 seconds |
| PR/CI/merge/cleanup tracking                     | 30 seconds |
| Target branch CI                                 | 60 seconds |
| Maintenance scan                                 | 24 hours   |
| Concurrent execution tickets                     | 3          |
| Concurrent review/merge-planning agents combined | 1          |
| Concurrent maintenance scans                     | 1          |
| Concurrent merge operations per repository       | 1          |

Polling is code, not an LLM turn. Unchanged completed reviews are not repeated. A maintenance scan starts when due (including first startup), and by default only when an execution slot is free and no review is running. Existing scan work is not interrupted when new product work arrives. Maintenance tickets use the normal execution pool, behind product work; CI repair tickets come first.

Delegated execution uses a Lead plan turn, a separate Implementation thread, then resumes Lead for verification/publication. Lead waits while Implementation runs, so there is one active model turn per execution ticket. Direct mode uses only Lead. Models/reasoning are configurable; ticket label overrides use the existing `Lead model/…`, `Lead reasoning/…`, `Implementation model/…`, `Implementation reasoning/…`, and `Symphony mode/Direct` names. Unsupported settings fail visibly rather than silently changing models.

## Workflow and ownership

| Source     | Authority                                                                              |
| ---------- | -------------------------------------------------------------------------------------- |
| Linear     | Requirements, states, dependencies, human decisions, workpad                           |
| Git/GitHub | Commits, PR state, CI, confirmed merges                                                |
| SQLite     | Agent runs, thread IDs, worktrees, review decisions, recovery, pending synchronization |

The configured shared workflow, repository AGENTS.md, and WORKFLOW-OVERRIDE.md are read by agents. Explicit runtime instructions extend the older interactive Symphony workflow:

- Official Linear MCP is permitted in headless sessions; Desktop-only plugin availability is not required.
- Todo is authorized for execution. Missing product decisions become Blocked.
- Review is autonomous unless the ticket or repository explicitly requires a human decision/acceptance.
- Agents may commit, push, and publish PRs. Only the controller merges and cleans up.
- Agents maintain workpads/findings; the controller owns states and `needs-human` labels.
- Maintenance intake may create Todo work within its configured policy; other proposals stay Backlog.
- No automatic deployment or revert is granted.

Agent turns use workspace-write sandboxing with command networking enabled and Codex's automatic approval reviewer. Operations still requiring a manual response stop with an actionable blocker; the runner never blindly approves incoming permission requests. These are personal trusted-repository agents, not a sandbox service for untrusted users.

## Dependencies and review

A blocked-by issue must be Done and its linked PRs must actually be merged into the configured target branch. Closed/canceled PRs do not satisfy dependencies. Cross-repository dependencies work only when the other repository is configured. A Done dependency with no discoverable PR is not assumed merged: explicitly document `[No PR required]` in its description for a genuinely non-code deliverable.

The controller discovers PR links from attachments, descriptions, and comments, plus its own execution records. Historical or superseded PR links can hold a dependency; clarify/remove obsolete linkage rather than silently guessing which PR counts. Normal dependency waiting remains Todo and consumes no agent slot.

Review produces one of:

- Ready to merge, with evidence tied to the PR head and review snapshots.
- Needs changes: return Todo and continue the existing branch/PR.
- Needs human: remain In review, add `needs-human`, and write the concrete question.
- Blocked: record missing external prerequisites or authority.

A separate merge-planning turn selects candidates and order. New commits or changed review metadata invalidate approval. The controller then serially updates a PR against the latest target, waits for CI and renewed review if the head changed, rechecks target health, and merges with an expected-head check. A conflict or failed PR CI returns the issue to Todo with the reason. Missing/pending CI never counts as success. The current implementation conservatively requires all reported PR checks to pass, as well as branch-required checks.

## Target CI failure and cleanup

Target CI is evaluated for the current remote target SHA, using configured workflow names/paths. Without an explicit list, observed runs are considered, but absent evidence is always unknown. A failed target pauses ordinary merges and creates a deduplicated `[CI repair]` Todo ticket. A repair candidate can pass the merge gate only with passing candidate checks and a completed review. After each merge, the next merge waits for healthy target CI. If a CI-only incident is resolved by a justified retry or external recovery, Lead may complete it without a PR only after the controller independently confirms healthy target CI; its diagnostic worktree is retained.

After confirmed merge, the controller removes its owned worktree, local branch, and remote branch. It does not wait for target CI to turn green; later CI repairs get a fresh ticket/worktree. Cleanup:

- waits until no agent for that issue is active;
- verifies machine ownership and the configured merged target;
- preserves dirty worktrees and local commits not contained in the merged PR;
- uses the expected remote head to avoid deleting a subsequently changed branch;
- supports squash merge and an untouched local branch behind GitHub's update-branch commit;
- retries failures and comments once per distinct failure, retaining execution history.

CI repairs and maintenance tickets share the same execution/review/merge path. Repeated scan findings are deduplicated by the maintenance agent against existing Linear work; its policy and open-ticket cap are explicit in the prompt. This is a personal agent workflow, not an external enforcement service.

## Sessions, logs, and recovery

Codex manages persisted conversations. The runner saves thread IDs for Lead, Implementation, Review, merge planning and maintenance. Use `status` to find them. Runtime metadata is written to `events.jsonl`; raw tool output and authentication responses are not copied into that log.

Tested on the development machine: an independent app-server thread with the project root as `cwd` automatically appeared in the existing Desktop project, and Desktop could read its completed messages. It did not need to attach to Desktop's app-server. This demonstrates conversation discovery, not guaranteed concurrent control of a turn owned by another process. Do not drive the same active thread from both clients. Worktree grouping and mobile behavior are client behavior and are not prerequisites for the runner.

Ordinary `codex exec` sessions can be filtered out of the Desktop list even though their persisted history is readable. The runner uses app-server threads, not `codex exec` jobs. Keep the same OS user and Codex session home if you want Desktop to discover them; do not put `CODEX_HOME` in this public repository.

SQLite queues pending Linear updates across restarts. A crash between a successful comment and recording its completion may repeat that comment; state changes and GitHub facts are reconciled, not assumed. If app-server exits or its protocol becomes unavailable, the runner exits and preserves affected runs for restart instead of marking the remaining Todo queue failed. Active execution checkpoints resume their existing thread/worktree. Reviews interrupted by a crash are scheduled again. Cleanup failures do not repeat execution or merging.

## Development

```bash
npm run check
npm test
npm run build
```

Tests exercise the real JSON-RPC client against a fake child, real OAuth/HTTP MCP interactions on loopback, temporary Git repositories, and the scheduler with fake external services plus real SQLite. Tests do not create Linear tickets or push/merge GitHub PRs. Restricted environments must allow loopback sockets for the MCP integration tests.
