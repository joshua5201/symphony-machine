import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { LinearClient } from "../src/linear.js";

type Json = Record<string, any>;
type ToolCall = { name: string; arguments: Json };
const tool = (name: string, properties: string[]): Tool => ({
  name,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(properties.map((key) => [key, {}])),
  },
});
const standardTools = () => [
  tool("list_issues", ["team", "project", "state", "limit", "cursor"]),
  tool("get_issue", ["id", "includeRelations"]),
  tool("save_issue", [
    "id",
    "team",
    "project",
    "title",
    "description",
    "state",
    "labels",
  ]),
  tool("save_comment", ["issueId", "body"]),
];

function issue(id: string): Json {
  return {
    id,
    identifier: `ENG-${id}`,
    title: `Issue ${id}`,
    description: null,
    status: "Todo",
    url: `https://linear.app/example/issue/ENG-${id}`,
    labels: [],
    updatedAt: "2026-11-07T00:00:00.000Z",
    relations: { blockedBy: [], blocks: [], relatedTo: [] },
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}
function json(response: ServerResponse, value: unknown, status = 200): void {
  response
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(value));
}

/** Exercise the real SDK HTTP/OAuth client against a deterministic local protocol fixture. */
async function fixture(
  options: {
    tools?: Tool[];
    call?: (call: ToolCall) => unknown;
    toolPages?: boolean;
  } = {},
) {
  const authDir = await mkdtemp(join(tmpdir(), "symphony-linear-test-"));
  const calls: ToolCall[] = [];
  const tokenRequests: URLSearchParams[] = [];
  const registrations: Json[] = [];
  let accessToken = "test-access-token";
  let url = "";
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", url).pathname;
      if (
        request.method === "GET" &&
        path.startsWith("/.well-known/oauth-protected-resource")
      ) {
        json(response, {
          resource: `${url}/mcp`,
          authorization_servers: [url],
          scopes_supported: ["read", "write"],
        });
        return;
      }
      if (
        request.method === "GET" &&
        path === "/.well-known/oauth-authorization-server"
      ) {
        json(response, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          registration_endpoint: `${url}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
          code_challenge_methods_supported: ["S256"],
        });
        return;
      }
      if (path === "/register") {
        const metadata = JSON.parse(await body(request));
        registrations.push(metadata);
        json(response, { ...metadata, client_id: "fixture-client" }, 201);
        return;
      }
      if (path === "/token") {
        tokenRequests.push(new URLSearchParams(await body(request)));
        json(response, {
          access_token: accessToken,
          refresh_token: "test-refresh-token",
          token_type: "Bearer",
        });
        return;
      }
      if (path !== "/mcp") {
        response.writeHead(404).end();
        return;
      }
      if (request.headers.authorization !== `Bearer ${accessToken}`) {
        response
          .writeHead(401, {
            "WWW-Authenticate": `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource/mcp"`,
          })
          .end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const message = JSON.parse(await body(request));
      if (!Object.hasOwn(message, "id")) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "linear-fixture", version: "1" },
        };
      } else if (message.method === "tools/list") {
        const tools = options.tools ?? standardTools();
        result = options.toolPages
          ? message.params?.cursor
            ? { tools: tools.slice(2) }
            : { tools: tools.slice(0, 2), nextCursor: "tools-page-two" }
          : { tools };
      } else if (message.method === "tools/call") {
        calls.push(message.params);
        result = options.call?.(message.params) ?? {
          content: [{ type: "text", text: "{}" }],
        };
      } else throw new Error(`Unexpected MCP method ${message.method}`);
      json(response, { jsonrpc: "2.0", id: message.id, result });
    })().catch((error) => json(response, { error: String(error) }, 500));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
  const seedAuth = async () =>
    writeFile(
      join(authDir, "linear-oauth.json"),
      JSON.stringify({
        serverUrl: `${url}/mcp`,
        tokens: { access_token: accessToken, token_type: "Bearer" },
      }),
      { mode: 0o600 },
    );
  return {
    url: `${url}/mcp`,
    authDir,
    calls,
    registrations,
    tokenRequests,
    seedAuth,
    rotateToken: () => {
      accessToken = "refreshed-test-access-token";
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(authDir, { recursive: true, force: true });
    },
  };
}

