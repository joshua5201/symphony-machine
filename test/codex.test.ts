import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexRunner } from "../src/codex.js";

// A real child with the documented newline-delimited app-server protocol. It
// exercises process I/O and cancellation without inference or credential access.
const server = String.raw`
  const readline = require('node:readline');
  const config = JSON.parse(process.argv[1]);
  let next = 1;
  const turns = new Map();
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const result = (message, value) => send({ id: message.id, result: value });
  const event = (method, params) => send({ method, params });
  const value = (summary) => JSON.stringify({ decision: 'review', summary, handoff: null, prNumber: 7, issueIds: ['M-1'] });
  const done = (threadId, turnId, status = 'completed', text = value(threadId)) => {
    event('item/completed', { threadId, turnId, item: { id: 'commentary', type: 'agentMessage', text: 'Working...', phase: 'commentary' } });
    event('item/agentMessage/delta', { threadId, turnId, itemId: 'final', delta: text.slice(0, 12) });
    event('item/agentMessage/delta', { threadId, turnId, itemId: 'final', delta: text.slice(12) });
    event('item/completed', { threadId, turnId, item: { id: 'final', type: 'agentMessage', text, phase: 'final_answer' } });
    event('turn/completed', { threadId, turn: { id: turnId, status, items: [], error: status === 'failed' ? { message: 'Inference failed' } : null } });
  };
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    event('mock/request', message);
    if (message.method === 'initialize') {
      if (!config.noInitialize) result(message, { userAgent: 'mock' });
    } else if (message.method === 'account/read') {
      result(message, { account: { type: config.accountType || 'chatgpt' }, requiresOpenaiAuth: true });
    } else if (message.method === 'mcpServerStatus/list') {
      result(message, message.params.cursor ? { data: [{ name: 'linear', authStatus: 'oAuth', tools: { get_issue: {}, list_issues: {} } }], nextCursor: null } : { data: [{ name: 'other', authStatus: 'notLoggedIn', tools: {} }], nextCursor: 'page-2' });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      result(message, { thread: { id: message.params.threadId || 'thread-' + next++ }, approvalsReviewer: config.reviewer || 'auto_review' });
    } else if (message.method === 'thread/name/set') {
      result(message, {});
    } else if (message.method === 'turn/start') {
      const threadId = message.params.threadId;
      const turnId = 'turn-' + threadId;
      turns.set(threadId, turnId);
      // Events can arrive before the response to turn/start.
      event('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      result(message, { turn: { id: turnId, status: 'inProgress', items: [] } });
      if (config.crash) process.exit(3);
      else if (config.approval && !message.params.input[0].text.includes('safe')) {
        send({ id: 'approval-1', method: config.approval, params: { threadId, turnId, itemId: 'exec', reason: 'Needs permission' } });
      } else if (!config.wait) {
        if (config.earlyCompletion) done(threadId, turnId);
        else setTimeout(() => done(threadId, turnId, config.status || 'completed', config.invalid ? '{"decision":"oops"}' : value(threadId)), threadId === 'thread-1' ? 15 : 1);
      }
    } else if (message.method === 'turn/interrupt') {
      result(message, {});
      setTimeout(() => event('turn/completed', { threadId: message.params.threadId, turn: { id: message.params.turnId, status: 'interrupted', items: [] } }), config.delayInterrupt || 0);
    }
  });
`;

function setup(config: Record<string, unknown> = {}, requestTimeoutMs = 2_000) {
  const events: Record<string, unknown>[] = [];
  const runner = new CodexRunner({
    command: process.execPath,
    args: ["-e", server, JSON.stringify(config)],
    requestTimeoutMs,
    onEvent: (event) => {
      events.push(event as Record<string, unknown>);
    },
  });
  const requests = () =>
    events
      .filter((event) => event.method === "mock/request")
      .map((event) => event.params as Record<string, unknown>);
  return { runner, events, requests };
}

