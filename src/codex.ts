import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface AgentResult {
  decision:
    | "review"
    | "ready_to_merge"
    | "needs_changes"
    | "needs_human"
    | "blocked"
    | "done";
  summary: string;
  prNumber?: number;
  issueIds?: string[];
}

export interface RunInput {
  threadId?: string;
  title?: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  outputFormat?: "text" | "json";
  skills?: Array<{ name: string; path: string }>;
  config?: Record<string, unknown>;
  developerInstructions?: string;
  writableRoots?: string[];
  signal?: AbortSignal;
  onThread?: (id: string) => void;
}

export interface RunResult {
  threadId: string;
  outcome: "completed" | "blocked" | "failed" | "interrupted";
  result?: AgentResult;
  text?: string;
  error?: string;
}

const decisions = [
  "review",
  "ready_to_merge",
  "needs_changes",
  "needs_human",
  "blocked",
  "done",
];
// All fields are required on the wire because strict structured output uses
// nullable fields for optional values. The public result omits null values.
const outputSchema = {
  type: "object",
  properties: {
    decision: { type: "string", enum: decisions },
    summary: { type: "string" },
    prNumber: { type: ["integer", "null"], minimum: 1 },
    issueIds: { type: ["array", "null"], items: { type: "string" } },
  },
  required: ["decision", "summary", "prNumber", "issueIds"],
  additionalProperties: false,
};

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseResult(text: string): AgentResult {
  const value = object(JSON.parse(text));
  if (
    !decisions.includes(String(value.decision)) ||
    typeof value.summary !== "string" ||
    (value.prNumber != null &&
      (!Number.isInteger(value.prNumber) || Number(value.prNumber) < 1)) ||
    (value.issueIds != null &&
      (!Array.isArray(value.issueIds) ||
        !value.issueIds.every((id) => typeof id === "string")))
  ) {
    throw new Error("Codex returned an invalid structured result");
  }
  return {
    decision: value.decision as AgentResult["decision"],
    summary: value.summary,
    ...(value.prNumber == null ? {} : { prNumber: value.prNumber as number }),
    ...(value.issueIds == null ? {} : { issueIds: value.issueIds as string[] }),
  };
}

interface ActiveRun {
  threadId: string;
  outputFormat: "text" | "json";
  turnId?: string;
  messages: Map<string, { text: string; phase?: string }>;
  completion: Promise<RunResult>;
  resolve: (result: RunResult) => void;
  settled: boolean;
  stop?: { outcome: "blocked" | "interrupted"; error: string };
  interrupting?: Promise<void>;
}

/** A single stdio app-server connection; independent threads can run concurrently. */
export class CodexRunner {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private fatal?: Error;
  private exited?: Promise<void>;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly active = new Map<string, ActiveRun>();

  constructor(
    private readonly options: {
      command: string;
      args: string[];
      onEvent?: (event: unknown) => void;
      requestTimeoutMs?: number;
    },
  ) {}

  get failure(): string | undefined {
    return this.fatal?.message;
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Codex runner is closed"));
    if (this.fatal) return Promise.reject(this.fatal);
    this.starting ??= this.initialize();
    return this.starting;
  }

