# Symphony Machine

A personal Linear → Codex → GitHub workflow runner. Runs in the foreground. No hosted service, Desktop dependency, GitHub merge queue, or API-key billing integration.

You handle intake, pending human decisions or reviews marked `needs-human`, and Blocked work. Complete required human review or acceptance by moving the issue to Ready to merge. The machine polls approved tickets, executes them in isolated Git worktrees, reviews PRs, merges them serially per repository, and removes merged worktrees and branches. It also diagnoses failing target-branch CI and periodically creates bounded maintenance tickets.

## Requirements

- Node.js 24+, npm, Git, GitHub CLI, and a current Codex CLI supporting `app-server` and automatic approval review. Protocol tested with Codex CLI 0.167.0.
- `codex login` with your ChatGPT account. Symphony uses Codex-managed OAuth; it never extracts or copies your ChatGPT tokens.
- `gh auth login` or your existing `GH_TOKEN` environment. Git fetch/push must work non-interactively. The configured remote must refer to the configured GitHub repository.
- The workflow and skills included in this repository, installed using the command below.
- A Linear project per managed repository, mapped workflow states including `ready_to_merge` (default `Ready to merge`), and `needs-human` and `no-auto-pickup` labels. Workspace labels can be shared across teams. Use team/project IDs when names are ambiguous.
- Target-branch CI and repository protections appropriate to autonomous merges, including requiring the PR branch to be up to date. The runner never uses `--admin` or bypasses branch protection.

The public repository contains no credentials, local configuration, database, sessions, or worktrees. Runtime data defaults to `~/.local/state/symphony-machine`; Codex uses its normal local session/auth storage.

## Install and configure

```bash
npm ci
npm run install:agents -- --dry-run
npm run install:agents
cp symphony.example.yaml symphony.yaml
```

The agent installer links each of `symphony-intake` and `symphony-execute` individually under `~/.agents/skills`. It also links `WORKFLOW.md` and `LINEAR-CONTRACT.md` individually under `~/.agents/workflows`. The parent directories remain real directories, so other skills and workflows can coexist. All destinations are checked before changes; repeat installation keeps correct links and refuses conflicting content.

The same Node script runs on macOS, Linux, and Windows, with an optional home-directory argument:

```sh
node scripts/install-agent-assets.mjs --dry-run /path/to/home
node scripts/install-agent-assets.mjs /path/to/home
```

On Windows, skill directories use junctions and Markdown files use symbolic links. Enable Windows Developer Mode or run with symbolic-link privileges for those file links. Keep the checkout at a stable path: installed links follow its current contents, including branch changes. The installer does not configure Codex, logins, plugins, or services. Installing the skills does not require starting the runner. Start a fresh agent session to discover newly installed skills.

For an existing installation where `~/.agents` is a whole-directory link into dotfiles, first inspect its target and preserve any unrelated assets, then replace that link with a real directory and run this installer. The installer refuses linked parent directories so it cannot write into the old repository. Dotfiles now manages only global agent instructions and its other environment helpers; it is not a Symphony dependency.

Edit the ignored `symphony.yaml`: repository path, GitHub owner/repo, target branch (`master` or `main`), Linear team/project IDs, actual state names, and required CI workflows. No token belongs in this file. Every configured project must map to exactly one repository. This version executes code tickets with a PR; it does not deliver non-code-only tickets. Lead performs any required dev/per-PR deployment within existing explicit authorization.

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

