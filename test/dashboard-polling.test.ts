import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardPage } from "../src/dashboard-page.js";

interface StatusResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

interface PageNode {
  children: PageNode[];
  firstElementChild: null;
  dataset: Record<string, string>;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  listeners: Map<string, () => void>;
  append(...nodes: PageNode[]): void;
  setAttribute(): void;
  addEventListener(type: string, listener: () => void): void;
}

function pageNode(): PageNode {
  return {
    children: [],
    firstElementChild: null,
    dataset: {} as Record<string, string>,
    textContent: "",
    hidden: false,
    disabled: false,
    listeners: new Map<string, () => void>(),
    append(...nodes: PageNode[]) {
      this.children.push(...nodes);
    },
    setAttribute() {},
    addEventListener(type: string, listener: () => void) {
      this.listeners.set(type, listener);
    },
  };
}

function pollingPage(initiallyHidden = false) {
  let now = 0;
  let nextTimerId = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const requests: {
    url: string;
    options: {
      signal: AbortSignal;
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
    resolve(response: StatusResponse): void;
  }[] = [];
  const visibilityListeners: (() => void)[] = [];
  const nodes = new Map();
  for (const id of [
    "project-tabs",
    "projects",
    "page-empty",
    "connection",
    "connection-label",
    "connection-detail",
    "runner-control",
    "control-error",
  ]) {
    nodes.set(id, pageNode());
  }
  const document = {
    hidden: initiallyHidden,
    activeElement: null,
    createElement: () => pageNode(),
    getElementById: (id: string) => nodes.get(id),
    addEventListener: (_type: string, listener: () => void) =>
      visibilityListeners.push(listener),
  };
  const script = dashboardPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInNewContext(script, {
    document,
    AbortController,
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimerId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    fetch: (
      url: string,
      options: {
        signal: AbortSignal;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      },
    ) =>
      new Promise<StatusResponse>((resolve, reject) => {
        requests.push({ url, options, resolve });
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("Request timed out")),
          { once: true },
        );
      }),
  });

  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    requests,
    get control() {
      return nodes.get("runner-control").children[0];
    },
    get error() {
      return nodes.get("control-error");
    },
    get requestCount() {
      return requests.length;
    },
    async respond(ok = true, data: Record<string, unknown> = {}) {
      requests.at(-1)!.resolve({
        ok,
        json: async () => ({
          updatedAt: "2026-11-11T00:00:00Z",
          paused: false,
          activeAgents: 0,
          stopping: false,
          projects: [],
          ...data,
        }),
      });
      await settled();
    },
    async elapse(milliseconds: number) {
      const until = now + milliseconds;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await settled();
      }
      now = until;
    },
    setHidden(hidden: boolean) {
      document.hidden = hidden;
      for (const listener of visibilityListeners) listener();
    },
  };
}

test("dashboard waits 30 seconds after a status response before polling again", async () => {
  const page = pollingPage();
  assert.equal(page.requestCount, 1);
  await page.elapse(6_000);
  assert.equal(page.requestCount, 1);
  await page.respond();
  await page.elapse(29_999);
  assert.equal(page.requestCount, 1);
  await page.elapse(1);
  assert.equal(page.requestCount, 2);
});

test("dashboard pause controls submit the desired state, disable duplicate clicks, and show failures", async () => {
  const page = pollingPage();
  await page.respond();
  const [state, button] = page.control.children as ReturnType<
    typeof pageNode
  >[];
  assert.equal(button.disabled, false);
  button.listeners.get("click")!();
  assert.equal(button.disabled, true);
  button.listeners.get("click")!();
  const request = page.requests.at(-1)!;
  assert.equal(page.requestCount, 2);
  assert.equal(request.url, "/api/control");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers?.["X-Symphony-Control"], "1");
  assert.deepEqual(JSON.parse(request.options.body!), {
    repo: "all",
    paused: true,
  });
  await page.respond(true, { paused: true });
  assert.match(state.textContent, /已暫停/);
  assert.match(button.textContent, /解除全域暫停/);
  // Finish the immediate status refresh before requesting resume.
  await page.respond(true, { paused: true });
  button.listeners.get("click")!();
  assert.deepEqual(JSON.parse(page.requests.at(-1)!.options.body!), {
    repo: "all",
    paused: false,
  });
  await page.respond(false);
  assert.equal(page.error.hidden, false);
  assert.match(page.error.textContent, /尚未確認/);
  assert.match(
    state.textContent,
    /已暫停/,
    "failed requests do not claim the control succeeded",
  );
  await page.respond();
  assert.equal(button.disabled, false);
});

test("dashboard backs off failed status requests, caps the delay, and resets after recovery", async () => {
  const page = pollingPage();
  for (const delay of [
    60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
  ]) {
    const before = page.requestCount;
    await page.respond(false);
    await page.elapse(delay - 1);
    assert.equal(page.requestCount, before);
    await page.elapse(1);
    assert.equal(page.requestCount, before + 1);
  }
  await page.respond();
  await page.elapse(30_000);
  const recovered = page.requestCount;
  await page.respond(false);
  await page.elapse(59_999);
  assert.equal(page.requestCount, recovered);
  await page.elapse(1);
  assert.equal(page.requestCount, recovered + 1);
});

test("dashboard pauses while hidden and resumes immediately without overlapping requests", async () => {
  const page = pollingPage(true);
  await page.elapse(60_000);
  assert.equal(page.requestCount, 0);
  page.setHidden(false);
  assert.equal(page.requestCount, 1);
  await page.respond();
  page.setHidden(true);
  await page.elapse(60_000);
  assert.equal(page.requestCount, 1);
  page.setHidden(false);
  assert.equal(page.requestCount, 2);
  page.setHidden(true);
  page.setHidden(false);
  assert.equal(page.requestCount, 2);
  await page.respond();
  await page.elapse(30_000);
  assert.equal(page.requestCount, 3);
});
