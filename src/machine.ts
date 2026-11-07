import { randomUUID } from "node:crypto";
import type { Config, Repo } from "./config.js";
import { gitConfig, routing } from "./config.js";
import { GitHub, type PrInfo } from "./github.js";
import { CodexRunner } from "./codex.js";
import type { LinearClient, LinearIssue } from "./linear.js";
import { Store, type Job } from "./store.js";
import {
  contract,
  executionPrompt,
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
};
type Sync = {
  id: string;
  issueId: string;
  state?: string;
  labels?: string[];
  comment?: string;
};
export type Log = (event: string, details?: unknown) => void;
export class Machine {
  private active = new Map<
    string,
    { job: Job; abort: AbortController; promise: Promise<void> }
  >();
  private next = new Map<string, number>();
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
    if (
      c.data_dir !== this.config.data_dir ||
      JSON.stringify(c.codex) !== JSON.stringify(this.config.codex) ||
      JSON.stringify(c.linear) !== JSON.stringify(this.config.linear) ||
      JSON.stringify(c.repositories) !==
        JSON.stringify(this.config.repositories)
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
  }
  get activeCount() {
    return this.active.size;
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
  private count(role: Job["role"]) {
    return [...this.active.values()].filter((a) => a.job.role === role).length;
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
      if (this.paused(r.id)) continue;
      try {
        if (
          this.due(`${r.id}:health`, this.config.polling.master_ci_seconds, now)
        )
          await this.health(r);
        if (
          this.due(`${r.id}:github`, this.config.polling.github_seconds, now)
        ) {
          await this.cleanup(r);
          await this.merge(r);
        }
        if (this.due(`${r.id}:review`, this.config.polling.review_seconds, now))
          await this.reviews(r);
        if (this.due(`${r.id}:linear`, this.config.polling.linear_seconds, now))
          await this.executions(r);
        await this.maintenance(r, now);
      } catch (error) {
        this.log("poll_error", { repo: r.id, error: String(error) });
      }
    }
  }
  private launch(j: Job, fn: (signal: AbortSignal) => Promise<void>) {
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
        if (
          !abort.signal.aborted &&
          !this.runner.failure &&
          j.role !== "maintenance" &&
          j.role !== "merge"
        ) {
          const r = this.config.repositories.find((r) => r.id === j.repo)!;
          this.sync({
            issueId: j.issueId,
            state: r.states.blocked,
            comment: `Symphony could not continue: ${String(error)}\nResolve the cause, then move this issue to ${r.states.todo} or use the retry command.`,
          });
        }
      })
      .finally(() => {
        this.active.delete(j.id);
        this.log("job_finished", { job: j.id, status: j.status });
      });
    this.active.set(j.id, { job: j, abort, promise });
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
        if (
          !full.description.includes("[No PR required]") &&
          !this.store.get(`no_pr:${full.id}`)
        )
          return false;
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
      if (this.count("execution") >= c.concurrency.execution_tickets) break;
      const old = this.job(r.id, issue.id, "execution");
      if (old && this.active.has(old.id)) continue;
      const recovering =
        old?.status === "waiting" && issue.state === r.states.in_progress;
      if (issue.state !== r.states.todo && !recovering) continue;
      if (issue.labels.includes(c.linear.needs_human_label)) continue;
      if (old?.status === "failed" && old.fingerprint === issue.updatedAt)
        continue;
      if (old?.workspace && this.store.get(`cleaned:${old.id}`)) continue;
      if (!(await this.dependenciesReady(issue, r))) continue;
      const j = old ?? this.create(r, issue, "execution");
      j.fingerprint = issue.updatedAt;
      if (!recovering) {
        j.phase = "plan";
        j.handoff = undefined;
        j.workerSummary = undefined;
      }
      this.launch(j, async (signal) => {
        const route = routing(c, issue.labels);
        const git = this.githubFactory(r);
        if (!j.workspace) j.workspace = await git.prepare(issue.identifier);
        this.store.save(j);
        await this.linear.updateIssue(issue.id, {
          state: r.states.in_progress,
        });
        while (true) {
          const worker = route.mode === "delegated" && j.phase === "implement";
          const settings = worker ? route.implementation : route.lead;
          const response = await this.runner.run({
            threadId: worker ? j.workerThreadId : j.threadId,
            title: `${issue.identifier} · ${worker ? "Implementation" : "Lead"}`,
            cwd: j.workspace.path,
            developerInstructions: contract(c, r),
            prompt: executionPrompt(c, r, issue, j, route.mode),
            ...settings,
            signal,
            onThread: (id) => {
              if (worker) j.workerThreadId = id;
              else j.threadId = id;
              this.store.save(j);
            },
          });
          if (response.outcome === "interrupted") {
            j.status = "waiting";
            this.store.save(j);
            return;
          }
          if (response.outcome !== "completed" || !response.result)
            throw new Error(response.error ?? `Agent ${response.outcome}`);
          const result = response.result;
          j.summary = result.summary;
          if (
            result.decision === "blocked" ||
            result.decision === "needs_human"
          ) {
            j.status = "blocked";
            this.sync({
              issueId: issue.id,
              state: r.states.blocked,
              comment: result.summary,
            });
            break;
          }
          if (
            !worker &&
            result.decision === "done" &&
            issue.id === this.store.get(`repair:${r.id}`)
          ) {
            const health = await git.masterHealth();
            if (health.status !== "success")
              throw new Error(
                "CI-only repair completion requires confirmed healthy target CI",
              );
            this.store.set(`health:${r.id}`, health);
            this.store.set(`no_pr:${issue.id}`, true);
            j.status = "done";
            this.sync({
              issueId: issue.id,
              state: r.states.done,
              comment: `Target CI recovered without a PR. ${result.summary}\nDiagnostic worktree retained; no unmerged work was deleted.`,
            });
            break;
          }
          if (route.mode === "delegated" && j.phase === "plan") {
            if (result.decision !== "implement" || !result.handoff)
              throw new Error("Lead did not return an implementation handoff");
            j.handoff = result.handoff;
            j.phase = "implement";
            this.store.save(j);
            continue;
          }
          if (worker) {
            if (result.decision !== "review" && result.decision !== "done")
              throw new Error("Implementation did not report completion");
            j.workerSummary = result.summary;
            j.phase = "verify";
            this.store.save(j);
            continue;
          }
          if (result.decision !== "review")
            throw new Error(
              `Execution must publish reviewable work, got ${result.decision}`,
            );
          const pr = result.prNumber
            ? await git.pr(result.prNumber)
            : await git.findPr(j.workspace.branch);
          if (
            !pr ||
            pr.branch !== j.workspace.branch ||
            pr.base !== r.branch ||
            pr.state !== "OPEN"
          )
            throw new Error(
              "Execution did not produce its own open PR targeting the configured branch",
            );
          j.prNumber = pr.number;
          j.status = "done";
          this.sync({
            issueId: issue.id,
            state: r.states.review,
            comment: `Ready for review: ${pr.url}\n${result.summary}`,
          });
          break;
        }
        this.store.save(j);
      });
    }
  }
  private async reviews(r: Repo) {
    const issues = await this.linear.listIssues({
      team: r.team,
      project: r.project,
      state: r.states.review,
    });
    for (const issue of issues) {
      if (
        this.count("review") + this.count("merge") >=
        this.config.concurrency.reviews
      )
        break;
      if (issue.labels.includes(this.config.linear.needs_human_label)) continue;
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
      const pr = await this.githubFactory(r).pr(number);
      if (pr.state !== "OPEN" || pr.base !== r.branch || pr.draft) continue;
      const old = this.job(r.id, issue.id, "review");
      const fingerprint = `${pr.head}:${pr.updatedAt}:${issue.updatedAt}`;
      if (old && (this.active.has(old.id) || old.fingerprint === fingerprint))
        continue;
      this.store.set(`merge:${r.id}:${issue.id}`, null);
      const j = old ?? this.create(r, issue, "review");
      j.fingerprint = fingerprint;
      j.prNumber = number;
      j.head = pr.head;
      this.launch(j, async (signal) => {
        const response = await this.runner.run({
          threadId: j.threadId,
          title: `${issue.identifier} · Review`,
          cwd: r.path,
          developerInstructions: contract(this.config, r),
          prompt: reviewPrompt(this.config, r, issue, number, pr.head),
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
        const current = await this.githubFactory(r).pr(number);
        const latestIssue = await this.linear.getIssue(issue.id);
        if (
          current.head !== pr.head ||
          latestIssue.description !== issue.description ||
          latestIssue.title !== issue.title ||
          latestIssue.state !== r.states.review
        ) {
          j.fingerprint = undefined;
          this.store.save(j);
          return;
        }
        j.fingerprint = `${current.head}:${current.updatedAt}:${latestIssue.updatedAt}`;
        if (result.decision === "ready_to_merge")
          this.store.set(`merge:${r.id}:${issue.id}`, {
            issueId: issue.id,
            pr: number,
            head: pr.head,
            summary: result.summary,
            updatedAt: latestIssue.updatedAt,
            prUpdatedAt: current.updatedAt,
          } satisfies Decision);
        else if (result.decision === "needs_human")
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
      });
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
    const candidates = this.store
      .jobs()
      .filter(
        (j) => j.repo === r.id && j.role === "review" && j.status === "done",
      )
      .map((j) => ({
        job: j,
        decision: this.store.get<Decision | null>(`merge:${r.id}:${j.issueId}`),
      }))
      .filter((x) => x.decision);
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
        this.count("merge") + this.count("review") >=
        this.config.concurrency.reviews
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
          prompt: `${contract(this.config, r)}\nYou are the merge coordinator. Decide which approved candidates should merge this round and in which order. Read related Linear issues as needed. Prioritize CI repair, dependencies and product priorities; avoid arbitrary style work. Do not merge or edit code. Return decision done and issueIds in merge order (a subset is permitted), with rationale in summary. Candidates: ${JSON.stringify(candidates.map((x) => x.decision))}`,
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
        issue.state !== r.states.review ||
        issue.labels.includes(this.config.linear.needs_human_label) ||
        !(await this.dependenciesReady(issue, r))
      )
        continue;
      const git = this.githubFactory(r);
      const pr = await git.pr(d.pr);
      if (pr.state === "MERGED") {
        await this.merged(r, issue, pr);
        continue;
      }
      if (
        pr.state !== "OPEN" ||
        pr.head !== d.head ||
        pr.updatedAt !== d.prUpdatedAt ||
        issue.updatedAt !== d.updatedAt
      ) {
        this.store.set(`merge:${r.id}:${issue.id}`, null);
        job.fingerprint = undefined;
        this.store.save(job);
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
    this.store.set(`merge:${r.id}:${issue.id}`, null);
    // An execution PR may have additional delivery requirements; reviewer must explicitly validate them.
    this.sync({
      issueId: issue.id,
      state: r.states.done,
      comment: `Merged ${pr.url}. Managed workspace cleanup will follow; CI health is monitored separately.`,
    });
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
        (j) =>
          j.repo === r.id &&
          j.role === "execution" &&
          j.workspace &&
          j.prNumber,
      )) {
      if ([...this.active.values()].some((a) => a.job.issueId === j.issueId))
        continue;
      if (this.store.get(`cleaned:${j.id}`)) continue;
      const git = this.githubFactory(r);
      const pr = await git.pr(j.prNumber!);
      if (pr.state !== "MERGED") continue;
      if (!this.store.get(`cleanup:${j.id}`)) {
        const issue = await this.linear.getIssue(j.issueId);
        await this.merged(r, issue, pr);
      }
      try {
        await git.cleanup(j.workspace!, j.prNumber!);
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
      this.count("maintenance") >= c.concurrency.maintenance_scans
    )
      return;
    if (
      c.maintenance.idle_only &&
      (this.count("execution") >= c.concurrency.execution_tickets ||
        this.count("review") + this.count("merge") > 0)
    )
      return;
    if (now < (this.store.get<number>(`maintenance_next:${r.id}`) ?? 0)) return;
    const j = this.create(
      r,
      { id: `maintenance:${r.id}`, identifier: `maintenance:${r.id}` },
      "maintenance",
    );
    this.store.set(
      `maintenance_next:${r.id}`,
      now + c.maintenance.interval_hours * 3600000,
    );
    this.launch(j, async (signal) => {
      const result = await this.runner.run({
        cwd: r.path,
        title: `${r.id} · Maintenance`,
        developerInstructions: contract(c, r),
        prompt: maintenancePrompt(c, r),
        ...c.codex.maintenance,
        signal,
        onThread: (id) => {
          j.threadId = id;
          this.store.save(j);
        },
      });
      if (result.outcome !== "completed" || result.result?.decision !== "done")
        throw new Error(
          result.error ?? result.result?.summary ?? "Maintenance failed",
        );
      j.status = "done";
      j.summary = result.result.summary;
      this.store.save(j);
    });
  }
}