test("initializes managed ChatGPT auth, streams separate concurrent threads, and resumes a thread", async (t) => {
  const { runner, events, requests } = setup();
  t.after(() => runner.close());
  const ids: string[] = [];
  const [a, b] = await Promise.all([
    runner.run({
      cwd: "/tmp/a",
      prompt: "first",
      title: "M-1 Lead",
      model: "my-model",
      reasoning: "xhigh",
      developerInstructions: "Use Linear",
      writableRoots: ["/tmp/repo/.git"],
      onThread: (id) => ids.push(id),
    }),
    runner.run({ cwd: "/tmp/b", prompt: "second" }),
  ]);
  assert.equal(a.outcome, "completed");
  assert.equal(b.outcome, "completed");
  assert.notEqual(a.threadId, b.threadId);
  assert.equal(a.result?.summary, a.threadId);
  assert.equal(b.result?.summary, b.threadId);
  assert.deepEqual(a.result, {
    decision: "review",
    summary: a.threadId,
    prNumber: 7,
    issueIds: ["M-1"],
  });
  assert.equal(ids[0], a.threadId);
  assert.ok(events.some((event) => event.method === "item/agentMessage/delta"));
  const calls = requests();
  assert.deepEqual(
    calls.slice(0, 3).map((call) => call.method),
    ["initialize", "initialized", "account/read"],
  );
  assert.equal(calls.filter((call) => call.method === "initialize").length, 1);
  const start = calls.find(
    (call) =>
      call.method === "turn/start" &&
      (call.params as Record<string, unknown>).threadId === a.threadId,
  )!;
  const params = start.params as Record<string, unknown>;
  assert.equal(params.model, "my-model");
  assert.equal(params.effort, "xhigh");
  assert.equal(params.approvalPolicy, "on-request");
  assert.equal(params.approvalsReviewer, "auto_review");
  assert.deepEqual(params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/tmp/a", "/tmp/repo/.git"],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  });
  assert.ok(params.outputSchema);
  const thread = calls.find((call) => call.method === "thread/start")!
    .params as Record<string, unknown>;
  assert.equal(thread.developerInstructions, "Use Linear");
  const resumed = await runner.run({
    threadId: a.threadId,
    title: "Should preserve user title",
    cwd: "/tmp/a",
    prompt: "continue",
  });
  assert.equal(resumed.outcome, "completed");
  assert.equal(resumed.threadId, a.threadId);
  assert.ok(
    requests().some(
      (call) =>
        call.method === "thread/resume" &&
        (call.params as Record<string, unknown>).excludeTurns === true,
    ),
  );
  assert.deepEqual(
    requests()
      .filter((call) => call.method === "thread/name/set")
      .map((call) => call.params),
    [{ threadId: a.threadId, name: "M-1 Lead" }],
  );
});

test("handles events already queued when turn/start resolves", async (t) => {
  const { runner } = setup({ earlyCompletion: true });
  t.after(() => runner.close());
  assert.equal(
    (await runner.run({ cwd: "/tmp", prompt: "work" })).outcome,
    "completed",
  );
});

test("cancels approval requests, reports blocked, and leaves another thread running", async (t) => {
  const { runner, requests } = setup({
    approval: "item/commandExecution/requestApproval",
  });
  t.after(() => runner.close());
  const [blocked, safe] = await Promise.all([
    runner.run({ cwd: "/tmp", prompt: "change" }),
    runner.run({ cwd: "/tmp", prompt: "safe" }),
  ]);
  assert.equal(blocked.outcome, "blocked");
  assert.match(blocked.error!, /requestApproval.*Needs permission/);
  assert.equal(safe.outcome, "completed");
  const reply = requests().find((call) => call.id === "approval-1")!;
  assert.deepEqual(reply.result, { decision: "cancel" });
  assert.ok(requests().some((call) => call.method === "turn/interrupt"));
});

test("does not grant permission requests", async (t) => {
  const { runner, requests } = setup({
    approval: "item/permissions/requestApproval",
  });
  t.after(() => runner.close());
  assert.equal(
    (await runner.run({ cwd: "/tmp", prompt: "permissions" })).outcome,
    "blocked",
  );
  assert.deepEqual(
    requests().find((call) => call.id === "approval-1")!.result,
    { permissions: {}, scope: "turn" },
  );
});

test("AbortSignal and shutdown interrupt active turns", async (t) => {
  const { runner, requests, events } = setup({
    wait: true,
    delayInterrupt: 15,
  });
  t.after(() => runner.close());
  const abort = new AbortController();
  const first = runner.run({
    cwd: "/tmp",
    prompt: "wait",
    signal: abort.signal,
  });
  // Wait for observable turn readiness, not a wall-clock guess.
  await until(() => requests().some((call) => call.method === "turn/start"));
  abort.abort();
  assert.equal((await first).outcome, "interrupted");
  assert.ok(events.some((event) => event.method === "turn/completed"));
  const second = runner.run({ cwd: "/tmp", prompt: "wait again" });
  await until(
    () =>
      requests().filter((call) => call.method === "turn/start").length === 2,
  );
  await runner.close();
  assert.equal((await second).outcome, "interrupted");
  assert.equal(
    requests().filter((call) => call.method === "turn/interrupt").length,
    2,
  );
});

test("rejects malformed structured output and preserves a failed turn status", async (t) => {
  const invalid = setup({ invalid: true });
  const failed = setup({ status: "failed" });
  t.after(() => Promise.all([invalid.runner.close(), failed.runner.close()]));
  const [badResult, badTurn] = await Promise.all([
    invalid.runner.run({ cwd: "/tmp", prompt: "work" }),
    failed.runner.run({ cwd: "/tmp", prompt: "work" }),
  ]);
  assert.equal(badResult.outcome, "failed");
  assert.match(badResult.error!, /invalid structured result/);
  assert.equal(badTurn.outcome, "failed");
  assert.equal(badTurn.error, "Inference failed");
});

test("RPC requests time out and process exit fails active work", async (t) => {
  const timeout = setup({ noInitialize: true }, 100);
  const crashed = setup({ crash: true });
  t.after(() => Promise.all([timeout.runner.close(), crashed.runner.close()]));
  const [noReply, exited] = await Promise.all([
    timeout.runner.run({ cwd: "/tmp", prompt: "work" }),
    crashed.runner.run({ cwd: "/tmp", prompt: "work" }),
  ]);
  assert.equal(noReply.outcome, "failed");
  assert.match(noReply.error!, /initialize timed out/);
  assert.equal(exited.outcome, "failed");
  assert.match(exited.error!, /exited \(3\)/);
  assert.equal(crashed.runner.failure, exited.error);
});

test("requires existing ChatGPT sign-in without initiating login", async (t) => {
  const { runner, requests } = setup({ accountType: "apiKey" });
  t.after(() => runner.close());
  const result = await runner.run({ cwd: "/tmp", prompt: "work" });
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /ChatGPT sign-in is required/);
  assert.ok(!requests().some((call) => call.method === "turn/start"));
});

test("returns paginated MCP connection metadata without credentials or tool schemas", async (t) => {
  const { runner, requests } = setup();
  t.after(() => runner.close());
  assert.deepEqual(await runner.mcpStatus(), [
    { name: "other", authStatus: "notLoggedIn", toolCount: 0 },
    { name: "linear", authStatus: "oAuth", toolCount: 2 },
  ]);
  assert.equal(
    requests().filter((call) => call.method === "mcpServerStatus/list").length,
    2,
  );
});

test("fails explicitly when automatic approval review is unavailable", async (t) => {
  const { runner, requests } = setup({ reviewer: "user" });
  t.after(() => runner.close());
  const result = await runner.run({ cwd: "/tmp", prompt: "work" });
  assert.equal(result.outcome, "failed");
  assert.match(result.error!, /automatic approval review is unavailable/);
  assert.ok(!requests().some((call) => call.method === "turn/start"));
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Mock turn did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
