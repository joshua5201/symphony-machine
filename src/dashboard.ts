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
  column:
    | "todo"
    | "in_progress"
    | "review"
    | "ready_to_merge"
    | "blocked"
    | "done"
    | "other";
  state: string | null;
  needsHumanReview: boolean;
  noAutoPickupLabel: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
  blockedAt: string | null;
};

export type DashboardSnapshot = {
  updatedAt: string;
  paused: boolean;
  activeAgents: number;
  stopping: boolean;
  projects: {
    id: string;
    name: string;
    repository: string;
    paused: boolean;
    effectivePaused: boolean;
    activeAgents: number;
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
  control: (repo: string, paused: boolean) => void,
) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    const path = request.url?.split("?")[0];
    if (path === "/api/control") {
      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST" });
        response.end("Use POST for runner controls");
        return;
      }
      // Custom-header JSON requests cannot be sent by cross-origin forms or
      // scripts without a CORS preflight, which this listener does not allow.
      if (
        request.headers["x-symphony-control"] !== "1" ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        response.writeHead(403);
        response.end("Same-origin runner control required");
        return;
      }
      if (
        request.headers["content-type"]?.split(";")[0].trim() !==
        "application/json"
      ) {
        response.writeHead(415);
        response.end("JSON required");
        return;
      }
      let input: unknown;
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) {
            response.writeHead(413);
            response.end("Control request too large");
            return;
          }
        }
        input = JSON.parse(body);
      } catch {
        response.writeHead(400);
        response.end("Invalid control request");
        return;
      }
      if (
        input === null ||
        typeof input !== "object" ||
        !("repo" in input) ||
        typeof input.repo !== "string" ||
        !("paused" in input) ||
        typeof input.paused !== "boolean"
      ) {
        response.writeHead(400);
        response.end("Repository and pause flag required");
        return;
      }
      try {
        const current = snapshot();
        if (
          input.repo !== "all" &&
          !current.projects.some((r) => r.id === input.repo)
        ) {
          response.writeHead(400);
          response.end("Unknown repository");
          return;
        }
        if (current.stopping) {
          response.writeHead(409);
          response.end("Runner is stopping");
          return;
        }
        control(input.repo, input.paused);
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(JSON.stringify(snapshot()));
      } catch {
        response.writeHead(500);
        response.end("Runner control unavailable");
      }
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end("Method not allowed");
      return;
    }
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
