import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  state: string;
  url: string;
  labels: string[];
  updatedAt: string;
  blockedBy: Array<{ id: string; identifier: string; state: string }>;
  prUrls: string[];
}

type ObjectValue = Record<string, unknown>;
type IssueFilter = { team: string; project?: string; state?: string };
type CreateIssue = IssueFilter & {
  title: string;
  description: string;
  state: string;
  labels?: string[];
};
type AuthStore = {
  serverUrl: string;
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
};

/** Credentials belong to this controller, never the desktop application's MCP login. */
class FileOAuthProvider implements OAuthClientProvider {
  private data: AuthStore;
  private verifier?: string;
  private expectedState?: string;
  interactive = false;

  constructor(
    private readonly serverUrl: string,
    private readonly authDir: string,
    private readonly onAuthUrl: (url: string) => void,
  ) {
    this.data = { serverUrl };
  }

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (!isObject(value) || value.serverUrl !== this.serverUrl) {
        throw new Error(
          "Stored Linear OAuth credentials belong to a different MCP server. Use a separate auth directory.",
        );
      }
      this.data = value as AuthStore;
      await chmod(this.path, 0o600);
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") throw error;
    }
  }

  private get path(): string {
    return join(this.authDir, "linear-oauth.json");
  }
  private async save(): Promise<void> {
    await mkdir(this.authDir, { recursive: true, mode: 0o700 });
    await chmod(this.authDir, 0o700);
    await writeFile(this.path, JSON.stringify(this.data, null, 2) + "\n", {
      mode: 0o600,
    });
    await chmod(this.path, 0o600);
  }

  get redirectUrl(): string {
    return this.data.redirectUrl ?? "http://127.0.0.1:0/callback";
  }
  async setRedirectUrl(value: string): Promise<void> {
    this.data.redirectUrl = value;
    await this.save();
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Symphony Machine",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.data.clientInformation;
  }
  async saveClientInformation(
    value: OAuthClientInformationMixed,
  ): Promise<void> {
    this.data.clientInformation = value;
    await this.save();
  }
  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }
  async saveTokens(value: OAuthTokens): Promise<void> {
    this.data.tokens = value;
    await this.save();
  }
  state(): string {
    return (this.expectedState = randomBytes(32).toString("hex"));
  }
  acceptsState(value: string | null): boolean {
    return !!this.expectedState && value === this.expectedState;
  }
  redirectToAuthorization(url: URL): void {
    if (!this.interactive) throw loginRequired();
    this.onAuthUrl(url.toString());
  }
  saveCodeVerifier(value: string): void {
    this.verifier = value;
  }
  codeVerifier(): string {
    if (!this.verifier)
      throw new Error("Missing Linear OAuth PKCE verifier. Run login again.");
    return this.verifier;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.data.discovery;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.data.discovery = value;
    await this.save();
  }
  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all" || scope === "client")
      delete this.data.clientInformation;
    if (scope === "all" || scope === "tokens") delete this.data.tokens;
    if (scope === "all" || scope === "discovery") delete this.data.discovery;
    if (scope === "all" || scope === "verifier") this.verifier = undefined;
    await this.save();
  }
}

function loginRequired(): Error {
  return new Error(
    "Linear authentication required. Run the Symphony login command first.",
  );
}

export class LinearClient {
  private readonly url: URL;
  private readonly auth: FileOAuthProvider;
  private client?: Client;
  private transport?: StreamableHTTPClientTransport;
  private tools = new Map<string, Tool>();
  private cancelLogin?: () => void;

  constructor(input: {
    url: string;
    authDir: string;
    onAuthUrl?: (url: string) => void;
  }) {
    this.url = new URL(input.url);
    this.auth = new FileOAuthProvider(
      this.url.href,
      input.authDir,
      input.onAuthUrl ??
        ((url) => console.error(`Open this URL to authorize Linear:\n${url}`)),
    );
  }