test("interactive OAuth validates state, persists private credentials, and refreshes on a new controller", async (t) => {
  const remote = await fixture({ toolPages: true });
  t.after(() => remote.close());
  let browser: Promise<void> | undefined;
  const client = new LinearClient({
    ...remote,
    onAuthUrl: (value) => {
      browser = (async () => {
        const authorization = new URL(value);
        assert.equal(
          authorization.searchParams.get("client_id"),
          "fixture-client",
        );
        assert.equal(
          authorization.searchParams.get("code_challenge_method"),
          "S256",
        );
        const callback = new URL(
          authorization.searchParams.get("redirect_uri")!,
        );
        callback.searchParams.set("code", "fixture-authorization-code");
        callback.searchParams.set("state", "wrong-state");
        assert.equal((await fetch(callback)).status, 400);
        callback.searchParams.set(
          "state",
          authorization.searchParams.get("state")!,
        );
        assert.equal((await fetch(callback)).status, 200);
      })();
    },
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), /authentication required.*login/i);
  await client.login();
  await browser;
  assert.equal(remote.registrations.length, 1);
  assert.equal(
    remote.tokenRequests[0].get("code"),
    "fixture-authorization-code",
  );
  assert(remote.tokenRequests[0].get("code_verifier"));
  assert.equal(
    (await stat(join(remote.authDir, "linear-oauth.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await stat(remote.authDir)).mode & 0o777, 0o700);
  const stored = JSON.parse(
    await readFile(join(remote.authDir, "linear-oauth.json"), "utf8"),
  );
  assert.equal(stored.tokens.refresh_token, "test-refresh-token");
  assert.equal(stored.clientInformation.client_id, "fixture-client");
  assert.equal(stored.tokens.issuer, new URL(remote.url).origin);
  await client.close();
  remote.rotateToken();
  const resumed = new LinearClient({
    ...remote,
    onAuthUrl: () => assert.fail("Refresh must not require a browser"),
  });
  t.after(() => resumed.close());
  await resumed.connect();
  assert.equal(remote.tokenRequests[1].get("grant_type"), "refresh_token");
  assert.equal(
    remote.tokenRequests[1].get("refresh_token"),
    "test-refresh-token",
  );
});

test("paginates MCP issues and hydrates blockers and PR attachments through get_issue", async (t) => {
  const remote = await fixture({
    call: (call) => {
      if (call.name === "list_issues")
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                call.arguments.cursor
                  ? { issues: [{ id: "2" }], hasNextPage: false }
                  : {
                      issues: [{ id: "1" }],
                      hasNextPage: true,
                      cursor: "second-page",
                    },
              ),
            },
          ],
        };
      assert.equal(call.name, "get_issue");
      assert.equal(call.arguments.includeRelations, true);
      const data = issue(call.arguments.id);
      if (call.arguments.id === "1") {
        data.description =
          "See https://github.com/acme/repo/pull/12 and https://github.com/acme/repo/pull/12.";
        data.attachments = [{ url: "https://github.com/acme/repo/pull/13" }];
        data.labels = ["symphony", { name: "bug" }];
        data.relations.blockedBy = [
          { id: "9", identifier: "ENG-9", status: "In Progress" },
        ];
      }
      return { content: [], structuredContent: data };
    },
  });
  t.after(() => remote.close());
  await remote.seedAuth();
  const client = new LinearClient(remote);
  t.after(() => client.close());
  await client.connect();
  const issues = await client.listIssues({
    team: "ENG",
    project: "Symphony",
    state: "Todo",
  });
  assert.equal(issues.length, 2);
  assert.equal(issues[1].description, "");
  assert.deepEqual(issues[0].blockedBy, [
    { id: "9", identifier: "ENG-9", state: "In Progress" },
  ]);
  assert.deepEqual(issues[0].labels, ["symphony", "bug"]);
  assert.deepEqual(issues[0].prUrls, [
    "https://github.com/acme/repo/pull/12",
    "https://github.com/acme/repo/pull/13",
  ]);
  assert.deepEqual(remote.calls[1].arguments, {
    team: "ENG",
    project: "Symphony",
    state: "Todo",
    limit: 100,
    cursor: "second-page",
  });
});

