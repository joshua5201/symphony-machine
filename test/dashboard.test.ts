import assert from "node:assert/strict";
import test from "node:test";
import { startDashboard, type DashboardSnapshot } from "../src/dashboard.js";

test("dashboard serves anonymous views and closes its listener", async () => {
  let reads = 0;
  const snapshot: DashboardSnapshot = {
    updatedAt: "2026-11-09T00:00:00Z",
    paused: false,
    activeAgents: 0,
    stopping: false,
    projects: [],
  };
  const dashboard = await startDashboard(
    { enabled: true, host: "127.0.0.1", port: 0 },
    () => {
      reads++;
      return snapshot;
    },
    () => assert.fail("Reading the dashboard must not control work"),
  );
  try {
    const page = await fetch(dashboard.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    assert.match(await page.text(), /Symphony/);
    const status = await fetch(`${dashboard.url}/api/status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.deepEqual(await status.json(), snapshot);
    snapshot.projects.push({
      id: "second",
      name: "Second",
      repository: "demo/second",
      paused: false,
      effectivePaused: false,
      activeAgents: 0,
      ticketsUpdatedAt: null,
      ticketsStale: true,
      tickets: [],
      maintenance: [],
    });
    assert.deepEqual(
      await (await fetch(`${dashboard.url}/api/status`)).json(),
      snapshot,
    );
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const response = await fetch(`${dashboard.url}/api/status`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
      await response.text();
    }
    const missing = await fetch(`${dashboard.url}/pause`);
    assert.equal(missing.status, 404);
    await missing.text();
    const head = await fetch(dashboard.url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(reads, 2, "rejected requests never invoke the data reader");
  } finally {
    await dashboard.close();
  }
  await assert.rejects(fetch(dashboard.url));
});

test("dashboard status failures return an error without exposing private details", async (t) => {
  const dashboard = await startDashboard(
    { enabled: true, host: "127.0.0.1", port: 0 },
    () => {
      throw new Error("private runtime path and credentials");
    },
    () => assert.fail("Reading status must not control work"),
  );
  t.after(() => dashboard.close());
  const response = await fetch(`${dashboard.url}/api/status`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Dashboard status unavailable");
});

test("dashboard controls validate requests and return the updated runner snapshot", async (t) => {
  const snapshot: DashboardSnapshot = {
    updatedAt: "2026-11-11T00:00:00Z",
    paused: false,
    activeAgents: 1,
    stopping: false,
    projects: [
      {
        id: "demo",
        name: "demo",
        repository: "demo/repo",
        paused: false,
        effectivePaused: false,
        activeAgents: 1,
        ticketsUpdatedAt: null,
        ticketsStale: true,
        tickets: [],
        maintenance: [],
      },
    ],
  };
  const changes: { repo: string; paused: boolean }[] = [];
  const dashboard = await startDashboard(
    { enabled: true, host: "127.0.0.1", port: 0 },
    () => snapshot,
    (repo, paused) => {
      changes.push({ repo, paused });
      if (repo === "all") snapshot.paused = paused;
      else snapshot.projects[0].paused = paused;
      snapshot.projects[0].effectivePaused =
        snapshot.paused || snapshot.projects[0].paused;
    },
  );
  t.after(() => dashboard.close());
  const headers = {
    "Content-Type": "application/json",
    "X-Symphony-Control": "1",
  };
  for (const repo of ["demo", "all"]) {
    for (const paused of [true, false]) {
      const response = await fetch(`${dashboard.url}/api/control`, {
        method: "POST",
        headers,
        body: JSON.stringify({ repo, paused }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), snapshot);
      assert.deepEqual(changes.at(-1), { repo, paused });
    }
  }
  for (const body of [
    "{",
    "null",
    "[]",
    '{"repo":"demo"}',
    '{"repo":"demo","paused":"true"}',
    '{"repo":"unknown","paused":true}',
  ]) {
    const response = await fetch(`${dashboard.url}/api/control`, {
      method: "POST",
      headers,
      body,
    });
    assert.equal(response.status, 400);
    await response.text();
  }
  const form = await fetch(`${dashboard.url}/api/control`, {
    method: "POST",
    body: "repo=all&paused=true",
  });
  assert.equal(form.status, 403);
  await form.text();
  const foreign = await fetch(`${dashboard.url}/api/control`, {
    method: "POST",
    headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
    body: '{"repo":"all","paused":true}',
  });
  assert.equal(foreign.status, 403);
  await foreign.text();
  const wrongType = await fetch(`${dashboard.url}/api/control`, {
    method: "POST",
    headers: { "X-Symphony-Control": "1" },
    body: "{}",
  });
  assert.equal(wrongType.status, 415);
  await wrongType.text();
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]) {
    const response = await fetch(`${dashboard.url}/api/control`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    await response.text();
  }
  snapshot.stopping = true;
  const stopping = await fetch(`${dashboard.url}/api/control`, {
    method: "POST",
    headers,
    body: '{"repo":"all","paused":false}',
  });
  assert.equal(stopping.status, 409);
  await stopping.text();
  assert.equal(
    changes.length,
    4,
    "rejected requests never change runner state",
  );
});