  async connect(): Promise<void> {
    if (this.client) return;
    await this.auth.load();
    if (!this.auth.tokens()) throw loginRequired();
    try {
      await this.open();
    } catch (error) {
      await this.closeConnection();
      if (error instanceof UnauthorizedError) throw loginRequired();
      throw error;
    }
  }

  /** Interactive OAuth on a loopback listener; access and refresh tokens stay in authDir. */
  async login(): Promise<void> {
    await this.closeConnection();
    await this.auth.load();
    const callback = new URL(this.auth.redirectUrl);
    if (
      callback.hostname !== "127.0.0.1" ||
      callback.pathname !== "/callback"
    ) {
      throw new Error(
        "Invalid stored Linear OAuth loopback callback. Remove the controller's auth file and log in again.",
      );
    }
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(callback.port), "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Could not open Linear OAuth callback listener.");
    callback.port = String(address.port);
    try {
      await this.auth.setRedirectUrl(callback.href);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
    let timeout: NodeJS.Timeout | undefined;
    let callbackError: ((error: Error) => void) | undefined;
    const code = new Promise<string>((resolve, reject) => {
      callbackError = reject;
      server.on("request", (request, response) => {
        const received = new URL(request.url ?? "/", callback);
        if (
          request.method !== "GET" ||
          received.pathname !== callback.pathname
        ) {
          response.writeHead(404).end();
          return;
        }
        if (!this.auth.acceptsState(received.searchParams.get("state"))) {
          response.writeHead(400).end("Invalid OAuth state.");
          return;
        }
        const authCode = received.searchParams.get("code");
        if (!authCode || received.searchParams.has("error")) {
          response
            .writeHead(400)
            .end("Linear authorization was not completed.");
          reject(
            new Error("Linear authorization was denied or returned no code."),
          );
          return;
        }
        response
          .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
          .end(
            "Linear authorization received. You can close this tab and return to Symphony.",
          );
        resolve(authCode);
      });
      timeout = setTimeout(
        () => reject(new Error("Linear login timed out after 5 minutes.")),
        300_000,
      );
    });
    // Attach immediately: cancellation or an early callback must never produce an unhandled rejection.
    void code.catch(() => {});
    this.cancelLogin = () =>
      callbackError?.(new Error("Linear login cancelled."));
    this.auth.interactive = true;
    try {
      try {
        await this.open();
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !this.transport)
          throw error;
        const transport = this.transport;
        await transport.finishAuth(await code);
        await this.closeConnection();
        await this.open();
      }
    } catch (error) {
      await this.closeConnection();
      throw error;
    } finally {
      this.auth.interactive = false;
      this.cancelLogin = undefined;
      clearTimeout(timeout);
      await closeServer(server);
    }
  }

  private async open(): Promise<void> {
    this.client = new Client({ name: "symphony-machine", version: "0.1.0" });
    this.transport = new StreamableHTTPClientTransport(this.url, {
      authProvider: this.auth,
    });
    await this.client.connect(this.transport);
    this.tools.clear();
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.client.listTools(cursor ? { cursor } : {});
      for (const tool of page.tools) this.tools.set(tool.name, tool);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor))
        throw new Error("Linear MCP tools/list repeated a pagination cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    for (const names of [
      ["list_issues"],
      ["get_issue"],
      ["save_issue", "update_issue"],
      ["save_issue", "create_issue"],
      ["save_comment", "create_comment"],
    ])
      this.tool(names);
  }

  async close(): Promise<void> {
    this.cancelLogin?.();
    await this.closeConnection();
  }
  private async closeConnection(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.tools.clear();
    await client?.close();
  }

  private tool(names: string[]): Tool {
    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool) return tool;
    }
    throw new Error(
      `Linear MCP is missing required tool ${names.join(" or ")}. Available tools: ${[...this.tools.keys()].join(", ") || "none"}.`,
    );
  }

  private async call(tool: Tool, args: ObjectValue): Promise<unknown> {
    if (!this.client) throw new Error("Linear MCP is not connected.");
    const properties = tool.inputSchema.properties ?? {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined && !(key in properties)) {
        throw new Error(
          `Linear MCP tool ${tool.name} does not advertise required input '${key}'.`,
        );
      }
    }
    const input = Object.fromEntries(
      Object.entries(args).filter(([, value]) => value !== undefined),
    );
    const result = (await this.client.callTool({
      name: tool.name,
      arguments: input,
    })) as CallToolResult;
    const texts = result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text);
    if (result.isError)
      throw new Error(
        `Linear MCP ${tool.name} failed: ${texts.join("\n").slice(0, 2000)}`,
      );
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (!texts.length)
      throw new Error(`Linear MCP ${tool.name} returned no JSON data.`);
    try {
      return JSON.parse(texts.join("\n"));
    } catch {
      throw new Error(`Linear MCP ${tool.name} returned invalid JSON.`);
    }
  }

  async listIssues(input: IssueFilter): Promise<LinearIssue[]> {
    const tool = this.tool(["list_issues"]);
    const properties = tool.inputSchema.properties ?? {};
    const cursorKey =
      "cursor" in properties
        ? "cursor"
        : "after" in properties
          ? "after"
          : undefined;
    const ids: string[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const raw = await this.call(tool, {
        ...input,
        ...("limit" in properties ? { limit: 100 } : {}),
        ...(cursor && cursorKey ? { [cursorKey]: cursor } : {}),
      });
      if (!isObject(raw) || !Array.isArray(raw.issues))
        throw new Error("Linear list_issues returned no issues array.");
      for (const value of raw.issues) {
        const id = requiredString(asObject(value, "issue"), "id");
        if (!seenIds.has(id)) {
          seenIds.add(id);
          ids.push(id);
        }
      }
      const info = isObject(raw.pageInfo) ? raw.pageInfo : raw;
      if (typeof info.hasNextPage !== "boolean")
        throw new Error(
          "Linear list_issues returned no hasNextPage pagination flag.",
        );
      if (!info.hasNextPage) break;
      const next = info.endCursor ?? raw.nextCursor ?? raw.cursor;
      if (
        !cursorKey ||
        typeof next !== "string" ||
        !next ||
        seenCursors.has(next)
      ) {
        throw new Error(
          "Linear list_issues has another page but returned no usable, new cursor.",
        );
      }
      seenCursors.add(next);
      cursor = next;
    } while (cursor);
    // Listing omits relations. Hydrate before the scheduler considers dependency eligibility.
    const issues: LinearIssue[] = [];
    for (const id of ids) issues.push(await this.getIssue(id));
    return issues;
  }

  async getIssue(id: string): Promise<LinearIssue> {
    const raw = await this.call(this.tool(["get_issue"]), {
      id,
      includeRelations: true,
    });
    const issue = normalizeIssue(raw);
    const comments = this.tools.get("list_comments");
    if (comments) {
      const properties = comments.inputSchema.properties ?? {};
      const cursorKey =
        "cursor" in properties
          ? "cursor"
          : "after" in properties
            ? "after"
            : undefined;
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const raw = await this.call(comments, {
          issueId: issue.id,
          ...("limit" in properties ? { limit: 100 } : {}),
          ...(cursor && cursorKey ? { [cursorKey]: cursor } : {}),
        });
        // The unpaginated official tool returns a bare array; paginated versions use an envelope.
        const rows = Array.isArray(raw)
          ? raw
          : isObject(raw)
            ? raw.comments
            : undefined;
        if (!Array.isArray(rows))
          throw new Error("Linear list_comments returned no comments array.");
        for (const row of rows)
          if (isObject(row) && typeof row.body === "string") {
            issue.prUrls.push(...extractPrUrls(row.body));
          }
        if (Array.isArray(raw)) break;
        const page = asObject(raw, "comment page");
        const info = isObject(page.pageInfo) ? page.pageInfo : page;
        const next = info.endCursor ?? page.nextCursor ?? page.cursor;
        if (
          info.hasNextPage === false ||
          (info.hasNextPage === undefined && !next)
        )
          break;
        if (!cursorKey || typeof next !== "string" || !next || seen.has(next)) {
          throw new Error(
            "Linear list_comments has another page but returned no usable, new cursor.",
          );
        }
        seen.add(next);
        cursor = next;
      } while (cursor);
      issue.prUrls = [...new Set(issue.prUrls)];
    }
    return issue;
  }

  async updateIssue(
    id: string,
    patch: { state?: string; labels?: string[] },
  ): Promise<void> {
    await this.call(this.tool(["save_issue", "update_issue"]), {
      id,
      ...patch,
    });
  }

  async comment(id: string, body: string): Promise<void> {
    await this.call(this.tool(["save_comment", "create_comment"]), {
      issueId: id,
      body,
    });
  }

  async createIssue(input: CreateIssue): Promise<LinearIssue> {
    const raw = asObject(
      await this.call(this.tool(["save_issue", "create_issue"]), input),
      "saved issue",
    );
    const issue = isObject(raw.issue) ? raw.issue : raw;
    return this.getIssue(requiredString(issue, "id"));
  }
}