  async mcpStatus(): Promise<
    { name: string; authStatus: string; toolCount: number }[]
  > {
    await this.start();
    const servers: { name: string; authStatus: string; toolCount: number }[] =
      [];
    let cursor: string | undefined;
    do {
      const page = object(
        await this.request("mcpServerStatus/list", {
          ...(cursor ? { cursor } : {}),
          limit: 100,
          detail: "toolsAndAuthOnly",
        }),
      );
      if (!Array.isArray(page.data))
        throw new Error("Codex returned an invalid MCP status page");
      for (const entry of page.data) {
        const server = object(entry);
        if (
          typeof server.name !== "string" ||
          typeof server.authStatus !== "string"
        )
          throw new Error("Codex returned an invalid MCP server status");
        servers.push({
          name: server.name,
          authStatus: server.authStatus,
          toolCount: Object.keys(object(server.tools)).length,
        });
      }
      cursor =
        typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    return servers;
  }

  private async initialize(): Promise<void> {
    // Let Codex own its existing OAuth credentials and MCP configuration.
    // Never read auth.json or supply copied tokens to the child process.
    const child = spawn(this.options.command, this.options.args, {
      stdio: "pipe",
    });
    this.child = child;
    this.exited = new Promise((resolve) =>
      child.once("close", () => resolve()),
    );
    child.on("error", (error) => this.fail(error));
    child.on("close", (code, signal) =>
      this.fail(new Error(`Codex app-server exited (${signal ?? code})`)),
    );
    child.stdin.on("error", (error) => this.fail(error));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => this.emit({ type: "stderr", text }));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        this.receive(object(JSON.parse(line)));
      } catch (error) {
        this.fail(
          new Error(`Invalid app-server message: ${errorMessage(error)}`),
        );
      }
    });
    try {
      await this.request("initialize", {
        clientInfo: {
          name: "symphony_machine",
          title: "Symphony Machine",
          version: "0.1.0",
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.send({ method: "initialized", params: {} });
      const account = object(
        await this.request("account/read", { refreshToken: false }),
      );
      if (object(account.account).type !== "chatgpt") {
        throw new Error(
          "ChatGPT sign-in is required. Run codex login in your terminal first.",
        );
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async run(input: RunInput): Promise<RunResult> {
    let threadId = input.threadId ?? "";
    let subscribed = false;
    let active: ActiveRun | undefined;
    let abort: (() => void) | undefined;
    try {
      if (input.signal?.aborted)
        return { threadId, outcome: "interrupted", error: "Run was aborted" };
      await this.start();
      if (input.threadId && this.active.has(input.threadId))
        throw new Error(`A run is already active on thread ${input.threadId}`);
      const threadResponse = object(
        await this.request(input.threadId ? "thread/resume" : "thread/start", {
          ...(input.threadId
            ? { threadId: input.threadId, excludeTurns: true }
            : {}),
          cwd: input.cwd,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          ...(input.model ? { model: input.model } : {}),
          ...(input.config ? { config: input.config } : {}),
          ...(input.developerInstructions
            ? { developerInstructions: input.developerInstructions }
            : {}),
        }),
      );
      const thread = object(threadResponse.thread);
      if (typeof thread.id !== "string")
        throw new Error("Codex did not return a thread ID");
      threadId = thread.id;
      if (this.active.has(threadId))
        throw new Error(`A run is already active on thread ${threadId}`);
      subscribed = true;
      if (threadResponse.approvalsReviewer !== "auto_review")
        throw new Error(
          "Codex automatic approval review is unavailable; cannot run unattended.",
        );
      input.onThread?.(threadId);
      if (input.signal?.aborted)
        return { threadId, outcome: "interrupted", error: "Run was aborted" };
      if (!input.threadId && input.title)
        await this.request("thread/name/set", { threadId, name: input.title });
      if (input.signal?.aborted)
        return { threadId, outcome: "interrupted", error: "Run was aborted" };
      let resolve!: (result: RunResult) => void;
      const completion = new Promise<RunResult>((done) => {
        resolve = done;
      });
      active = {
        threadId,
        outputFormat: input.outputFormat ?? "json",
        messages: new Map(),
        completion,
        resolve,
        settled: false,
      };
      this.active.set(threadId, active);
      const current = active;
      abort = () => {
        void this.stop(current, "interrupted", "Run was aborted");
      };
      input.signal?.addEventListener("abort", abort, { once: true });
      const response = object(
        await this.request("turn/start", {
          threadId,
          cwd: input.cwd,
          approvalPolicy: "on-request",
          approvalsReviewer: "auto_review",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [
              ...new Set([input.cwd, ...(input.writableRoots ?? [])]),
            ],
            networkAccess: true,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          input: [
            { type: "text", text: input.prompt },
            ...(input.skills ?? []).map((skill) => ({ type: "skill", ...skill })),
          ],
          ...(input.model ? { model: input.model } : {}),
          ...(input.reasoning ? { effort: input.reasoning } : {}),
          ...(current.outputFormat === "json" ? { outputSchema } : {}),
        }),
      );
      const turn = object(response.turn);
      if (typeof turn.id !== "string")
        throw new Error("Codex did not return a turn ID");
      current.turnId = turn.id;
      if (current.stop) await this.interrupt(current);
      else if (turn.status !== "inProgress") this.complete(current, turn);
      return await completion;
    } catch (error) {
      const result: RunResult = {
        threadId,
        outcome: active?.stop?.outcome ?? "failed",
        error: active?.stop?.error ?? errorMessage(error),
      };
      if (active) this.finish(active, result);
      return result;
    } finally {
      if (abort) input.signal?.removeEventListener("abort", abort);
      // A completed turn remains loaded (and holds its writer lock) until the
      // connection unsubscribes. Keep the history available for later resume.
      if (subscribed && !this.closed && !this.fatal) {
        try {
          await this.request("thread/unsubscribe", { threadId });
        } catch (error) {
          // Preserve the turn's result, but stop dispatching through a server
          // that failed to release ownership. Normal shutdown releases locks.
          this.fail(
            new Error(
              `Could not release Codex thread ${threadId}: ${errorMessage(error)}`,
            ),
          );
        }
      }
      if (active && this.active.get(threadId) === active)
        this.active.delete(threadId);
    }
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    await Promise.all(
      [...this.active.values()].map((run) =>
        this.stop(run, "interrupted", "Codex runner is closing"),
      ),
    );
    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (await this.waitForExit(1_000)) return;
    child.kill("SIGTERM");
    if (await this.waitForExit(1_000)) return;
    child.kill("SIGKILL");
    await this.waitForExit(1_000);
  }

  private async waitForExit(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exited!.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private emit(event: unknown): void {
    // A logging callback must not break protocol processing or orphan a turn.
    try {
      this.options.onEvent?.(event);
    } catch {
      /* observer only */
    }
  }

  private send(message: unknown): void {
    if (this.fatal) throw this.fatal;
    if (!this.child?.stdin.writable)
      throw new Error("Codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.fail(
          new Error(
            `Codex RPC ${method} timed out after ${this.options.requestTimeoutMs ?? 30_000}ms`,
          ),
        );
      }, this.options.requestTimeoutMs ?? 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private receive(message: ObjectValue): void {
    this.emit(message);
    if (typeof message.method === "string") {
      const params = object(message.params);
      const run =
        typeof params.threadId === "string"
          ? this.active.get(params.threadId)
          : undefined;
      if (message.id !== undefined) {
        this.serverRequest(message, run);
        return;
      }
      if (!run || run.settled) return;
      const turn = object(params.turn);
      const turnId =
        typeof params.turnId === "string" ? params.turnId : turn.id;
      if (run.turnId && turnId && run.turnId !== turnId) return;
      if (!run.turnId) {
        if (message.method !== "turn/started" || typeof turnId !== "string")
          return;
        run.turnId = turnId;
      }
      if (run.stop && run.turnId) void this.interrupt(run);
      if (
        message.method === "item/agentMessage/delta" &&
        typeof params.itemId === "string" &&
        typeof params.delta === "string"
      ) {
        const item = run.messages.get(params.itemId) ?? { text: "" };
        item.text += params.delta;
        run.messages.set(params.itemId, item);
      } else if (message.method === "item/completed") {
        this.recordMessage(run, object(params.item));
      } else if (message.method === "turn/completed") {
        this.complete(run, turn);
      }
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(
          new Error(
            String(object(message.error).message ?? "Codex RPC failed"),
          ),
        );
      else pending.resolve(message.result);
    }
  }

  private recordMessage(run: ActiveRun, item: ObjectValue): void {
    if (
      item.type === "agentMessage" &&
      typeof item.id === "string" &&
      typeof item.text === "string"
    ) {
      run.messages.set(item.id, {
        text: item.text,
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      });
    }
  }

  private complete(run: ActiveRun, turn: ObjectValue): void {
    if (run.stop) {
      this.finish(run, { threadId: run.threadId, ...run.stop });
      return;
    }
    if (turn.status !== "completed") {
      this.finish(run, {
        threadId: run.threadId,
        outcome: turn.status === "interrupted" ? "interrupted" : "failed",
        error: String(
          object(turn.error).message ?? `Codex turn ${String(turn.status)}`,
        ),
      });
      return;
    }
    if (Array.isArray(turn.items))
      for (const item of turn.items) this.recordMessage(run, object(item));
    const messages = [...run.messages.values()];
    const final =
      messages.findLast((item) => item.phase === "final_answer") ??
      messages.findLast((item) => item.phase === undefined);
    try {
      if (!final)
        throw new Error(
          run.outputFormat === "text"
            ? "Codex completed without a final message"
            : "Codex completed without a structured result",
        );
      this.finish(run, {
        threadId: run.threadId,
        outcome: "completed",
        ...(run.outputFormat === "text"
          ? { text: final.text }
          : { result: parseResult(final.text) }),
      });
    } catch (error) {
      this.finish(run, {
        threadId: run.threadId,
        outcome: "failed",
        error: errorMessage(error),
      });
    }
  }

  private serverRequest(message: ObjectValue, run?: ActiveRun): void {
    const method = String(message.method);
    const params = object(message.params);
    const reason = `${method} requires human input${typeof params.reason === "string" ? `: ${params.reason}` : ""}`;
    // Cancel/deny requests; never synthesize an approval or a human answer.
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.send({ id: message.id, result: { decision: "cancel" } });
    } else if (method === "item/permissions/requestApproval") {
      this.send({ id: message.id, result: { permissions: {}, scope: "turn" } });
    } else if (method === "mcpServer/elicitation/request") {
      this.send({
        id: message.id,
        result: { action: "cancel", content: null, _meta: null },
      });
    } else {
      this.send({
        id: message.id,
        error: {
          code: -32601,
          message: "Unattended client cannot answer this request",
        },
      });
    }
    const affected = run
      ? [run]
      : typeof params.threadId === "string"
        ? []
        : [...this.active.values()];
    for (const current of affected) {
      if (
        current.turnId &&
        typeof params.turnId === "string" &&
        current.turnId !== params.turnId
      )
        continue;
      if (typeof params.turnId === "string") current.turnId ??= params.turnId;
      void this.stop(current, "blocked", reason);
    }
  }

  private async stop(
    run: ActiveRun,
    outcome: "blocked" | "interrupted",
    error: string,
  ): Promise<void> {
    if (run.settled) return;
    run.stop ??= { outcome, error };
    if (run.turnId) await this.interrupt(run);
  }

  private interrupt(run: ActiveRun): Promise<void> {
    run.interrupting ??= (async () => {
      const timer = setTimeout(
        () =>
          this.fail(new Error("Codex did not finish interrupting the turn")),
        this.options.requestTimeoutMs ?? 30_000,
      );
      try {
        await this.request("turn/interrupt", {
          threadId: run.threadId,
          turnId: run.turnId,
        });
        // The RPC acknowledgement precedes the actual end of the turn. Wait
        // before allowing a caller to resume the same thread.
        await run.completion;
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      } finally {
        clearTimeout(timer);
      }
    })();
    return run.interrupting;
  }

  private finish(run: ActiveRun, result: RunResult): void {
    if (run.settled) return;
    run.settled = true;
    run.resolve(result);
  }

  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of this.active.values()) {
      this.finish(run, {
        threadId: run.threadId,
        outcome: run.stop?.outcome ?? "failed",
        error: run.stop?.error ?? error.message,
      });
    }
    this.child?.kill("SIGTERM");
  }
}