Failed repository polls, dashboard snapshots, and outbox synchronization use the [`retry`](https://github.com/tim-kos/node-retry) package for exponential backoff. The first failure waits two to four times the relevant polling interval, with randomized delays doubling on consecutive failures up to 15 minutes (or the configured interval if longer). Success resets the failure sequence; configuration reloads preserve active cooldowns. Deadlines start after the failed request completes and do not block the runner with sleeps. A repository cooldown also gates its dashboard reads. Failed outbox synchronization retains pending changes and gates automatic polling until the next sync attempt. Active agent completion and explicit shutdown synchronization keep their existing behavior.

```bash
npm start -- status --config symphony.yaml
npm start -- pause --repo all --config symphony.yaml
npm start -- resume --repo all --config symphony.yaml
npm start -- pause --repo my-project --config symphony.yaml
npm start -- retry --issue TEAM-123 --config symphony.yaml
```

Pause stops new dispatch/merge work for the selected scope and interrupts active execution, review, merge-planning and maintenance turns using Codex's native `turn/interrupt`. It keeps Node and app-server running, preserves sessions/worktrees, and leaves Linear ticket states unchanged. Child agents follow Codex's native interruption behavior. This ends the current turn rather than freezing it in place. Resume continues eligible work on the original threads after checking current Linear/GitHub facts. Already-issued external operations may finish settling. CLI changes take effect on the runner's next poll; dashboard controls apply immediately. Pause flags survive restart until explicitly resumed. Global pause overrides repository flags; resuming globally preserves individually paused repositories.

Retry returns an existing failed/blocked execution to Todo (or a review-only job to review); it does not remove `needs-human`. Resolve the human decision and remove that label explicitly when appropriate. Normal resumption is also possible by moving the ticket back to Todo in Linear.

Add `no-auto-pickup` to any issue you want to handle yourself. Symphony skips new execution, recovery of interrupted execution, review, merge planning and automatic merge for that issue in every status, including Ready to merge, CI repair and maintenance tickets. Active agents finish. Remove the label to restore normal processing according to the issue's state and dependencies; retry does not remove it. The label name is configurable with `linear.no_auto_pickup_label` and defaults to `no-auto-pickup`. `needs-human` marks a pending human decision or acceptance and stops automatic admission outside Ready to merge. Moving an issue to Ready to merge completes the human handoff even if `needs-human` remains on it.

## Dashboard

The foreground runner also serves a dashboard at `http://127.0.0.1:4310`. Each configured repository/project has its own tab. Desktop uses a compact Kanban board; narrow phone screens stack the same sections vertically. The header controls pause/resume all repositories, and each project has its own control. Status distinguishes running, pausing while active jobs settle, and paused. Global pause disables project controls until released. These controls affect only Symphony-managed work, so independent intake sessions remain available. There is no login or application authentication.

The board groups tickets into Todo, In Progress, In Review, Ready to merge, Blocked, Done, and other states when present. Todo includes every current project Todo ticket. Other columns include tickets with Symphony execution/review records or recorded maintenance-created issue IDs. Each ticket appears once, even when multiple agents have handled it.

Cards show:

- The Linear ticket link, title and Direct/Delegated routing label.
- Separate Linear and agent statuses: an agent finishing its turn does not make the ticket Done.
- A human-review badge when the configured `linear.needs_human_label` is present.
- A manual-handling badge showing the configured `linear.no_auto_pickup_label` when present.
- Completion time from Linear's `completedAt` and the most recent Blocked time from its status history. Missing historical times are shown as unknown, never inferred from a job's last update.
- An expandable command for resuming the recorded agent session.

The latest maintenance theme and findings appear below the board, with expandable history, including failed or interrupted rounds. Historical maintenance records without a recorded theme show a general maintenance theme. Old maintenance-created tickets without recorded issue IDs cannot be reconstructed from local history alone.

The browser refreshes local runner state 30 seconds after each successful response and pauses while the page is hidden. While paused jobs are settling, it refreshes every second until interruption completes. Failed requests back off through 60, 120, 240, 480, and 900 seconds; success resets the normal interval. Browser requests do not call Linear. The runner polls Todo and handled tickets separately at `polling.dashboard_seconds` (300 seconds by default), including while dispatch is paused. A failed snapshot stops further ticket reads for that round and retains the last successful snapshot with its timestamp and a stale indicator. Ticket details remain an in-memory read-only projection: Linear owns ticket state and labels; SQLite retains execution/recovery references. Viewing the dashboard does not dispatch an agent or modify Linear/GitHub. The only mutation endpoint, `POST /api/control`, accepts a repository ID (or `all`) and a boolean `paused` flag as JSON with the `X-Symphony-Control: 1` header; cross-site browser requests and CORS preflights are rejected.

### Manual session handoff

Expand a ticket's session section to copy its `codex resume` command. The command includes the configured repository directory and retained execution worktree when applicable. Copying never runs the command or interrupts an agent. If clipboard access is unavailable over plain LAN HTTP, the text is selected for manual copying.

Check the separate agent status before taking over; do not drive a currently active thread from both clients. Session IDs and local paths in these commands come from private runtime state, not committed configuration.

### Local access and configuration

Put actual bind settings in the gitignored `symphony.yaml`:

```yaml
dashboard:
  enabled: true
  host: 127.0.0.1
  port: 4310
```

| Access | Configuration |
| --- | --- |
| This machine | Keep `host: 127.0.0.1`. |
| Direct LAN | Set `host: 0.0.0.0` for all IPv4 interfaces, or use a local interface address in private configuration. |
| Tailnet | Keep the loopback default and forward it with Tailscale Serve. |

Anyone who can reach the listener can read the dashboard and pause/resume Symphony work. Set `enabled: false` to disable it. Bind changes and server code are loaded on the next runner start; editing or publishing source does not restart the running process. The listener closes with that process.

For [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve):

```bash
tailscale serve --bg http://127.0.0.1:4310
```

Use the address returned by Tailscale. Serve is configured separately; Symphony does not launch a Tailscale child process. Keep personal IPs, hostnames, tailnet domains, repository paths, project IDs and credentials out of tracked source/examples. Use local configuration and existing login stores; do not commit screenshots or runtime data.

## Default schedule and capacity

| Work                                                            | Default    |
| --------------------------------------------------------------- | ---------- |
| Todo/dependencies and interrupted executions                    | 120 seconds |
| Review candidates                                               | 180 seconds |
| PR/CI/merge/cleanup tracking                                    | 120 seconds |
| Target branch CI                                                | 300 seconds |
| Dashboard Linear snapshot                                      | 300 seconds |
| Visible dashboard browser refresh                              | 30 seconds |
| Maintenance scan                                                | 24 hours   |
| Concurrent execution tickets per repository                     | 3          |
| Concurrent review/merge-planning agents per repository combined | 1          |
| Concurrent maintenance scans per repository                     | 1          |
| Concurrent merge operations per repository                      | 1          |

Configure intervals under `polling` in `symphony.yaml`; existing explicit values override defaults.

Configure `concurrency.execution_tickets`, `concurrency.reviews` and `concurrency.maintenance_scans` inside each `repositories` entry. Each repository has its own limits, defaulting to 3/1/1. There is no global concurrency cap: work in one repository does not consume another repository's capacity. Review and merge-planning agents share their repository's review capacity. Repository concurrency changes reload without interrupting active jobs.

Polling is code, not an LLM turn. Unchanged completed reviews are not repeated. A maintenance round starts when due (including first startup), and by default only when an execution slot is free and no review or merge is running in that repository. Each round selects one direction in round-robin order: unnecessary abstractions, excessive defenses/fallbacks, duplicate implementations, incomplete replacements, redundant state, ineffective validation, and documentation drift. These are investigation hypotheses, not automatic reasons to refactor. Existing scan work is not interrupted when new product work arrives. Maintenance tickets use their repository's normal execution pool, behind product work; CI repair tickets come first.

Each repository/direction has its own successful commit checkpoint, retained in SQLite job history. Its first scan examines the current target snapshot for that direction; subsequent scans start from that direction's last successful commit and follow related context from the diff. The runner fetches and pins the target SHA before launching the agent. An unchanged SHA skips the agent and advances the rotation. Only a completed investigation advances the commit checkpoint; failed/incomplete rounds yield to the next direction without losing their unscanned range. Interrupted rounds resume the same direction, pinned commits and conversation. At the default interval, each direction gets a turn every seven days. Missing Git history or an incomplete investigation must be reported, not treated as a successful scan.

Maintenance chooses whether to delegate after a lightweight scope overview. Broad scans should use read-only subagents split by module or concern, all investigating the same direction and pinned commit range. Small, cohesive scans can run directly. Subagents return concise evidence and coverage reports; only the parent verifies/deduplicates findings and creates tickets. All assigned scopes must finish before the checkpoint advances. Delegation uses the configured maintenance model/reasoning (subject to explicit repository overrides) and the runtime's available concurrency; subagents do not delegate further. `maintenance_scans` limits coordinator-level rounds, not their internal subagent count. This is a prompt-level delegation policy and requires subagent tools in the Codex runtime.

Each execution invokes the bundled [`symphony-execute`](agents/skills/symphony-execute/SKILL.md) skill with its native app-server skill input, ticket, headless context, isolated worktree and configured Linear state mapping. The [Chinese workflow](agents/workflows/WORKFLOW.md) owns the development procedure.

Lead returns ordinary text, with no execution-specific JSON result format. The runner records the conversation, observes the latest Linear state and discovers the branch's PR for review/cleanup; it does not rewrite Lead's delivery state or add a duplicate delivery comment. The Code Reviewer, Merge planning and maintenance agents retain their structured results. Linked PR merges transition issues to Done through the existing Linear–GitHub automation; neither the runner nor its agents writes Done.

Sessions start at each configured repository root so their project context uses that repository, while ticket code changes and project checks run in an isolated worktree. Worktrees default to `<repository>/.symphony/worktrees/<issue>`; the runner locally excludes `.symphony/` from Git without changing the repository's tracked ignore rules. `worktree_root` can explicitly override the location. Existing saved workspaces are preserved on recovery. Codex clients control how existing conversations appear; changing the default does not rename or remove old project entries.

## Workflow and Linear interface

The [Linear interface contract](agents/workflows/LINEAR-CONTRACT.md) is the reference for required statuses, their meaning, control labels, dependency evidence and issue handoffs. Map its semantic state keys to the existing team states in local configuration.

The [workflow](agents/workflows/WORKFLOW.md) is the owner's maintained Chinese implementation. It defines roles, modes, models, planning, verification and delivery procedures. The two explicit entry skills are [intake](agents/skills/symphony-intake/SKILL.md) and [execute](agents/skills/symphony-execute/SKILL.md). Installing them does not implicitly activate Symphony for unrelated work. Repository `AGENTS.md` and `WORKFLOW-OVERRIDE.md` supply applicable project rules and explicit workflow overrides; issue-specific requirements and human decisions remain in Linear.

SQLite stores execution and recovery references, not a second requirements database. GitHub owns PR, CI and merge facts, including detailed review findings and their disposition. Linear holds requirements, human decisions, states, evidence links and concise handoffs. The runner's headless instructions adapt Linear tool access and hand work after In Review to an independent Code Reviewer, then Merge planning and the TypeScript coordinator, without granting additional deployment authority.

Agent turns use workspace-write sandboxing with command networking enabled and Codex's automatic approval reviewer. Operations still requiring a manual response stop with an actionable blocker; the runner never blindly approves incoming permission requests. These are personal trusted-repository agents, not a sandbox service for untrusted users.

## Dependencies and review

Dependency and status requirements are defined in the [Linear interface contract](agents/workflows/LINEAR-CONTRACT.md). Cross-repository dependencies must refer to configured repositories so their PR and target-branch facts can be verified.

The controller discovers PR links from attachments, descriptions, and comments, plus its own execution records. Historical or superseded PR links can hold a dependency; clarify/remove obsolete linkage rather than silently guessing which PR counts. Normal dependency waiting remains Todo and consumes no agent slot.

The normal path is Todo → In Progress → In Review → Ready to merge → Done. Lead owns implementation, ordinary self-checks and evidence for the current PR head, including required local checks, CI/CD and smoke tests. The formal Code Reviewer is independent of implementation even in Direct mode. Lead decides whether human code review is required under the [workflow's risk policy](agents/workflows/WORKFLOW.md#人類-code-review-政策), records why on the PR with a workpad link, and identifies what the owner must inspect. A missing assessment returns Todo for Lead to supply it. This is an explicit personal-project policy; required human approvals and GitHub protections still apply.

Authorized work defaults to independent agent review and required checks. The workflow's explicit human code-review triggers identify completed implementation for the owner to inspect, including physical-device acceptance when agents cannot perform it. Each request identifies the applicable clause, concrete impact, exact code/acceptance items, evidence and completion condition. Requirement, operation or budget approval does not complete required human code review or acceptance; completed review is reused only within its applicable version and scope. Technical and professional judgment belongs to agents. Ordinary CI/CD changes do not automatically require human review. Any unresolved human decision or missing authority goes to Blocked with `needs-human` and an escalation comment, including when discovered during code review. Existing approval covering the same decision or operation is reused.

The first independent review covers the full PR diff, approved requirements and directly affected context. Later rounds cover earlier findings, subsequent changes and their direct effects, including same-head Lead replies that change a finding's disposition. A timestamp change alone does not trigger another review. Unchanged issues missed in the first round do not become new blockers in later rounds. Review findings, Lead's fixes or reasoned rejections, and the review conclusion live on the GitHub PR. A rejection needs a concrete reason and evidence, and cannot waive approved requirements, required human approval or GitHub protections. Linear links to this discussion instead of copying a second detailed review.

Review produces one of:

- Ready to merge: the authoritative handoff that current-head verification and review are complete, blocking findings have an evidenced disposition, and required human gates are satisfied. The owner completes required human review or acceptance by moving the issue here; no separate SQLite merge-permission record is required.
- Needs changes: return Todo to the original Lead and continue the existing branch/PR, including fixable code, tests, CI/CD, smoke-test or evidence gaps.
- Needs human review or acceptance: completed work remains In Review with `needs-human` and a concrete request.
- Blocked: record an external prerequisite or an unresolved human decision at any stage, including code review; add `needs-human` when the owner must decide. Pending decisions do not remain In Review.

Normal pending CI stays in progress while Lead waits, polling with code every five minutes for up to 120 minutes per round. Pending alone is not a blocker or completed verification. The coordinator's polling schedule above is unchanged.

The Merge planning agent evaluates order, dependencies, overlapping changes and integration risk using the completed reviews. It does not repeat full code review, edit code, update or rebase branches, resolve conflicts, or merge. SQLite retains a candidate signature and order for recovery; it does not grant merge permission and candidates are not a frozen batch. The pure TypeScript coordinator rechecks live facts and serially merges an eligible PR with an expected-head check; it does not automatically update PR branches. It merges one PR, then waits for healthy target CI before the next merge.

A conflict, required branch update, failed PR CI, or missing verification for a changed head returns Todo to the original Lead with the reason and PR context. Returning implementation work from Ready to merge clears any stale `needs-human` label from the completed human handoff; a new unresolved human decision still requires it. Lead handles integration on the existing branch/PR and verifies the affected changes; pending CI does not trigger an immediate full review. Once evidence is complete, the PR returns to In Review for incremental review, then Ready to merge. The Ready status does not bypass current-head verification, dependencies, CI or GitHub protections. Missing/pending CI never counts as success. The current implementation conservatively requires all reported PR checks to pass, as well as branch-required checks.

## Target CI failure and cleanup

Target CI is evaluated for the current remote target SHA, using configured workflow names/paths. Without an explicit list, observed runs are considered, but absent evidence is always unknown. A failed target pauses ordinary merges and creates a deduplicated `[CI repair]` Todo ticket. A repair candidate can pass the merge gate only with passing candidate checks and a completed review. After each merge, the next merge waits for healthy target CI. CI repair tickets execute through the bundled skill and Lead-owned delivery process.

After a confirmed merge into the configured target, the controller removes its owned worktree, local branch, and remote branch. Cleanup does not depend on Linear's Done sync having arrived, and never sets Done itself. If a saved execution has no PR number yet, the runner discovers its branch's PR. It does not wait for target CI to turn green; later CI repairs get a fresh ticket/worktree. Cleanup:

- waits until no agent for that issue is active;
- verifies machine ownership and the configured merged target;
- preserves dirty worktrees and local commits not contained in the merged PR;
- uses the expected remote head to avoid deleting a subsequently changed branch;
- supports squash merge and an untouched local branch behind GitHub's update-branch commit;
- retries failures and comments once per distinct failure, retaining execution history.

CI repairs and maintenance tickets share the same execution/review/merge path. Maintenance's high-confidence gate requires concrete locations and a real cost or defect, investigation of the original design rationale, a bounded change preserving required behavior, and a specific verification plan. Model confidence percentages or generic best practices do not qualify. The maintenance agent evaluates this evidence and deduplicates against existing Linear work, including rejected/closed proposals; confidence, policy and the open-ticket cap are prompt-level requirements, not an independent programmatic proof. A zero-finding round is successful. An incomplete investigation or insufficient ticket capacity must not advance its checkpoint. This is a personal agent workflow, not an external enforcement service.

## Sessions, logs, and recovery

Codex manages persisted conversations, including Lead's native subagents. The runner saves its Lead, Review, merge-planning and maintenance thread IDs; historical Implementation IDs/reports remain available for recovery of older runs. Use `status` to find them. Runtime metadata is written to `events.jsonl`; raw tool output and authentication responses are not copied into that log.

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
