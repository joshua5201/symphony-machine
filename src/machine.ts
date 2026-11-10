import { randomUUID } from "node:crypto";
import type { Config, Repo } from "./config.js";
import { gitConfig, routing } from "./config.js";
import { GitHub, type PrInfo } from "./github.js";
import { CodexRunner } from "./codex.js";
import type { LinearClient, LinearIssue } from "./linear.js";
import { Store, type Job } from "./store.js";
import { maintenanceDirections } from "./maintenance.js";
import type { DashboardSnapshot, DashboardTicket } from "./dashboard.js";
import {
  contract,
  executionInstructions,
  executionPrompt,
  executionSkill,
  maintenancePrompt,
  reviewPrompt,
} from "./prompts.js";

type Health = {
  sha: string;
  status: "pending" | "success" | "failure" | "unknown";
  url?: string;
};
type Decision = {
  issueId: string;
  pr: number;
  head: string;
  summary: string;
  updatedAt: string;
  prUpdatedAt: string;
  reviewFingerprint?: string;
};
type Sync = {
  id: string;
  issueId: string;
  state?: string;
  labels?: string[];
  comment?: string;
};
export type Log = (event: string, details?: unknown) => void;
// These arguments are displayed for manual copying, never executed by the runner.
const shellArgument = (value: string) =>
  /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : "'" + value.replaceAll("'", "'\"'\"'") + "'";
