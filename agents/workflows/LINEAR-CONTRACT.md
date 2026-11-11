# Linear interface contract

Linear is the interface between the owner, the workflow, and the foreground runner. It holds approved scope, issue status, dependencies, decisions, delivery links, and recovery context. GitHub remains authoritative for PR, CI, and merge facts; a completed agent turn is not evidence that an issue is complete.

This document defines that interface. The [Chinese workflow](WORKFLOW.md) defines how work is performed and references this contract for status semantics.

## Statuses

Each managed project maps the following semantic keys through `repositories[].states` in local configuration. The displayed names below are defaults, not required spellings. Use the team's existing states; the workflow must resolve their mapping before changing an issue.

| Configuration key | Default status | Meaning and handoff |
| --- | --- | --- |
| `backlog` | Backlog | Scope is proposed or awaiting a human decision. Ordinary execution does not pick it up. Move to Todo only after the owner authorizes the scope; configured automated maintenance may authorize work within its existing policy. |
| `todo` | Todo | Scope is authorized for execution. The runner may pick it up when dependencies and control labels allow. Placing an issue here directly is a valid handoff; a separate intake approval record is not required. Fixable implementation or verification corrections return here to the original execution. |
| `in_progress` | In Progress | Execution has started and still owns implementation and required verification evidence. An interrupted execution may remain here and resume from its saved context; this does not mean an agent is currently running. Normal CI waiting within the execution deadline remains here. |
| `review` | In Review | Implementation and required local, CI/CD and smoke verification are complete for the current PR head, with evidence available. The PR is open, non-draft and targets the configured branch. Independent code review, and any required human review or acceptance, happen here. This status grants no human approval. |
| `ready_to_merge` | Ready to merge | The authoritative handoff that review and required human gates are complete, blocking findings have a recorded disposition, and current-head verification evidence is complete. The owner completes required human review or acceptance by moving the issue here. The runner needs no separate SQLite merge-permission record. The issue awaits merge planning and deterministic merge checks; this status does not override GitHub protections or permit merging a different head. |
| `blocked` | Blocked | Work cannot proceed without an identified decision, dependency, permission or other external prerequisite. Record the cause and recovery condition. Once resolved, return execution work to Todo or review-only work to In Review as appropriate; waiting alone does not resume it. |
| `done` | Done | The required delivery is complete. For runner-managed code work, the linked PR has merged into the configured target and the Linear–GitHub integration owns this transition. Neither the runner nor its agents writes Done. |

Canceled/Closed is a separate, optional terminal state, not a successful completion or a satisfied dependency. It needs no entry in this configuration mapping. Reopening terminal work requires an explicit new instruction.

## Issue information

- The team/project identifies exactly one configured repository. The issue title and description, together with linked requirements and recorded human decisions, define the authorized scope and acceptance conditions.
- Current comments and the workpad preserve requirements and human decisions, evidence links, concise handoffs, and enough context to continue. Detailed code-review findings, responses and dispositions live in GitHub PR reviews/comments/threads; Linear links to them instead of duplicating the review. Human answers must be read before resuming affected work; terminal output alone is not a human notification.
- Delivery includes a discoverable GitHub PR link and evidence for the current change. The runner can also discover the PR on its owned execution branch. A state change or a textual claim that CI passed does not replace GitHub evidence.
- Linear `blockedBy` relations express prerequisites. Before starting dependent work, the runner requires Done and verifies linked PRs are actually merged into their configured targets. A genuinely non-code prerequisite without a PR must be Done and explicitly contain `[No PR required]` in its description. This does not add support for executing non-code-only tickets.

## Control labels and decisions

`needs-human` marks an unresolved human decision, required human review or acceptance. Outside Ready to merge, the runner stops admitting execution, review and merge work for that issue. Mid-execution work waiting on a human decision is Blocked with this label; completed work waiting only on required human review or acceptance remains In Review with this label. Record the exact question, affected work and recovery condition in a Linear comment, linking to the PR when applicable. The owner completes required human review or acceptance by moving the issue to Ready to merge; that status takes precedence over a remaining `needs-human` label. For other resolved decisions, remove the label and use the appropriate status to resume. The retry command does not remove this label.

`no-auto-pickup` reserves an issue for manual handling. It excludes new automated execution, recovery, review, and merge work in every status, including Ready to merge, maintenance and CI repair. Already active agents finish. Removing it restores eligibility according to status and dependencies. Both label names can be configured under `linear`.

Fixable code, tests, CI/CD, smoke-test or evidence gaps return the issue to Todo with a concise handoff and PR finding links. A merge conflict or required branch update also returns Todo to the original Lead, with the reason and affected PR context. When returning from Ready to merge for this implementation work, remove any stale `needs-human` label from the completed human handoff so it does not prevent Lead from resuming; a new unresolved human decision still requires that label. Normal pending CI within its deadline is waiting, not an external blocker. An external prerequisite moves the issue to Blocked; an unresolved human decision also adds `needs-human`. Successful review moves it to Ready to merge. A changed PR head requires verification of the affected changes by the original Lead before incremental review; pending CI alone is not review-ready. A timestamp change alone does not invalidate completed review or require another review. Only a verified merge completes code delivery; rejected or canceled PRs do not.

Requirements and human decisions stay in Linear. Workflow changes cannot silently change approved scope, acceptance, or human authority. Agent roles, delegation modes, model choices, and planning formats belong to the workflow implementation, not this interface.
