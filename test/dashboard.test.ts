import assert from "node:assert/strict";
import test from "node:test";
import { startDashboard, type DashboardSnapshot } from "../src/dashboard.js";

test("dashboard serves anonymous read-only views and closes its listener", async () => {
  let reads = 0;
  const snapshot: DashboardSnapshot = {
    updatedAt: "2026-11-09T00:00:00Z",
    projects: [],
  };
  const dashboard = await startDashboard(
    { enabled: true, host: "127.0.0.1", port: 0 },
    () => {
      reads++;
      return snapshot;
    },
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
  );
  t.after(() => dashboard.close());
  const response = await fetch(`${dashboard.url}/api/status`);
  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Dashboard status unavailable");
});