test("uses advertised save_issue/save_comment schemas for writes", async (t) => {
  const remote = await fixture({
    call: (call) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            call.name === "get_issue" ? issue("3") : { id: "3" },
          ),
        },
      ],
    }),
  });
  t.after(() => remote.close());
  await remote.seedAuth();
  const client = new LinearClient(remote);
  t.after(() => client.close());
  await client.connect();
  await client.updateIssue("3", { state: "In Progress", labels: ["symphony"] });
  await client.comment("3", "A real\nnewline.");
  const created = await client.createIssue({
    team: "ENG",
    title: "Follow-up",
    description: "Details",
    state: "Todo",
    labels: ["symphony"],
  });
  assert.equal(created.id, "3");
  assert.deepEqual(remote.calls.slice(0, 3), [
    {
      name: "save_issue",
      arguments: { id: "3", state: "In Progress", labels: ["symphony"] },
    },
    {
      name: "save_comment",
      arguments: { issueId: "3", body: "A real\nnewline." },
    },
    {
      name: "save_issue",
      arguments: {
        team: "ENG",
        title: "Follow-up",
        description: "Details",
        state: "Todo",
        labels: ["symphony"],
      },
    },
  ]);
});

test("finds PR links in paginated issue comments and preserves canceled blocker states", async (t) => {
  const remote = await fixture({
    tools: [
      ...standardTools(),
      tool("list_comments", ["issueId", "limit", "after"]),
    ],
    call: (call) => {
      if (call.name === "get_issue") {
        const data = issue("5");
        data.relations.blockedBy = [
          { id: "6", identifier: "ENG-6", status: "Canceled" },
        ];
        return { content: [], structuredContent: data };
      }
      assert.equal(call.name, "list_comments");
      assert.equal(call.arguments.issueId, "5");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              call.arguments.after
                ? {
                    comments: [
                      { body: "Merged https://github.com/acme/repo/pull/99" },
                    ],
                    pageInfo: { hasNextPage: false },
                  }
                : {
                    comments: [
                      {
                        body: "Ready for review: https://github.com/acme/repo/pull/98",
                      },
                    ],
                    pageInfo: {
                      hasNextPage: true,
                      endCursor: "comment-page-two",
                    },
                  },
            ),
          },
        ],
      };
    },
  });
  t.after(() => remote.close());
  await remote.seedAuth();
  const client = new LinearClient(remote);
  t.after(() => client.close());
  await client.connect();
  const data = await client.getIssue("5");
  assert.deepEqual(data.prUrls, [
    "https://github.com/acme/repo/pull/98",
    "https://github.com/acme/repo/pull/99",
  ]);
  assert.equal(data.blockedBy[0].state, "Canceled");
  assert.equal(remote.calls[2].arguments.after, "comment-page-two");
});

test("fails clearly for missing official MCP tools and incomplete blocker data", async (t) => {
  const remote = await fixture({
    tools: standardTools().filter((value) => value.name !== "save_comment"),
  });
  t.after(() => remote.close());
  await remote.seedAuth();
  const client = new LinearClient(remote);
  t.after(() => client.close());
  await assert.rejects(
    client.connect(),
    /missing required tool save_comment or create_comment/,
  );
  const incomplete = await fixture({
    call: () => {
      const data = issue("4");
      delete data.relations;
      return { content: [], structuredContent: data };
    },
  });
  t.after(() => incomplete.close());
  await incomplete.seedAuth();
  const connected = new LinearClient(incomplete);
  t.after(() => connected.close());
  await connected.connect();
  await assert.rejects(
    connected.getIssue("4"),
    /issue relations.*includeRelations/,
  );
});