function isObject(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asObject(value: unknown, name: string): ObjectValue {
  if (!isObject(value)) throw new Error(`Linear returned an invalid ${name}.`);
  return value;
}
function requiredString(value: ObjectValue, key: string): string {
  if (typeof value[key] !== "string" || !value[key])
    throw new Error(`Linear issue is missing '${key}'.`);
  return value[key];
}
function stateName(value: ObjectValue): string {
  const state = value.status ?? value.state;
  if (typeof state === "string" && state) return state;
  if (isObject(state) && typeof state.name === "string" && state.name)
    return state.name;
  throw new Error("Linear issue is missing its state.");
}
function normalizeIssue(value: unknown): LinearIssue {
  const raw = asObject(value, "issue");
  const issue = isObject(raw.issue) ? raw.issue : raw;
  const relations = asObject(
    issue.relations,
    "issue relations (get_issue must includeRelations)",
  );
  if (!Array.isArray(relations.blockedBy))
    throw new Error("Linear get_issue returned no blockedBy relations.");
  const description =
    typeof issue.description === "string" ? issue.description : "";
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((value) => {
        if (typeof value === "string") return value;
        return requiredString(asObject(value, "label"), "name");
      })
    : [];
  const links = [description];
  for (const source of [issue.attachments, issue.pullRequests, issue.prUrls]) {
    if (Array.isArray(source))
      for (const value of source) {
        if (typeof value === "string") links.push(value);
        else if (isObject(value) && typeof value.url === "string")
          links.push(value.url);
      }
  }
  const prUrls = [...new Set(links.flatMap(extractPrUrls))];
  return {
    id: requiredString(issue, "id"),
    identifier: requiredString(issue, "identifier"),
    title: requiredString(issue, "title"),
    description,
    state: stateName(issue),
    url: requiredString(issue, "url"),
    labels,
    updatedAt: requiredString(issue, "updatedAt"),
    blockedBy: relations.blockedBy.map((value) => {
      const blocker = asObject(value, "blocking issue");
      return {
        id: requiredString(blocker, "id"),
        identifier: requiredString(blocker, "identifier"),
        state: stateName(blocker),
      };
    }),
    prUrls,
  };
}

function extractPrUrls(value: string): string[] {
  return (
    value.match(
      /https?:\/\/(?:www\.)?github\.com\/[^\s/<>]+\/[^\s/<>]+\/pull\/\d+/g,
    ) ?? []
  );
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
