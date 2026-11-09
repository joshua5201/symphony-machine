# Linear interface contract

Linear is the interface between the owner, the workflow, and the foreground runner. It holds approved scope, issue status, dependencies, decisions, delivery links, and recovery context. GitHub remains authoritative for PR, CI, and merge facts; a completed agent turn is not evidence that an issue is complete.

This document defines that interface. The [Chinese workflow](WORKFLOW.md) defines how work is performed and references this contract for status semantics.

## Statuses

Each managed project maps the following semantic keys through `repositories[].states` in local configuration. The displayed names below are defaults, not required spellings. Use the team's existing states; the workflow must resolve their mapping before changing an issue.

| Configuration key | Default status | Meaning and handoff                                                                                                                                                                                                                                                                                                            |
| ----------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backlog`         | Backlog        | Scope is proposed or awaiting a human decision. Ordinary execution does not pick it up. Move to Todo only after the owner authorizes the scope; configured automated maintenance may authorize work within its existing policy.                                                                                                |
| `todo`            | Todo           | Scope is authorized for execution. The runner may pick it up when dependencies and control labels allow. Placing an issue here directly is a valid handoff; a separate intake approval record is not required. Review corrections also return here for execution.                                                              |
| `in_progress`     | In Progress    | Execution has started and delivery is still owned by the executing workflow. The execution agent maintains this status. An interrupted execution may remain here and resume from its saved context; this does not mean an agent is currently running.                                                                          |
| `review`          | In Review      | Delivery is ready for review: requirements and required verification are satisfied, evidence is available, and the code PR is open, non-draft, and targets the configured branch. The runner reviews and considers it for merge. This status alone grants neither human approval nor permission to skip a required human gate. |
| `blocked`         | Blocked        | Work cannot proceed without an identified decision, dependency, permission, or other prerequisite. Record the cause and recovery condition. Once resolved, return execution work to Todo or review-only work to Review as appropriate; waiting alone does not resume it.                                                       |
| `done`            | Done           | The required delivery is complete. For runner-managed code work, the linked PR has merged into the configured target and the Linear–GitHub integration owns this transition. Neither the runner nor its agents writes Done.                                                                                                    |

Canceled/Closed is a separate, optional terminal state, not a successful completion or a satisfied dependency. It needs no entry in this configuration mapping. Reopening terminal work requires an explicit new instruction.

## Issue information

- The team/project identifies exactly one configured repository. The issue title and description, together with linked requirements and recorded human decisions, define the authorized scope and acceptance conditions.
- Current comments and the workpad preserve delivery evidence, unresolved decisions, and enough context to continue. Human answers must be read before resuming affected work; terminal output alone is not a human notification.
- Delivery includes a discoverable GitHub PR link and evidence for the current change. The runner can also discover the PR on its owned execution branch. A state change or a textual claim that CI passed does not replace GitHub evidence.
- Linear `blockedBy` relations express prerequisites. Before starting dependent work, the runner requires Done and verifies linked PRs are actually merged into their configured targets. A genuinely non-code prerequisite without a PR must be Done and explicitly contain `[No PR required]` in its description. This does not add support for executing non-code-only tickets.

## Control labels and decisions

`needs-human` marks an unresolved human decision or acceptance. The runner stops admitting execution, review, and merge work for that issue. It may remain in Review while awaiting acceptance; the label and the status communicate different facts. Record the exact question, affected work, and recovery condition in a Linear comment. After the owner resolves it, remove the label and use the appropriate status to resume. The retry command does not remove this label.

`no-auto-pickup` reserves an issue for manual handling. It excludes new automated execution, recovery, review, and merge work, including maintenance and CI repair. Already active agents finish. Removing it restores eligibility according to status and dependencies. Both label names can be configured under `linear`.

An actionable review correction returns the issue to Todo with findings. An external blocker moves it to Blocked; a human decision adds `needs-human` with the question. Successful review leaves it in Review while merge eligibility is checked. Only a verified merge completes code delivery; rejected or canceled PRs do not.

Requirements and human decisions stay in Linear. Workflow changes cannot silently change approved scope, acceptance, or human authority. Agent roles, delegation modes, model choices, and planning formats belong to the workflow implementation, not this interface.
