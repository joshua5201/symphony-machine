import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Config } from "./config.js";
import type { Job } from "./store.js";
import { dashboardPage } from "./dashboard-page.js";

export type DashboardTicket = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  mode: "Direct" | "Delegated" | null;
  role: "execution" | "review" | null;
  agentStatus: Job["status"] | null;
  resumeCommand: string | null;
  column: "todo" | "in_progress" | "review" | "blocked" | "done" | "other";
  state: string | null;
  needsHumanReview: boolean;
  startedAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
};

export type DashboardSnapshot = {
  updatedAt: string;
  projects: {
    id: string;
    name: string;
    repository: string;
    ticketsUpdatedAt: string | null;
    ticketsStale: boolean;
    tickets: DashboardTicket[];
    maintenance: {
      id: string;
      theme: string;
      status: Job["status"];
      summary: string | null;
      startedAt: string;
      updatedAt: string;
      from: string | null;
      to: string | null;
    }[];
  }[];
};

export async function startDashboard(
  options: Config["dashboard"],
  snapshot: () => DashboardSnapshot,
) {
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Read-only dashboard");
      return;
    }
    const path = request.url?.split("?")[0];
    if (path !== "/" && path !== "/api/status") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    try {
      const body = path === "/" ? dashboardPage : JSON.stringify(snapshot());
      response.writeHead(200, {
        "Content-Type":
          path === "/"
            ? "text/html; charset=utf-8"
            : "application/json; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Dashboard status unavailable");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.address.includes(":")
    ? `[${address.address}]`
    : address.address;
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
