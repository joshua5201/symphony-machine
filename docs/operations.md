# Operations

Start with the [README quick start](../README.md#quick-start). This guide covers setup variations and operating an existing installation. Settings live in the gitignored `symphony.yaml`; use the [annotated example](../symphony.example.yaml) as the configuration reference.

## Agent installation

The installer links `symphony-intake` and `symphony-execute` individually under `~/.agents/skills`, and `WORKFLOW.md` and `LINEAR-CONTRACT.md` under `~/.agents/workflows`. Parent directories must be real directories so unrelated skills can coexist. Reinstalling keeps correct links and refuses conflicting content; it checks all destinations before changing anything.

To inspect or install into a different home directory:

```sh
node scripts/install-agent-assets.mjs --dry-run /path/to/home
node scripts/install-agent-assets.mjs /path/to/home
```

On Windows, skill directories use junctions and Markdown files use symbolic links. Enable Developer Mode or run with symbolic-link privileges for those files. Installed links follow this checkout's contents, including branch changes. Start a fresh agent session to discover newly installed skills; the installer does not configure Codex, logins, plugins, or services.

### Migrating a linked .agents directory

If `~/.agents` or its `skills`/`workflows` parent is a whole-directory link (for example, into dotfiles), inspect the target and preserve unrelated assets before replacing the link with a real directory. Then rerun the installer. It refuses linked parents to avoid writing into another repository. Dotfiles is not a Symphony dependency.

## Tuning the runner

Polling, merge timing, per-repository concurrency, and maintenance settings reload while running. Invalid edits leave the previous configuration active. Repository, runtime, authentication-path, and dashboard bind changes require a restart. Lowering concurrency lets active jobs finish. Source changes take effect on the next start; editing or publishing source does not restart a running process.

| Setting                        | Default | Purpose                                               |
| ------------------------------ | ------- | ----------------------------------------------------- |
| `polling.linear_seconds`       | 120     | Todo, dependencies, and interrupted executions        |
| `polling.review_seconds`       | 180     | Review candidates                                     |
| `polling.github_seconds`       | 120     | PR, CI, merge, and cleanup tracking                   |
| `polling.master_ci_seconds`    | 300     | Target-branch CI                                      |
| `polling.dashboard_seconds`    | 300     | Dashboard's Linear snapshot                           |
| `merge.group_interval_minutes` | 30      | New merge group admission per repository              |
| `merge.cooldown_minutes`       | 5       | Observation after successful target CI for each merge |
| `maintenance.interval_hours`   | 24      | Maintenance scans                                     |

Each `repositories` entry has its own `concurrency` limits: 3 execution tickets, 1 combined review/merge-planning agent, and 1 maintenance scan by default. There is no global cap. Merge operations run serially per repository. Dependency waiting consumes no agent slot.

Scheduled merge groups contain the eligible PRs at admission time; later PRs wait for another group. After each merge, the runner waits for successful target CI and the observation window before continuing. Conflicts, required branch updates, failed checks, or missing current-head verification return work to the original Lead. Ready to merge does not bypass GitHub protections.

### Maintenance and CI repair

Maintenance starts when due, including first startup. By default it starts only when an execution slot is free and no review or merge is running in that repository. It investigates one theme per round, such as duplicate implementations or documentation drift, and creates bounded tickets under `maintenance.policy` and `maintenance.max_open_tickets`. Set `maintenance.enabled: false` to disable scans. Existing work is not interrupted when product work arrives; maintenance tickets use the normal execution pool behind product work.

A failed target-branch CI run pauses ordinary merges and creates a deduplicated `[CI repair]` ticket. Repair tickets take priority and still require review and passing candidate checks. Ordinary merges resume after successful target CI and observation. Missing CI evidence is unknown, never success; configure `required_workflows` to identify the workflows that establish target health.

## Dashboard access

The dashboard runs inside the foreground runner and closes with it. Its controls pause/resume Symphony-managed work; independent intake sessions remain available.

Keep actual bind settings in private local configuration:

```yaml
dashboard:
  enabled: true
  host: 127.0.0.1
  port: 4310
```

| Access       | Configuration                                      |
| ------------ | -------------------------------------------------- |
| This machine | Keep `host: 127.0.0.1`.                            |
| Direct LAN   | Set `host: 0.0.0.0` or a local interface address.  |
| Tailnet      | Keep loopback and forward it with Tailscale Serve. |

Anyone who can reach the listener can read ticket/session information and pause/resume work. There is no application authentication. Set `enabled: false` to disable the dashboard; bind changes apply on the next runner start.

For [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve):

```bash
tailscale serve --bg http://127.0.0.1:4310
```

Use the returned address. Tailscale is configured separately; keep personal addresses and domains out of tracked source.

### Reading the board and taking over a session

Each project has a tab. Columns reflect Linear state, separately from agent activity: a finished agent turn does not mean a ticket is Done. Todo shows all current project Todo tickets; other columns show tickets handled by Symphony or recorded as maintenance-created issues. Completion and Blocked timestamps come from Linear; unavailable historical times stay unknown. Maintenance findings and history appear below the board.

The visible browser normally refreshes local state every 30 seconds; Linear snapshots follow `polling.dashboard_seconds`, including while dispatch is paused. A failed snapshot retains the last successful data with a stale indicator. Transient failures back off automatically, so check the displayed timestamp when progress appears delayed.

Expand a ticket's session section to copy its `codex resume` command. Copying does not run it or interrupt an agent. Check agent status before taking over: do not drive an active thread from two clients. Plain LAN HTTP may require copying selected text manually instead of using the clipboard button.

## Troubleshooting and recovery

Run `npm start -- doctor --config symphony.yaml` after setup or connection changes. It checks Git/gh availability, repository paths, configured GitHub workflows, Codex ChatGPT login and Linear MCP availability, and controller Linear reads. It does not execute an agent task or prove GitHub write privileges; Git and gh must already have access to the configured remote.

| Symptom                            | What to check                                                                                                                                                     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linear authorization fails         | Authorize both clients using the [README commands](../README.md#3-authorize-linear), against the same workspace. A Desktop connection is not a runner credential. |
| Todo ticket is not picked up       | Check project/state mappings, dependencies, control labels, pause flags, capacity, and the polling interval.                                                      |
| Resolved Blocked ticket stays idle | Record the decision, remove `needs-human` when resolved, then return it to Todo or In Review as appropriate. Waiting alone does not resume it.                    |
| Ready PR is not merging            | Check `auto_merge`, pause flags, `no-auto-pickup`, merge timing, dependencies, current-head checks, target CI, and GitHub protections.                            |
| Merged ticket is not Done          | Check the Linear–GitHub integration and PR linkage. Symphony does not set Done.                                                                                   |
| A dependency remains waiting       | Check its Linear state and linked PR targets. Historical/superseded PR links can hold it; clarify obsolete links rather than guessing which PR counts.            |
| Cleanup keeps a worktree           | Check for active agents, dirty files, or local commits not contained in the merged PR. Resolve retained work before expecting cleanup.                            |

For execution/review recovery, use `status` to inspect recorded jobs and sessions, and `retry --issue TEAM-123` to return failed/blocked work to its queue. Retry does not remove control labels. `needs-human` holds automatic pickup only in In Review; Todo revisions and interrupted In Progress work can resume with it retained. Returning the updated work to In Review with that label waits for human review again. `no-auto-pickup` holds all statuses. See the [Linear contract](../agents/workflows/LINEAR-CONTRACT.md) for the full handoff rules.

Pause interrupts managed turns and keeps sessions/worktrees for resumption; already-issued external operations may finish settling. Global pause overrides per-repository flags, and resuming globally preserves individually paused repositories. CLI controls apply on the next runner poll; dashboard controls apply immediately.

On shutdown, first `Ctrl+C` drains work and a second interrupts it. After a crash or app-server exit, restart the same `run` command with the same data directory to reconcile saved work. Execution checkpoints reuse their thread/worktree; interrupted reviews are scheduled again. Cleanup failures do not repeat implementation or merging. Only one runner can use a data directory at a time; stale process locks are reclaimed on restart.

## Private runtime data

Runtime data defaults to `~/.local/state/symphony-machine`, including execution/recovery records, `events.jsonl`, and the controller's `linear-auth/linear-oauth.json`. Codex keeps its own normal authentication and conversation storage. Pending Linear updates survive restart; a crash can repeat a comment whose successful delivery had not yet been recorded.

Worktrees default to `<repository>/.symphony/worktrees/<issue>`, with `worktree_root` available as an override. Recovery preserves saved workspaces. Cleanup removes only owned resources after verified merge and preserves dirty worktrees or unmerged local work.

Keep credentials, OAuth stores, local configuration, logs, databases, worktrees, and screenshots of private runtime state out of Git. Use the same OS user and Codex session home if you want clients to discover runner conversations. Client conversation discovery does not guarantee concurrent control of an active turn.

## Development

```bash
npm run check
npm test
npm run build
```

Tests use fake external services, temporary Git repositories, real SQLite, and loopback MCP/OAuth interactions. They do not create Linear tickets or push/merge GitHub PRs. Restricted environments must allow loopback sockets for the integration tests.