export class Machine {
  private active = new Map<
    string,
    {
      job: Job;
      abort: AbortController;
      promise: Promise<void>;
      issue?: LinearIssue;
      startedAt: string;
    }
  >();
  private dashboardState = new Map<
    string,
    {
      issues: Map<string, LinearIssue>;
      updatedAt: string | null;
      stale: boolean;
    }
  >();
  private next = new Map<string, number>();
  private retryAfter = new Map<string, number>();
  private stopping = false;
  constructor(
    public config: Config,
    private store: Store,
    private linear: LinearClient,
    private runner: CodexRunner,
    private log: Log,
    private githubFactory = (r: Repo) => new GitHub(gitConfig(r)),
  ) {}
  reload(c: Config) {
    const repositorySettings = (config: Config) =>
      config.repositories.map(({ concurrency, ...settings }) => settings);
    if (
      c.data_dir !== this.config.data_dir ||
      JSON.stringify(c.dashboard) !== JSON.stringify(this.config.dashboard) ||
      JSON.stringify(c.codex) !== JSON.stringify(this.config.codex) ||
      JSON.stringify(c.linear) !== JSON.stringify(this.config.linear) ||
      JSON.stringify(repositorySettings(c)) !==
        JSON.stringify(repositorySettings(this.config))
    )
      throw new Error(
        "Runtime/repository changes require restart; polling/concurrency/maintenance settings can reload",
      );
    if (
      c.maintenance.interval_hours !== this.config.maintenance.interval_hours
    ) {
      for (const r of c.repositories) {
        const next = this.store.get<number>(`maintenance_next:${r.id}`);
        if (next !== undefined)
          this.store.set(
            `maintenance_next:${r.id}`,
            next +
              (c.maintenance.interval_hours -
                this.config.maintenance.interval_hours) *
                3600000,
          );
      }
    }
    this.config = c;
    this.next.clear();
    this.retryAfter.clear();
  }
  get activeCount() {
    return this.active.size;
  }
  dashboard(): DashboardSnapshot {
    const jobs = this.store.jobs();
    return {
      updatedAt: new Date().toISOString(),
      projects: this.config.repositories.map((r) => ({
        id: r.id,
        name: r.id,
        repository: r.github,
        ticketsUpdatedAt: this.dashboardState.get(r.id)?.updatedAt ?? null,
        ticketsStale: this.dashboardState.get(r.id)?.stale ?? true,
        tickets: this.dashboardTickets(r, jobs),
        maintenance: jobs
          .filter((j) => j.repo === r.id && j.role === "maintenance")
          .reverse()
          .map((j) => ({
            id: j.id,
            theme:
              maintenanceDirections.find(
                (d) => d.id === j.maintenance?.direction,
              )?.focus ?? "General maintenance",
            status: j.status,
            summary: j.summary ?? null,
            startedAt: j.startedAt,
            updatedAt: j.updatedAt,
            from: j.maintenance?.from ?? null,
            to: j.maintenance?.to ?? null,
          })),
      })),
    };
  }
  private dashboardTickets(r: Repo, jobs: Job[]): DashboardTicket[] {
    const history = jobs.filter(
      (j) => j.repo === r.id && (j.role === "execution" || j.role === "review"),
    );
    const cached = this.dashboardState.get(r.id)?.issues;
    const identities = new Map(
      [...(cached?.values() ?? [])].flatMap(
        (issue) =>
          [
            [issue.id, issue.id],
            [issue.identifier, issue.id],
          ] as [string, string][],
      ),
    );
    const ids = new Set([
      ...(cached?.keys() ?? []),
      ...history.map((j) => identities.get(j.issueId) ?? j.issueId),
      ...jobs
        .filter((j) => j.repo === r.id)
        .flatMap((j) => j.createdIssueIds ?? [])
        .map((id) => identities.get(id) ?? id),
    ]);
    return [...ids].map((id): DashboardTicket => {
      const active = [...this.active.values()].find(
        (a) =>
          a.job.repo === r.id &&
          (identities.get(a.job.issueId) ?? a.job.issueId) === id &&
          a.issue,
      );
      const issue = cached?.get(id) ?? active?.issue;
      const previous = history
        .filter((j) => (identities.get(j.issueId) ?? j.issueId) === id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const agent = active?.job ?? previous;
      const state = issue?.state ?? null;
      const column: DashboardTicket["column"] =
        state === r.states.todo
          ? "todo"
          : state === r.states.in_progress
            ? "in_progress"
            : state === r.states.ready_to_merge
              ? "ready_to_merge"
              : state === r.states.review
                ? "review"
                : state === r.states.blocked
                  ? "blocked"
                  : state === r.states.done
                    ? "done"
                    : "other";
      const blockedAt =
        issue?.stateHistory
          ?.filter((entry) => entry.state === r.states.blocked)
          .map((entry) => entry.startedAt)
          .sort()
          .at(-1) ?? null;
      return {
        id,
        identifier: issue?.identifier ?? previous?.identifier ?? id,
        title: issue?.title ?? previous?.identifier ?? id,
        url: issue?.url ?? "",
        mode: issue
          ? issue.labels.includes("Symphony mode/Direct") ||
            issue.labels.includes("Direct")
            ? "Direct"
            : "Delegated"
          : null,
        role:
          agent?.role === "execution" || agent?.role === "review"
            ? agent.role
            : null,
        agentStatus: active
          ? "running"
          : agent?.status === "running"
            ? "waiting"
            : (agent?.status ?? null),
        resumeCommand: agent?.threadId
          ? [
              this.config.codex.command,
              "resume",
              agent.threadId,
              "--cd",
              r.path,
              ...(agent.workspace && !this.store.get(`cleaned:${agent.id}`)
                ? ["--add-dir", agent.workspace.path]
                : []),
            ]
              .map(shellArgument)
              .join(" ")
          : null,
        column,
        state,
        needsHumanReview:
          issue?.labels.includes(this.config.linear.needs_human_label) ?? false,
        startedAt:
          active?.startedAt ?? issue?.startedAt ?? previous?.startedAt ?? null,
        completedAt: issue?.completedAt ?? null,
        blockedAt,
      };
    });
  }
  private async pollDashboard(r: Repo) {
    const previous = this.dashboardState.get(r.id);
    try {
      const todo = await this.linear.listIssues({
        team: r.team,
        project: r.project,
        state: r.states.todo,
      });
      const issues = new Map(todo.map((issue) => [issue.id, issue]));
      const ids = new Set(
        this.store
          .jobs()
          .filter((j) => j.repo === r.id)
          .flatMap((j) => [
            ...(j.role === "execution" || j.role === "review"
              ? [j.issueId]
              : []),
            ...(j.createdIssueIds ?? []),
          ]),
      );
      let stale = false;
      for (const id of ids) {
        if (
          issues.has(id) ||
          [...issues.values()].some((issue) => issue.identifier === id)
        )
          continue;
        try {
          const issue = await this.linear.getIssue(id);
          issues.set(issue.id, issue);
        } catch (error) {
          stale = true;
          const retained =
            previous?.issues.get(id) ??
            [...(previous?.issues.values() ?? [])].find(
              (issue) => issue.identifier === id,
            );
          if (retained) issues.set(retained.id, retained);
          this.log("dashboard_poll_error", {
            repo: r.id,
            issue: id,
            error: String(error),
          });
        }
      }
      this.dashboardState.set(r.id, {
        issues,
        updatedAt: new Date().toISOString(),
        stale,
      });
    } catch (error) {
      this.dashboardState.set(r.id, {
        issues: previous?.issues ?? new Map(),
        updatedAt: previous?.updatedAt ?? null,
        stale: true,
      });
      this.log("dashboard_poll_error", { repo: r.id, error: String(error) });
    }
  }
  stop(force = false) {
    this.stopping = true;
    if (force) for (const a of this.active.values()) a.abort.abort();
  }
  async drain() {
    await Promise.allSettled([...this.active.values()].map((a) => a.promise));
    await this.flush();
  }
  recover() {
    for (const j of this.store.jobs())
      if (j.status === "running") {
        j.status = "waiting";
        if (j.role === "review") j.fingerprint = undefined;
        this.store.save(j);
      }
    this.log("recovered", { jobs: this.store.jobs().length });
  }
  private count(role: Job["role"], repo: string) {
    return [...this.active.values()].filter(
      (a) => a.job.role === role && a.job.repo === repo,
    ).length;
  }
  private due(key: string, seconds: number, now: number) {
    if (now < (this.next.get(key) ?? 0)) return false;
    this.next.set(key, now + seconds * 1000);
    return true;
  }
  private paused(repo: string) {
    return (
      this.store.get<boolean>("pause:all") ||
      this.store.get<boolean>(`pause:${repo}`)
    );
  }
  private skipIssue(issue: LinearIssue) {
    return (
      issue.labels.includes(this.config.linear.needs_human_label) ||
      issue.labels.includes(this.config.linear.no_auto_pickup_label)
    );
  }
  private job(repo: string, issueId: string, role: Job["role"]) {
    return this.store
      .jobs()
      .find((j) => j.repo === repo && j.issueId === issueId && j.role === role);
  }
  private create(
    r: Repo,
    issue: Pick<LinearIssue, "id" | "identifier">,
    role: Job["role"],
  ): Job {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      repo: r.id,
      issueId: issue.id,
      identifier: issue.identifier,
      role,
      status: "waiting",
      startedAt: now,
      updatedAt: now,
    };
  }
  private sync(change: Omit<Sync, "id">) {
    const pending = this.store.get<Sync[]>("outbox") ?? [];
    pending.push({ id: randomUUID(), ...change });
    this.store.set("outbox", pending);
  }
  async flush() {
    let pending = this.store.get<Sync[]>("outbox") ?? [];
    while (pending.length) {
      const item = pending[0];
      if (item.state || item.labels)
        await this.linear.updateIssue(item.issueId, {
          state: item.state,
          labels: item.labels,
        });
      if (item.comment) await this.linear.comment(item.issueId, item.comment);
      pending = (this.store.get<Sync[]>("outbox") ?? []).filter(
        (x) => x.id !== item.id,
      );
      this.store.set("outbox", pending);
    }
  }
  async tick(now = Date.now()) {
    await this.flush();
    if (this.stopping) return;
    for (const r of this.config.repositories) {
      if (!this.paused(r.id) && now >= (this.retryAfter.get(r.id) ?? 0)) {
        try {
          if (
            this.due(
              `${r.id}:health`,
              this.config.polling.master_ci_seconds,
              now,
            )
          )
            await this.health(r);
          if (
            this.due(`${r.id}:github`, this.config.polling.github_seconds, now)
          ) {
            await this.cleanup(r);
            await this.merge(r);
          }
          if (
            this.due(`${r.id}:review`, this.config.polling.review_seconds, now)
          )
            await this.reviews(r);
          if (
            this.due(`${r.id}:linear`, this.config.polling.linear_seconds, now)
          )
            await this.executions(r);
          await this.maintenance(r, now);
        } catch (error) {
          // A failed poll must remain a gate on subsequent ticks, even when
          // the failed lane's original deadline has not arrived yet.
          for (const key of this.next.keys())
            if (key.startsWith(`${r.id}:`)) this.next.delete(key);
          this.retryAfter.set(
            r.id,
            now + this.config.polling.linear_seconds * 1000,
          );
          this.log("poll_error", { repo: r.id, error: String(error) });
        }
      }
      if (
        this.config.dashboard.enabled &&
        this.due(`dashboard:${r.id}`, this.config.polling.linear_seconds, now)
      )
        await this.pollDashboard(r);
    }
  }
  private launch(
    j: Job,
    fn: (signal: AbortSignal) => Promise<void>,
    issue?: LinearIssue,
  ) {
    if (this.stopping || this.active.has(j.id)) return;
    j.status = "running";
    this.store.save(j);
    const abort = new AbortController();
    const promise = Promise.resolve()
      .then(() => fn(abort.signal))
      .catch((error) => {
        j.status =
          abort.signal.aborted || this.runner.failure ? "waiting" : "failed";
        j.summary = String(error);
        this.store.save(j);
        this.log("job_error", {
          job: j.id,
          issue: j.identifier,
          error: String(error),
        });
      })
      .finally(() => {
        this.active.delete(j.id);
        this.log("job_finished", {
          job: j.id,
          issue: j.identifier,
          role: j.role,
          status: j.status,
        });
      });
    this.active.set(j.id, {
      job: j,
      abort,
      promise,
      issue,
      startedAt: new Date().toISOString(),
    });
    this.log("job_started", { job: j.id, issue: j.identifier, role: j.role });
  }
  async dependenciesReady(issue: LinearIssue, r: Repo): Promise<boolean> {
    for (const dep of issue.blockedBy) {
      const full = await this.linear.getIssue(dep.id);
      if (!full.prUrls.length) {
        const linked = this.store
          .jobs()
          .find(
            (j) =>
              j.issueId === full.id && j.role === "execution" && j.prNumber,
          );
        if (linked) {
          const target = this.config.repositories.find(
            (x) => x.id === linked.repo,
          );
          if (!target || full.state !== target.states.done) return false;
          const pr = await this.githubFactory(target).pr(linked.prNumber!);
          if (pr.state !== "MERGED" || pr.base !== target.branch) return false;
          continue;
        }
        if (full.state !== r.states.done) return false;
        if (!full.description.includes("[No PR required]")) return false;
        continue;
      }
      for (const url of full.prUrls) {
        const match = url.match(
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/,
        );
        if (!match) return false;
        const target = this.config.repositories.find(
          (x) => x.github.toLowerCase() === match[1].toLowerCase(),
        );
        if (!target || full.state !== target.states.done) return false;
        const pr = await this.githubFactory(target).pr(Number(match[2]));
        if (pr.state !== "MERGED" || pr.base !== target.branch) return false;
      }
    }
    return true;
  }
  private async executions(r: Repo) {
    const c = this.config;
    let issues = await this.linear.listIssues({
      team: r.team,
      project: r.project,
      state: r.states.todo,
    });
    if (
      this.store
        .jobs()
        .some(
          (j) =>
            j.repo === r.id && j.role === "execution" && j.status === "waiting",
        )
    )
      issues.push(
        ...(await this.linear.listIssues({
          team: r.team,
          project: r.project,
          state: r.states.in_progress,
        })),
      );
    issues = issues.sort(
      (a, b) =>
        Number(b.title.startsWith("[CI repair]")) -
          Number(a.title.startsWith("[CI repair]")) ||
        Number(a.title.startsWith("[Maintenance]")) -
          Number(b.title.startsWith("[Maintenance]")),
    );
    for (const issue of issues) {
      if (this.count("execution", r.id) >= r.concurrency.execution_tickets)
        break;
      const old = this.job(r.id, issue.id, "execution");
      if (old && this.active.has(old.id)) continue;
      const recovering =
        old?.status === "waiting" && issue.state === r.states.in_progress;
      if (issue.state !== r.states.todo && !recovering) continue;
      if (this.skipIssue(issue)) continue;
      if (old?.status === "failed" && old.fingerprint === issue.updatedAt)
        continue;
      if (old?.workspace && this.store.get(`cleaned:${old.id}`)) continue;
      if (!(await this.dependenciesReady(issue, r))) continue;
      const j = old ?? this.create(r, issue, "execution");
      j.fingerprint = issue.updatedAt;
      this.launch(
        j,
        async (signal) => {
          const route = routing(c, issue.labels);
          const git = this.githubFactory(r);
          if (!j.workspace) j.workspace = await git.prepare(issue.identifier);
          this.store.save(j);
          const response = await this.runner.run({
            threadId: j.threadId,
            title: `${issue.identifier} · Lead`,
            cwd: r.path,
            writableRoots: [j.workspace.path],
            outputFormat: "text",
            skills: [executionSkill],
            config: {
              "agents.enabled": true,
              "agents.default_subagent_model": route.implementation.model,
              "agents.default_subagent_reasoning_effort":
                route.implementation.reasoning,
            },
            developerInstructions: executionInstructions,
            prompt: executionPrompt(c, r, issue, j),
            ...route.lead,
            signal,
            onThread: (id) => {
              j.threadId = id;
              this.store.save(j);
            },
          });
          if (response.outcome === "interrupted") {
            j.status = "waiting";
            this.store.save(j);
            return;
          }
          if (response.outcome !== "completed")
            throw new Error(response.error ?? `Agent ${response.outcome}`);
          const latest = await this.linear.getIssue(issue.id);
          const pr = await git.findPr(j.workspace.branch);
          if (pr && pr.branch === j.workspace.branch && pr.base === r.branch)
            j.prNumber = pr.number;
          j.summary = response.text;
          j.fingerprint = latest.updatedAt;
          j.status =
            latest.state === r.states.review ||
            latest.state === r.states.ready_to_merge ||
            latest.state === r.states.done
              ? "done"
              : latest.state === r.states.blocked ||
                  latest.labels.includes(c.linear.needs_human_label)
                ? "blocked"
                : latest.state === r.states.in_progress
                  ? "waiting"
                  : "failed";
          this.store.save(j);
        },
        issue,
      );
    }
  }
  private async reviews(r: Repo) {
    const pages = await Promise.all(
      [r.states.review, r.states.ready_to_merge].map((state) =>
        this.linear.listIssues({ team: r.team, project: r.project, state }),
      ),
    );
    const issues = new Map(pages.flat().map((issue) => [issue.id, issue]));
    for (let issue of issues.values()) {
      if (
        this.count("review", r.id) + this.count("merge", r.id) >=
        r.concurrency.reviews
      )
        break;
      if (this.skipIssue(issue)) continue;
      const execution = this.job(r.id, issue.id, "execution");
      const own = issue.prUrls
        .map((u) =>
          u.match(
            new RegExp(
              `^https://github\\.com/${r.github.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pull/(\\d+)`,
            ),
          ),
        )
        .find(Boolean);
      const number = execution?.prNumber ?? (own ? Number(own[1]) : undefined);
      if (!number) continue;
      const git = this.githubFactory(r);
      const pr = await git.pr(number);
      if (pr.state !== "OPEN" || pr.base !== r.branch || pr.draft) continue;
      const old = this.job(r.id, issue.id, "review");
      if (old && this.active.has(old.id)) continue;
      const context = await git.reviewContext(number);
      let fingerprint = `${pr.head}:${pr.updatedAt}:${issue.updatedAt}:${context.fingerprint}`;
      if (old?.fingerprint === fingerprint) continue;
      if (issue.state === r.states.ready_to_merge) {
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        const changedHead = old?.reviewedHead && old.reviewedHead !== pr.head;
        this.sync({
          issueId: issue.id,
          state: changedHead ? r.states.todo : r.states.review,
          comment: changedHead
            ? `PR #${number} head changed to ${pr.head}. Lead must verify the current-head delivery evidence and re-handoff to ${r.states.review}; subsequent code review remains incremental.`
            : `PR #${number} review or ticket context changed. Recheck the PR discussion and required approvals before returning to ${r.states.ready_to_merge}.`,
        });
        if (changedHead) continue;
        await this.flush();
        issue = await this.linear.getIssue(issue.id);
        if (issue.state !== r.states.review || this.skipIssue(issue)) continue;
        fingerprint = `${pr.head}:${pr.updatedAt}:${issue.updatedAt}:${context.fingerprint}`;
      }
      this.store.set(`merge:${r.id}:${issue.id}`, null);
      if (pr.checks !== "success") {
        if (pr.checks === "failure")
          this.sync({
            issueId: issue.id,
            state: r.states.todo,
            comment: `PR #${number} CI failed on ${pr.head}; Lead must repair the failure within the existing contract before independent review.`,
          });
        // Pending/missing CI is polled by code, not an agent-level blocker.
        continue;
      }
      const j = old ?? this.create(r, issue, "review");
      j.fingerprint = fingerprint;
      j.prNumber = number;
      j.head = pr.head;
      this.launch(
        j,
        async (signal) => {
          const response = await this.runner.run({
            threadId: j.threadId,
            title: `${issue.identifier} · Review`,
            cwd: r.path,
            developerInstructions: contract(this.config, r),
            prompt: reviewPrompt(
              this.config,
              r,
              issue,
              number,
              pr.head,
              j.reviewedHead,
            ),
            ...this.config.codex.review,
            signal,
            onThread: (id) => {
              j.threadId = id;
              this.store.save(j);
            },
          });
          if (response.outcome === "interrupted") {
            j.status = "waiting";
            j.fingerprint = undefined;
            this.store.save(j);
            return;
          }
          if (response.outcome !== "completed" || !response.result)
            throw new Error(response.error ?? `Review ${response.outcome}`);
          const result = response.result;
          j.summary = result.summary;
          j.status = "done";
          const current = await git.pr(number);
          const reviewedContext = await git.reviewContext(number);
          const latestIssue = await this.linear.getIssue(issue.id);
          if (
            current.state !== "OPEN" ||
            current.base !== r.branch ||
            current.draft ||
            current.checks !== "success" ||
            current.head !== pr.head ||
            latestIssue.description !== issue.description ||
            latestIssue.title !== issue.title ||
            latestIssue.state !== r.states.review ||
            this.skipIssue(latestIssue)
          ) {
            j.fingerprint = undefined;
            this.store.save(j);
            return;
          }
          j.reviewedHead = pr.head;
          j.fingerprint = `${current.head}:${current.updatedAt}:${latestIssue.updatedAt}:${reviewedContext.fingerprint}`;
          if (result.decision === "ready_to_merge") {
            this.sync({ issueId: issue.id, state: r.states.ready_to_merge });
            await this.flush();
            const readyIssue = await this.linear.getIssue(issue.id);
            if (
              readyIssue.state !== r.states.ready_to_merge ||
              readyIssue.description !== issue.description ||
              readyIssue.title !== issue.title ||
              this.skipIssue(readyIssue)
            ) {
              j.fingerprint = undefined;
              this.store.save(j);
              return;
            }
            j.fingerprint = `${current.head}:${current.updatedAt}:${readyIssue.updatedAt}:${reviewedContext.fingerprint}`;
            this.store.set(`merge:${r.id}:${issue.id}`, {
              issueId: issue.id,
              pr: number,
              head: pr.head,
              summary: result.summary,
              updatedAt: readyIssue.updatedAt,
              prUpdatedAt: current.updatedAt,
              reviewFingerprint: reviewedContext.fingerprint,
            } satisfies Decision);
          } else if (result.decision === "needs_human")
            this.sync({
              issueId: issue.id,
              labels: [
                ...new Set([
                  ...latestIssue.labels,
                  this.config.linear.needs_human_label,
                ]),
              ],
              comment: result.summary,
            });
          else if (result.decision === "needs_changes") {
            this.sync({
              issueId: issue.id,
              state: r.states.todo,
              comment: result.summary,
            });
            this.store.set(`merge:${r.id}:${issue.id}`, null);
          } else if (result.decision === "blocked")
            this.sync({
              issueId: issue.id,
              state: r.states.blocked,
              comment: result.summary,
            });
          else throw new Error(`Invalid review decision: ${result.decision}`);
          this.store.save(j);
        },
        issue,
      );
    }
  }
  private async health(r: Repo) {
    const h = await this.githubFactory(r).masterHealth();
    this.store.set(`health:${r.id}`, h);
    if (h.status !== "failure") return;
    const key = `incident:${r.id}:${h.sha}`;
    if (this.store.get(key)) return;
    const title = `[CI repair] ${r.id} ${h.sha.slice(0, 12)}`;
    const existing = (
      await this.linear.listIssues({ team: r.team, project: r.project })
    ).find((i) => i.title === title);
    const issue =
      existing ??
      (await this.linear.createIssue({
        team: r.team,
        project: r.project,
        title,
        state: r.states.todo,
        description: `The configured required CI failed on ${r.branch} commit ${h.sha}. ${h.url ?? ""}\nDiagnose logs using gh; restore the existing contract without broadening scope. Reuse bounded CI retries only for evidenced transient failure. No automatic revert, deployment, or credential changes. Escalate decisions requiring the owner. Acceptance: failing checks repaired, other required checks pass, and post-merge target CI is healthy. This ticket is authorized as a master-CI repair. New commits may supersede this failure: recheck current target before changing code.`,
      }));
    this.store.set(key, issue.id);
    this.store.set(`repair:${r.id}`, issue.id);
    this.log("master_ci_failed", {
      repo: r.id,
      sha: h.sha,
      issue: issue.identifier,
    });
  }
  private async merge(r: Repo) {
    if (!r.auto_merge) return;
    const health = this.store.get<Health>(`health:${r.id}`);
    if (!health) return;
    const approved = this.store
      .jobs()
      .filter(
        (j) => j.repo === r.id && j.role === "review" && j.status === "done",
      )
      .map((j) => ({
        job: j,
        decision: this.store.get<Decision | null>(`merge:${r.id}:${j.issueId}`),
      }))
      .filter((x) => x.decision);
    const candidates: typeof approved = [];
    for (const candidate of approved) {
      const issue = await this.linear.getIssue(candidate.decision!.issueId);
      if (issue.state === r.states.ready_to_merge && !this.skipIssue(issue))
        candidates.push(candidate);
    }
    candidates.sort(
      (a, b) =>
        Number(b.decision!.issueId === this.store.get(`repair:${r.id}`)) -
          Number(a.decision!.issueId === this.store.get(`repair:${r.id}`)) ||
        a.job.startedAt.localeCompare(b.job.startedAt),
    );
    const signature = JSON.stringify(
      candidates.map((x) => [
        x.decision!.issueId,
        x.decision!.head,
        x.decision!.updatedAt,
      ]),
    );
    if (!candidates.length) return;
    const plan = this.store.get<{ signature: string; order: string[] }>(
      `merge_plan:${r.id}`,
    );
    if (plan?.signature !== signature || !plan.order.length) {
      if (
        [...this.active.values()].some(
          (a) => a.job.repo === r.id && a.job.role === "merge",
        )
      )
        return;
      if (
        this.count("merge", r.id) + this.count("review", r.id) >=
        r.concurrency.reviews
      )
        return;
      const j = this.create(
        r,
        { id: `merge:${r.id}`, identifier: `merge:${r.id}` },
        "merge",
      );
      this.launch(j, async (signal) => {
        const response = await this.runner.run({
          cwd: r.path,
          title: `${r.id} · Merge planning`,
          developerInstructions: contract(this.config, r),
          prompt: `${contract(this.config, r)}\nYou are the Merge planning agent, separate from the programmatic coordinator that executes merges. Decide which independently reviewed ${r.states.ready_to_merge} candidates should merge this round and in which order. Read related Linear issues and relevant PR changes as needed. Prioritize CI repair, dependencies and product priorities. Assess overlap and concrete integration risks between these changes (interfaces, data/migrations, shared behavior and delivery order as applicable); do not repeat the independent code review or introduce style/extra-scope requirements. If a candidate needs actionable work or has an identified unavailable prerequisite, record a concise finding and PR evidence link on its Linear ticket and return it to ${r.states.todo} or ${r.states.blocked} respectively; human decision blockers also need an explicit escalation and ${this.config.linear.needs_human_label}. Normal pending CI is polled by the coordinator, not a reason to mark Blocked. Do not merge or edit code. Return decision done and issueIds in merge order (a subset is permitted), with rationale in summary. Candidates: ${JSON.stringify(candidates.map((x) => x.decision))}`,
          ...this.config.codex.review,
          signal,
          onThread: (id) => {
            j.threadId = id;
            this.store.save(j);
          },
        });
        if (
          response.outcome !== "completed" ||
          response.result?.decision !== "done"
        )
          throw new Error(
            response.error ??
              response.result?.summary ??
              "Merge planning failed",
          );
        const order = response.result.issueIds ?? [];
        if (
          new Set(order).size !== order.length ||
          order.some(
            (id) => !candidates.some((x) => x.decision!.issueId === id),
          )
        )
          throw new Error(
            "Merge planner returned unknown or duplicate candidates",
          );
        this.store.set(`merge_plan:${r.id}`, { signature, order });
        j.status = "done";
        j.summary = response.result.summary;
        this.store.save(j);
      });
      return;
    }
    candidates.sort(
      (a, b) =>
        plan.order.indexOf(a.decision!.issueId) -
        plan.order.indexOf(b.decision!.issueId),
    );
    for (const { job, decision: d } of candidates) {
      if (
        !d ||
        !plan.order.includes(d.issueId) ||
        [...this.active.values()].some((a) => a.job.issueId === d.issueId)
      )
        continue;
      const repair = d.issueId === this.store.get(`repair:${r.id}`);
      if (
        health.status !== "success" &&
        !(health.status === "failure" && repair)
      )
        continue;
      const issue = await this.linear.getIssue(d.issueId);
      if (
        issue.state !== r.states.ready_to_merge ||
        this.skipIssue(issue) ||
        !(await this.dependenciesReady(issue, r))
      )
        continue;
      const git = this.githubFactory(r);
      const pr = await git.pr(d.pr);
      if (pr.state === "MERGED") {
        await this.merged(r, issue, pr);
        continue;
      }
      const context = await git.reviewContext(d.pr);
      if (
        pr.state !== "OPEN" ||
        pr.head !== d.head ||
        pr.updatedAt !== d.prUpdatedAt ||
        issue.updatedAt !== d.updatedAt ||
        context.fingerprint !== d.reviewFingerprint
      ) {
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        job.fingerprint = undefined;
        this.store.save(job);
        this.sync({
          issueId: issue.id,
          state: pr.head !== d.head ? r.states.todo : r.states.review,
          comment:
            pr.head !== d.head
              ? `PR #${d.pr} head changed to ${pr.head}. Lead must refresh required delivery evidence, then request incremental review on the existing PR.`
              : `PR #${d.pr} review or ticket context changed; the previous merge permission is invalid. Recheck the PR discussion before ${r.states.ready_to_merge}.`,
        });
        continue;
      }
      const updated = await git.updateBranch(d.pr);
      if (updated === "conflict") {
        this.sync({
          issueId: issue.id,
          state: r.states.todo,
          comment: `PR #${d.pr} conflicts with ${r.branch}. Resume the existing branch/PR, resolve conflicts, and reverify.`,
        });
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        return;
      }
      const fresh = await git.pr(d.pr);
      if (updated === "updated" || fresh.head !== d.head) {
        job.fingerprint = undefined;
        this.store.save(job);
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        this.sync({
          issueId: issue.id,
          state: r.states.todo,
          comment: `Coordinator updated PR #${d.pr} from ${d.head} to ${fresh.head}. Lead must verify required current-head CI, deployment and affected smoke evidence in the existing branch/PR, then re-handoff to ${r.states.review}. Code review remains incremental from the last reviewed head.`,
        });
        return;
      }
      if (fresh.checks === "failure") {
        this.sync({
          issueId: issue.id,
          state: r.states.todo,
          comment: `PR #${d.pr} CI failed on ${fresh.head}; inspect the failed checks and repair within the existing contract.`,
        });
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        return;
      }
      if (fresh.checks !== "success") return;
      // Refresh target health immediately before merging; an earlier poll is not authorization.
      const latest = await git.masterHealth();
      this.store.set(`health:${r.id}`, latest);
      if (
        latest.status !== "success" &&
        !(latest.status === "failure" && repair)
      )
        return;
      if (latest.sha !== health.sha) return; // Re-evaluate integration after a moving target.
      await git.merge(d.pr, d.head);
      const merged = await git.pr(d.pr);
      if (merged.state !== "MERGED")
        throw new Error("Merge command returned without confirmed merge");
      await this.merged(r, issue, merged);
      this.store.set(`health:${r.id}`, { sha: "", status: "pending" });
      return;
    }
  }
  private async merged(r: Repo, issue: LinearIssue, pr: PrInfo) {
    if (pr.state !== "MERGED" || pr.base !== r.branch)
      throw new Error(
        "Merged PR does not target the configured integration branch",
      );
    this.store.set(`merge:${r.id}:${issue.id}`, null);
    const j = this.job(r.id, issue.id, "execution");
    if (j?.workspace) {
      j.prNumber = pr.number;
      this.store.save(j);
      this.store.set(`cleanup:${j.id}`, true);
    }
    this.log("merged", { repo: r.id, issue: issue.identifier, pr: pr.number });
  }
  private async cleanup(r: Repo) {
    for (const j of this.store
      .jobs()
      .filter(
        (j) => j.repo === r.id && j.role === "execution" && j.workspace,
      )) {
      if ([...this.active.values()].some((a) => a.job.issueId === j.issueId))
        continue;
      if (this.store.get(`cleaned:${j.id}`)) continue;
      const git = this.githubFactory(r);
      const pr = j.prNumber
        ? await git.pr(j.prNumber)
        : await git.findPr(j.workspace!.branch);
      if (
        !pr ||
        pr.state !== "MERGED" ||
        pr.base !== r.branch ||
        pr.branch !== j.workspace!.branch
      )
        continue;
      if (!this.store.get(`cleanup:${j.id}`)) {
        const issue = await this.linear.getIssue(j.issueId);
        await this.merged(r, issue, pr);
      }
      try {
        await git.cleanup(j.workspace!, pr.number);
        this.store.set(`cleaned:${j.id}`, true);
        this.log("cleaned", { issue: j.identifier });
      } catch (error) {
        const text = String(error);
        if (this.store.get(`cleanup_error:${j.id}`) !== text) {
          this.sync({
            issueId: j.issueId,
            comment: `Merged work was preserved because cleanup could not finish: ${text}. The machine will retry.`,
          });
          this.store.set(`cleanup_error:${j.id}`, text);
        }
        this.log("cleanup_pending", { issue: j.identifier, error: text });
      }
    }
  }
  private async maintenance(r: Repo, now: number) {
    const c = this.config;
    if (
      !c.maintenance.enabled ||
      this.count("maintenance", r.id) >= r.concurrency.maintenance_scans
    )
      return;
    if (
      c.maintenance.idle_only &&
      (this.count("execution", r.id) >= r.concurrency.execution_tickets ||
        this.count("review", r.id) + this.count("merge", r.id) > 0)
    )
      return;
    if (
      [...this.active.values()].some(
        (a) => a.job.repo === r.id && a.job.role === "maintenance",
      )
    )
      return;
    const history = this.store
      .jobs()
      .filter((j) => j.repo === r.id && j.role === "maintenance");
    const pending = history.find((j) => j.status === "waiting");
    if (
      !pending &&
      now < (this.store.get<number>(`maintenance_next:${r.id}`) ?? 0)
    )
      return;
    const j =
      pending ??
      this.create(
        r,
        { id: `maintenance:${r.id}`, identifier: `maintenance:${r.id}` },
        "maintenance",
      );
    this.store.set(
      `maintenance_next:${r.id}`,
      now + c.maintenance.interval_hours * 3600000,
    );
    this.launch(j, async (signal) => {
      if (!j.maintenance) {
        const previous = history.findLast((job) => job.maintenance);
        const index = maintenanceDirections.findIndex(
          (d) => d.id === previous?.maintenance?.direction,
        );
        const direction =
          maintenanceDirections[(index + 1) % maintenanceDirections.length].id;
        const from = history.findLast(
          (job) =>
            job.status === "done" && job.maintenance?.direction === direction,
        )?.maintenance?.to;
        const to = await this.githubFactory(r).targetCommit();
        j.maintenance = { direction, from, to };
        this.store.save(j);
      }
      const scan = j.maintenance;
      if (scan.from === scan.to) {
        j.status = "done";
        j.summary = `No new commits for ${scan.direction} at ${scan.to}; skipped agent.`;
        this.store.save(j);
        this.log("maintenance_skipped", { repo: r.id, ...scan });
        return;
      }
      const result = await this.runner.run({
        threadId: j.threadId,
        cwd: r.path,
        title: `${r.id} · Maintenance · ${scan.direction}`,
        developerInstructions: contract(c, r),
        prompt: maintenancePrompt(c, r, scan),
        ...c.codex.maintenance,
        signal,
        onThread: (id) => {
          j.threadId = id;
          this.store.save(j);
        },
      });
      if (result.outcome === "interrupted") {
        j.status = "waiting";
        this.store.save(j);
        this.log("job_interrupted", { job: j.id, issue: j.identifier });
        return;
      }
      if (result.outcome !== "completed" || result.result?.decision !== "done")
        throw new Error(
          result.error ?? result.result?.summary ?? "Maintenance failed",
        );
      j.status = "done";
      j.summary = result.result.summary;
      j.createdIssueIds = result.result.issueIds ?? [];
      this.store.save(j);
    });
  }
}
