# Symphony Machine

A personal Linear → Codex → GitHub workflow runner. You approve ticket scope and handle human decisions; the runner implements code changes in isolated worktrees, arranges independent review, and merges eligible PRs. It runs in your terminal and includes a local dashboard, CI repair, and periodic maintenance.

For the orchestration idea behind this project, see [OpenAI's introduction to Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/).

## Prerequisites

- Node.js 24+, npm, Git, GitHub CLI, and a current Codex CLI supporting `app-server` and automatic approval review (protocol tested with 0.167.0).
- A ChatGPT account for Codex and GitHub access to each managed repository, including non-interactive Git fetch/push.
- A Linear workspace and a project for each repository you want to manage.
- Target-branch CI and GitHub protections appropriate for automatic merging, including requiring PR branches to be up to date. Symphony respects those protections.

Sign in using your existing accounts:

```bash
codex login
gh auth login
```

## Quick start

### 1. Install

```bash
git clone https://github.com/joshua5201/symphony-machine.git
cd symphony-machine
npm ci
npm run install:agents -- --dry-run
npm run install:agents
cp symphony.example.yaml symphony.yaml
```

Keep this checkout at a stable path: the installer links its skills and workflow into `~/.agents`. See [installation notes and migration](docs/operations.md#agent-installation) for Windows, existing links, or conflicts.

### 2. Configure your repository and Linear project

Edit the gitignored `symphony.yaml`, using the [annotated example](symphony.example.yaml):

- Set `repositories[].path`, `github`, `branch` (`main` or `master`), and `remote` to match your local checkout and GitHub repository.
- Set `team` and `project` to the Linear team/project IDs. Each project maps to one repository.
- Map `states` to your team's existing states, including `Ready to merge`, and create the `needs-human` and `no-auto-pickup` labels if missing. See the [Linear interface contract](agents/workflows/LINEAR-CONTRACT.md#statuses) for their meanings.
- Set `required_workflows` to your target-branch CI workflow names or file paths.
- Configure the Linear–GitHub integration to move linked issues to Done after merge. Symphony does not set Done itself.

The example enables automatic merging and daily maintenance. Review `auto_merge` and `maintenance` before starting; set `auto_merge: false` or `maintenance.enabled: false` if you do not want those actions.

Keep credentials in existing login stores or environment variables, never in this file or Git.

### 3. Authorize Linear

The runner and Codex agents each need their own Linear authorization against the same workspace:

```bash
# Codex agents: skip "add" if the linear MCP server already exists.
codex mcp add linear --url https://mcp.linear.app/mcp
codex mcp login linear

# Runner: open the printed URL on this computer and complete consent.
npm start -- linear-login --config symphony.yaml
```

A Linear connection in a Desktop chat does not authorize the standalone runner.

### 4. Check and start

```bash
npm start -- doctor --config symphony.yaml
npm start -- run --config symphony.yaml
```

Doctor checks prerequisites and connections without starting agent work. Leave the runner in the foreground, or run it inside tmux. Open [the dashboard](http://127.0.0.1:4310) to see tickets and agent activity and pause/resume work.

## Run your first ticket

1. Create a code-change issue in the configured Linear project, with approved scope and clear acceptance criteria. This version delivers code through PRs; it does not execute non-code-only tickets.
2. Move it to Todo when you want Symphony to start. Dependencies must be complete; `needs-human` and `no-auto-pickup` prevent automatic pickup.
3. Follow progress in Linear, the dashboard, and the linked GitHub PR. The normal path is Todo → In Progress → In Review → Ready to merge → Done. Pickup uses polling, so it may take a few minutes.
4. Respond to requests marked `needs-human`. For a resolved decision in Blocked, remove the label and return the issue to Todo (or In Review for review-only work). Complete required human review or acceptance by moving the issue to Ready to merge.

Eligible PRs merge in scheduled groups after review and required checks. With automatic merging enabled, the default group interval is 30 minutes, with a 5-minute observation window after successful target CI for each merge.

For help preparing requirements, start a fresh Codex session with the Linear plugin connected and invoke [`symphony-intake`](agents/skills/symphony-intake/SKILL.md). It helps clarify and record scope before execution; placing an approved issue directly in Todo also works.

## Everyday controls

Run these commands from this checkout in another terminal:

```bash
npm start -- status --config symphony.yaml
npm start -- pause --repo all --config symphony.yaml
npm start -- resume --repo all --config symphony.yaml
npm start -- retry --issue TEAM-123 --config symphony.yaml
```

- Replace `all` with a configured repository `id` to pause/resume one repository. Pause interrupts managed agent turns and preserves their sessions/worktrees; resume continues eligible work. Pause survives restart.
- Retry returns failed/blocked work to the appropriate queue. It does not remove control labels or resolve human decisions.
- Add `no-auto-pickup` in Linear to handle a ticket yourself. It prevents further automated work, including merging; already active agents finish.
- First `Ctrl+C` stops new work and drains active jobs. A second interrupts active turns and saves resumable state. Restart the same `run` command to recover.

The dashboard binds to loopback by default. Anyone who can reach it can read its contents and pause/resume work; it has no login. See [remote access](docs/operations.md#dashboard-access) before changing the bind address.

## Further reading

- [Operations](docs/operations.md): installation, tuning, dashboard access, troubleshooting, and recovery.
- [Configuration example](symphony.example.yaml): available settings and defaults.
- [Workflow](agents/workflows/WORKFLOW.md) (Chinese): how intake, planning, implementation, verification, and delivery are assigned. It uses [IPA Common Frame 2013 (共通フレーム)](https://www.ipa.go.jp/publish/secbooks20130304.html), a shared framework for lifecycle activities and roles, to distinguish requirements, design, and implementation responsibilities.
- [Linear interface contract](agents/workflows/LINEAR-CONTRACT.md): ticket states, dependencies, labels, and handoffs.
- Entry skills: [intake](agents/skills/symphony-intake/SKILL.md) prepares requirements; [execute](agents/skills/symphony-execute/SKILL.md) carries out an approved ticket. They activate only when explicitly invoked or dispatched by the runner.
- [Development checks](docs/operations.md#development).
