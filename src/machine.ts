import { randomUUID } from "node:crypto";
import retry from "retry";
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
type MergeCandidate = {
  issueId: string;
  identifier: string;
  pr: number;
  head: string;
};
type MergeGroup = {
  id: string;
  jobId: string;
  candidates: MergeCandidate[];
  order?: string[];
};
type MergeObservation = {
  groupId: string;
  previousSha?: string;
  healthySha?: string;
  healthySince?: number;
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
  private backoffs = new Map<string, { failures: number; until: number }>();
  private pauseStates = new Map<string, boolean>();
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
        "Runtime/repository changes require restart; polling/merge/concurrency/maintenance settings can reload",
      );
    if (
      c.merge.group_interval_minutes !==
      this.config.merge.group_interval_minutes
    ) {
      for (const r of c.repositories) {
        const next = this.store.get<number>(`merge_next:${r.id}`);
        if (next !== undefined)
          this.store.set(
            `merge_next:${r.id}`,
            next +
              (c.merge.group_interval_minutes -
                this.config.merge.group_interval_minutes) *
                60000,
          );
      }
    }
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
  }
  get activeCount() {
    return this.active.size;
  }
  dashboard(): DashboardSnapshot {
    const jobs = this.store.jobs();
    return {
      updatedAt: new Date().toISOString(),
      paused: this.store.get<boolean>("pause:all") === true,
      activeAgents: this.activeCount,
      stopping: this.stopping,
      projects: this.config.repositories.map((r) => ({
        id: r.id,
        name: r.id,
        repository: r.github,
        paused: this.store.get<boolean>(`pause:${r.id}`) === true,
        effectivePaused: this.paused(r.id),
        activeAgents: [...this.active.values()].filter(
          (a) => a.job.repo === r.id,
        ).length,
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
        noAutoPickupLabel: issue?.labels.includes(
          this.config.linear.no_auto_pickup_label,
        )
          ? this.config.linear.no_auto_pickup_label
          : null,
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
      for (const id of ids) {
        if (
          issues.has(id) ||
          [...issues.values()].some((issue) => issue.identifier === id)
        )
          continue;
        const issue = await this.linear.getIssue(id);
        issues.set(issue.id, issue);
      }
      this.dashboardState.set(r.id, {
        issues,
        updatedAt: new Date().toISOString(),
        stale: false,
      });
      return true;
    } catch (error) {
      this.dashboardState.set(r.id, {
        issues: previous?.issues ?? new Map(),
        updatedAt: previous?.updatedAt ?? null,
        stale: true,
      });
      this.log("dashboard_poll_error", { repo: r.id, error: String(error) });
      return false;
    }
  }
  stop(force = false) {
    this.stopping = true;
    if (force) for (const a of this.active.values()) a.abort.abort();
  }
  setPaused(repo: string, paused: boolean) {
    if (repo !== "all" && !this.config.repositories.some((r) => r.id === repo))
      throw new Error(`Unknown repository ${repo}`);
    this.store.set(`pause:${repo}`, paused);
    this.applyPause();
    this.log("pause_changed", { repo, paused });
  }
  private applyPause() {
    for (const r of this.config.repositories) {
      const paused = this.paused(r.id);
      if (this.pauseStates.get(r.id) !== paused) {
        this.pauseStates.set(r.id, paused);
        // Resume on the next poll while retaining external-service backoffs.
        if (!paused)
          for (const key of this.next.keys())
            if (key.startsWith(`${r.id}:`)) this.next.delete(key);
      }
    }
    for (const a of this.active.values())
      if (this.paused(a.job.repo)) a.abort.abort();
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
    if (!this.retryReady(key, now)) return false;
    if (now < (this.next.get(key) ?? 0)) return false;
    this.next.set(key, now + seconds * 1000);
    return true;
  }
  private retryReady(key: string, now: number) {
    return now >= (this.backoffs.get(key)?.until ?? 0);
  }
  private backoff(key: string, seconds: number, now: number) {
    const failures = (this.backoffs.get(key)?.failures ?? 0) + 1;
    const retryInMs = retry.createTimeout(failures, {
      factor: 2,
      minTimeout: seconds * 1000,
      maxTimeout: Math.max(seconds * 1000, 15 * 60 * 1000),
      randomize: true,
    });
    const until = now + retryInMs;
    this.backoffs.set(key, { failures, until });
    return { failures, retryInMs, retryAt: new Date(until).toISOString() };
  }
  private paused(repo: string) {
    return (
      this.store.get<boolean>("pause:all") === true ||
      this.store.get<boolean>(`pause:${repo}`) === true
    );
  }
  private dispatchStopped(repo: string) {
    return this.stopping || this.paused(repo);
  }
  private skipIssue(issue: LinearIssue, ready = false) {
    return (
      (!ready && issue.labels.includes(this.config.linear.needs_human_label)) ||
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
    // CLI pause flags must interrupt active turns even during sync cooldowns.
    this.applyPause();
    const started = Date.now();
    const completedAt = () => now + Date.now() - started;
    if (!this.retryReady("outbox", now)) return;
    try {
      await this.flush();
      this.backoffs.delete("outbox");
    } catch (error) {
      this.log("sync_error", {
        error: String(error),
        ...this.backoff(
          "outbox",
          this.config.polling.linear_seconds,
          completedAt(),
        ),
      });
      return;
    }
    if (this.stopping) return;
    for (const r of this.config.repositories) {
      const repositoryPoll = `repo:${r.id}`;
      if (!this.paused(r.id) && this.retryReady(repositoryPoll, now)) {
        let interval = this.config.polling.linear_seconds;
        try {
          if (
            this.due(
              `${r.id}:health`,
              this.config.polling.master_ci_seconds,
              now,
            )
          ) {
            interval = this.config.polling.master_ci_seconds;
            await this.health(r);
          }
          if (
            this.due(`${r.id}:github`, this.config.polling.github_seconds, now)
          ) {
            interval = this.config.polling.github_seconds;
            await this.cleanup(r);
            await this.merge(r, completedAt());
          }
          if (
            this.due(`${r.id}:review`, this.config.polling.review_seconds, now)
          ) {
            interval = this.config.polling.review_seconds;
            await this.reviews(r);
          }
          if (
            this.due(`${r.id}:linear`, this.config.polling.linear_seconds, now)
          ) {
            interval = this.config.polling.linear_seconds;
            await this.executions(r);
          }
          interval = this.config.polling.linear_seconds;
          await this.maintenance(r, now);
          this.backoffs.delete(repositoryPoll);
        } catch (error) {
          // A failed poll must remain a gate on subsequent ticks, even when
          // the failed lane's original deadline has not arrived yet.
          for (const key of this.next.keys())
            if (key.startsWith(`${r.id}:`)) this.next.delete(key);
          const snapshot = this.dashboardState.get(r.id);
          if (snapshot) snapshot.stale = true;
          this.log("poll_error", {
            repo: r.id,
            error: String(error),
            ...this.backoff(repositoryPoll, interval, completedAt()),
          });
        }
      }
      if (
        this.config.dashboard.enabled &&
        this.retryReady(repositoryPoll, now) &&
        this.due(
          `dashboard:${r.id}`,
          this.config.polling.dashboard_seconds,
          now,
        )
      ) {
        const key = `dashboard:${r.id}`;
        if (await this.pollDashboard(r)) this.backoffs.delete(key);
        else
          this.log("dashboard_poll_backoff", {
            repo: r.id,
            ...this.backoff(
              key,
              this.config.polling.dashboard_seconds,
              completedAt(),
            ),
          });
      }
    }
  }
  private launch(
    j: Job,
    fn: (signal: AbortSignal) => Promise<void>,
    issue?: LinearIssue,
  ) {
    if (this.dispatchStopped(j.repo) || this.active.has(j.id)) return;
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
    if (this.dispatchStopped(r.id)) return;
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
      if (this.dispatchStopped(r.id)) break;
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
    if (this.dispatchStopped(r.id)) return;
    const issues = await this.linear.listIssues({
      team: r.team,
      project: r.project,
      state: r.states.review,
    });
    for (const issue of issues) {
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
      const fingerprint = JSON.stringify([
        pr.head,
        issue.title,
        issue.description,
        issue.labels,
        context.fingerprint,
      ]);
      if (old?.fingerprint === fingerprint) continue;
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
          j.fingerprint = JSON.stringify([
            current.head,
            latestIssue.title,
            latestIssue.description,
            latestIssue.labels,
            reviewedContext.fingerprint,
          ]);
          if (result.decision === "ready_to_merge") {
            this.sync({ issueId: issue.id, state: r.states.ready_to_merge });
            await this.flush();
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
            j.fingerprint = undefined;
            this.sync({
              issueId: issue.id,
              state: r.states.todo,
              comment: result.summary,
            });
          } else if (result.decision === "blocked") {
            j.fingerprint = undefined;
            this.sync({
              issueId: issue.id,
              state: r.states.blocked,
              comment: result.summary,
            });
          } else throw new Error(`Invalid review decision: ${result.decision}`);
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
  private async merge(r: Repo, now = Date.now()) {
    if (!r.auto_merge || this.dispatchStopped(r.id)) return;
    const health = this.store.get<Health>(`health:${r.id}`);
    if (!health) return;
    const interval = this.config.merge.group_interval_minutes * 60000;
    const next = this.store.get<number>(`merge_next:${r.id}`) ?? now;
    const scheduled = now >= next;
    if (scheduled)
      this.store.set(
        `merge_next:${r.id}`,
        next + (Math.floor((now - next) / interval) + 1) * interval,
      );

    const key = `merge_group:${r.id}`;
    const repairKey = `merge_repair_group:${r.id}`;
    let group = this.store.get<MergeGroup | null>(key);
    let repairGroup = this.store.get<MergeGroup | null>(repairKey);
    // Advancing the schedule above skips busy boundaries without a catch-up run.
    if (this.count("merge", r.id)) return;

    if (health.status === "failure" && !repairGroup) {
      const repairId = this.store.get<string>(`repair:${r.id}`);
      if (repairId && group?.order?.includes(repairId)) {
        await this.processMergeGroup(r, key, group, now, repairId);
        return;
      }
      const repairPlanning =
        group?.order === undefined &&
        group?.candidates.some((candidate) => candidate.issueId === repairId);
      if (repairId && !repairPlanning) {
        const candidates = await this.mergeCandidates(r, [
          await this.linear.getIssue(repairId),
        ]);
        if (candidates.length)
          repairGroup = this.createMergeGroup(r, repairKey, candidates);
      }
    }
    // Repair is an exception to admission timing, never to planning/review/checks.
    if (repairGroup) {
      await this.processMergeGroup(r, repairKey, repairGroup, now);
      return;
    }
    if (group) {
      await this.processMergeGroup(r, key, group, now);
      return;
    }
    if (!scheduled) return;
    const ready = await this.linear.listIssues({
      team: r.team,
      project: r.project,
      state: r.states.ready_to_merge,
    });
    const candidates = await this.mergeCandidates(r, ready);
    if (!candidates.length) return;
    group = this.createMergeGroup(r, key, candidates);
    await this.processMergeGroup(r, key, group, now);
  }
  private createMergeGroup(r: Repo, key: string, candidates: MergeCandidate[]) {
    const job = this.create(
      r,
      { id: `merge:${r.id}`, identifier: `merge:${r.id}` },
      "merge",
    );
    this.store.save(job);
    const group: MergeGroup = { id: job.id, jobId: job.id, candidates };
    this.store.set(key, group);
    this.log("merge_group_created", {
      repo: r.id,
      group: group.id,
      issues: candidates.map((candidate) => candidate.identifier),
      repair: key.startsWith("merge_repair_group:"),
    });
    return group;
  }
  private returnMergeToLead(r: Repo, issue: LinearIssue, comment: string) {
    this.sync({
      issueId: issue.id,
      state: r.states.todo,
      labels: issue.labels.filter(
        (label) => label !== this.config.linear.needs_human_label,
      ),
      comment,
    });
  }
  private async mergeCandidates(r: Repo, issues: LinearIssue[]) {
    const candidates: MergeCandidate[] = [];
    for (const issue of issues) {
      if (
        issue.state !== r.states.ready_to_merge ||
        this.skipIssue(issue, true) ||
        [...this.active.values()].some((a) => a.job.issueId === issue.id)
      )
        continue;
      const execution = this.job(r.id, issue.id, "execution");
      const linked = issue.prUrls
        .map((url) => {
          const match = url.match(
            /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#]|$)/,
          );
          return match?.[1].toLowerCase() === r.github.toLowerCase()
            ? Number(match[2])
            : undefined;
        })
        .find(Boolean);
      const number = execution?.prNumber ?? linked;
      if (!number) continue;
      const pr = await this.githubFactory(r).pr(number);
      if (pr.base !== r.branch) continue;
      if (pr.state === "MERGED") {
        await this.merged(r, issue, pr);
        continue;
      }
      if (pr.state !== "OPEN" || pr.draft) continue;
      if (pr.mergeable === "CONFLICTING" || pr.checks === "failure") {
        this.returnMergeToLead(
          r,
          issue,
          pr.mergeable === "CONFLICTING"
            ? `PR #${number} conflicts with ${r.branch}. Lead must resolve conflicts in the existing branch/PR and verify affected changes before returning to ${r.states.review}.`
            : `PR #${number} CI failed on ${pr.head}; Lead must inspect and repair the failure in the existing branch/PR.`,
        );
        continue;
      }
      if (pr.mergeable !== "MERGEABLE" || pr.checks !== "success") continue;
      if (!(await this.dependenciesReady(issue, r))) continue;
      candidates.push({
        issueId: issue.id,
        identifier: issue.identifier,
        pr: number,
        head: pr.head,
      });
    }
    return candidates.sort(
      (a, b) =>
        Number(b.issueId === this.store.get(`repair:${r.id}`)) -
          Number(a.issueId === this.store.get(`repair:${r.id}`)) ||
        a.identifier.localeCompare(b.identifier),
    );
  }
  private async observeMerge(r: Repo, now: number) {
    const key = `merge_observation:${r.id}`;
    const observation = this.store.get<MergeObservation | null>(key);
    if (!observation) return true;
    let health = this.store.get<Health>(`health:${r.id}`)!;
    // Recheck live facts when the observation window expires, including the last PR.
    if (
      observation.healthySince !== undefined &&
      now >=
        observation.healthySince + this.config.merge.cooldown_minutes * 60000
    ) {
      health = await this.githubFactory(r).masterHealth();
      this.store.set(`health:${r.id}`, health);
    }
    if (
      health.status !== "success" ||
      !health.sha ||
      health.sha === observation.previousSha
    ) {
      delete observation.healthySha;
      delete observation.healthySince;
      this.store.set(key, observation);
      return false;
    }
    if (observation.healthySha !== health.sha) {
      observation.healthySha = health.sha;
      observation.healthySince = now;
      this.store.set(key, observation);
      this.log("merge_cooldown_started", { repo: r.id, sha: health.sha });
    }
    if (
      now <
      observation.healthySince! + this.config.merge.cooldown_minutes * 60000
    )
      return false;
    this.store.set(key, null);
    return true;
  }
  private async processMergeGroup(
    r: Repo,
    key: string,
    group: MergeGroup,
    now: number,
    repairOnly?: string,
  ) {
    if (group.order === undefined) {
      if (
        this.count("merge", r.id) + this.count("review", r.id) >=
        r.concurrency.reviews
      )
        return;
      const j = this.store.jobs().find((job) => job.id === group.jobId)!;
      this.launch(j, async (signal) => {
        const response = await this.runner.run({
          threadId: j.threadId,
          cwd: r.path,
          title: `${r.id} · Merge planning`,
          developerInstructions: contract(this.config, r),
          prompt: `${contract(this.config, r)}
You are the Merge planning agent for group ${group.id}, separate from the programmatic coordinator that executes merges. Linear ${r.states.ready_to_merge} is the authoritative completed-review handoff, including when needs-human remains. This group has fixed membership, even for a single candidate. Decide which candidates should merge and in which order. The coordinator retains this order across individual merges; later Ready PRs wait for a later group. Read related Linear issues and relevant PR changes as needed. Prioritize CI repair, dependencies and product priorities. Assess overlap and concrete integration risks between these changes (interfaces, data/migrations, shared behavior and delivery order as applicable); do not repeat the independent code review or introduce style/extra-scope requirements. If a candidate needs actionable work or has an identified unavailable prerequisite, record a concise finding and PR evidence link on its Linear ticket and return it to ${r.states.todo} or ${r.states.blocked} respectively; human decision blockers also need an explicit escalation and ${this.config.linear.needs_human_label}. Normal pending CI is polled by the coordinator, not a reason to mark Blocked. Do not merge, update/rebase branches, resolve conflicts, or edit code. Conflicts return to Todo for the original Lead. When returning Ready work to Todo, remove the resolved needs-human label so it can resume; retain it only for a new unresolved human question. Do not repeat review based on timestamps or missing local approval records. Return decision done and issueIds in merge order (a subset is permitted), with rationale in summary. Candidates: ${JSON.stringify(group.candidates)}`,
          ...this.config.codex.review,
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
            (id) =>
              !group.candidates.some((candidate) => candidate.issueId === id),
          )
        )
          throw new Error(
            "Merge planner returned unknown or duplicate candidates",
          );
        group.order = order;
        this.store.set(key, group);
        j.status = "done";
        j.summary = response.result.summary;
        this.store.save(j);
      });
      return;
    }
    const finish = () => {
      this.store.set(key, null);
      this.log("merge_group_finished", { repo: r.id, group: group.id });
    };
    const ownsObservation = () =>
      this.store.get<MergeObservation | null>(`merge_observation:${r.id}`)
        ?.groupId === group.id;
    if (!group.order.length && !ownsObservation()) {
      finish();
      return;
    }
    const health = this.store.get<Health>(`health:${r.id}`)!;
    const repairId = this.store.get<string>(`repair:${r.id}`);
    const repair =
      health.status === "failure" && group.order.includes(repairId ?? "");
    if (!repair && !(await this.observeMerge(r, now))) return;
    const order = repairOnly
      ? group.order.filter((id) => id === repairOnly)
      : group.order;
    const consume = (id: string) => {
      group.order = group.order!.filter((candidate) => candidate !== id);
      this.store.set(key, group);
    };
    for (const id of [...order]) {
      const d = group.candidates.find((candidate) => candidate.issueId === id)!;
      if ([...this.active.values()].some((a) => a.job.issueId === id)) return;
      const issue = await this.linear.getIssue(id);
      const git = this.githubFactory(r);
      const pr = await git.pr(d.pr);
      if (pr.base !== r.branch || pr.state === "CLOSED" || pr.draft) {
        consume(id);
        continue;
      }
      if (pr.state === "MERGED") {
        const latest = await git.masterHealth();
        this.store.set(`health:${r.id}`, latest);
        await this.merged(r, issue, pr);
        this.store.set(`merge_observation:${r.id}`, { groupId: group.id });
        consume(id);
        return;
      }
      if (
        issue.state !== r.states.ready_to_merge ||
        this.skipIssue(issue, true)
      ) {
        consume(id);
        continue;
      }
      if (pr.head !== d.head) {
        this.returnMergeToLead(
          r,
          issue,
          `PR #${d.pr} head changed after merge planning started. Lead must verify affected changes at ${pr.head} and return to ${r.states.review}.`,
        );
        consume(id);
        continue;
      }
      if (pr.mergeable === "CONFLICTING" || pr.checks === "failure") {
        this.returnMergeToLead(
          r,
          issue,
          pr.mergeable === "CONFLICTING"
            ? `PR #${d.pr} conflicts with ${r.branch}. Lead must resolve conflicts in the existing branch/PR and verify affected changes before returning to ${r.states.review}.`
            : `PR #${d.pr} CI failed on ${pr.head}; Lead must inspect and repair the failure in the existing branch/PR.`,
        );
        consume(id);
        continue;
      }
      if (pr.mergeable !== "MERGEABLE" || pr.checks !== "success") return;
      if (!(await this.dependenciesReady(issue, r))) return;
      const isRepair = id === repairId;
      const current = this.store.get<Health>(`health:${r.id}`)!;
      if (
        current.status !== "success" &&
        !(current.status === "failure" && isRepair)
      )
        return;
      const latest = await git.masterHealth();
      this.store.set(`health:${r.id}`, latest);
      if (
        latest.status !== "success" &&
        !(latest.status === "failure" && isRepair)
      )
        return;
      if (latest.sha !== current.sha) return;
      if (this.dispatchStopped(r.id)) return;
      await git.merge(d.pr, d.head);
      const merged = await git.pr(d.pr);
      if (merged.state !== "MERGED")
        throw new Error("Merge command returned without confirmed merge");
      await this.merged(r, issue, merged);
      this.store.set(`merge_observation:${r.id}`, {
        groupId: group.id,
        previousSha: latest.sha,
      });
      consume(id);
      this.store.set(`health:${r.id}`, { sha: "", status: "pending" });
      return;
    }
    if (
      !group.order.length &&
      (!ownsObservation() || (await this.observeMerge(r, now)))
    )
      finish();
  }
  private async merged(r: Repo, issue: LinearIssue, pr: PrInfo) {
    if (pr.state !== "MERGED" || pr.base !== r.branch)
      throw new Error(
        "Merged PR does not target the configured integration branch",
      );

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
      this.dispatchStopped(r.id) ||
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
