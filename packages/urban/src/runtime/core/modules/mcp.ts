// mcp — the runtime-served Model Context Protocol surface (ADR 0067). A Streamable-HTTP MCP
// endpoint the Urban runtime mounts UNCONDITIONALLY at `GET/POST /app/mcp`, exactly like the
// `/app/agent` brief and `/app/api-docs` docs surfaces — so an MCP client (`copilot mcp add
// --transport http <name> http://localhost:<port>/app/mcp`) discovers an app's operations as
// tools with ZERO app-side MCP code.
//
// Derive-don't-declare (ADR 0053): the app tool list is PROJECTED from the SAME OpenAPI
// enumeration `mountApi` routes from — `parseSpec` + `collectOperations` (openapi/spec.ts), read
// through `readApiBinding` — never a second spec walker. Each read-only operation becomes one tool
// whose `operationId` is the tool name and whose request-body/params schema is the tool input
// schema; a tool call is reconstructed into the operation's HTTP request and dispatched through the
// SAME `mountApi` router, so it flows through the identical delegate registry + validation the HTTP
// route uses (a tool call is equivalent to the corresponding HTTP call).
//
// This slice (ADR 0067 Slice 1) exposes READ-ONLY app operations only (GET/HEAD) — mutating
// operations and their guards are Slice 3. It also exposes framework-owned read-only
// process-debugging tools over BOTH truth planes: engine truth via existing `EngineClient` methods,
// and the ADR 0065 canonical projection stores (`urban_instance_state` / `urban_open_user_tasks`).
// The app's system brief (`/app/agent.json`) is served as an MCP resource, plus one orientation
// entry under MCP prompts.
//
// Transport: the SDK's Web-Standard Streamable-HTTP transport (`Request`→`Response`), bridged to
// the runtime's host `HttpRequest`/`HttpResponse` seam — core/ imports no `node:*`; the MCP SDK is
// an ordinary dependency. Access is loopback-only behind a manifest/env flag that defaults ON for
// loopback.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  isInitializeRequest,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { GENERATED_DIR } from "../../../toolkit/artifact.ts";
import { SYSTEM_BRIEF_JSON } from "../../../toolkit/derivers/system-brief.ts";
import {
  collectOperations,
  type OperationInfo,
  parseSpec,
} from "../../../openapi/spec.ts";
import type { AppApi, RuntimeContext } from "../context.ts";
import { errorMessage } from "../guards.ts";
import type {
  ElementInstanceWaitStateFilter,
  HttpRequest,
  HttpResponse,
  ProcessInstanceState,
  SqliteDb,
  UserTaskFilter,
  UserTaskState,
  WaitStateType,
} from "../host.ts";
import { presentFormIdentifier } from "../host.ts";
import { resolveBindMode } from "../manifest.ts";
import { json, makeRouter, type Route } from "../router.ts";
import { API_BASE, readApiBinding } from "./api.ts";
import { resolveAppPath } from "./datasource.ts";
import { InstanceStateStore } from "./instance-state-store.ts";
import { OpenUserTasksStore } from "./open-user-tasks-store.ts";

/** The mount path of the MCP endpoint — a sibling of `/app/api` / `/app/agent`, mounted
 *  unconditionally so an MCP client always has a stable address to connect to. */
const MCP_PATH = "/app/mcp";

/** The header carrying the Streamable-HTTP session id (MCP spec). */
const SESSION_HEADER = "mcp-session-id";

/** The MCP resource URI for the app's system brief (the `/app/agent.json` content). */
const SYSTEM_BRIEF_URI = "urban://system-brief.json";

/** The single orientation prompt registered under MCP `prompts`. */
const ORIENTATION_PROMPT = "urban-orientation";

/** The framework debug-tool name prefix — a reserved namespace. `loadReadOnlyOps` drops any app
 *  `operationId` in this namespace before it is projected as a tool, so a framework tool can never
 *  collide with (be shadowed by, or duplicate the name of) an app-projected tool. */
const DEBUG_PREFIX = "urban_debug_";

export interface McpHandle {
  readonly name: string;
  routes: Route[];
  describe(): Record<string, unknown>;
}

/** The resolved MCP access policy for this app. */
interface McpConfig {
  /** Whether the MCP surface answers at all. Defaults ON. */
  readonly enabled: boolean;
  /** Whether non-loopback callers are allowed. Defaults OFF (loopback-only). */
  readonly allowRemote: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve the MCP access policy from the manifest (`mcp: { enabled?, allowRemote? }`, read
 * reflectively until the app schema folds the field in — mirroring how `readApiBinding` reads
 * `api`) and the environment (`URBAN_MCP_ENABLED`, `URBAN_MCP_ALLOW_REMOTE`). The env flags win so
 * an operator can force the surface off (or open it to a non-loopback bind) without editing the
 * manifest. Enabled defaults ON and access defaults to loopback-only ("defaults ON for loopback").
 */
export function readMcpConfig(manifest: unknown, env: (name: string) => string | undefined): McpConfig {
  const raw = manifest && typeof manifest === "object" ? Reflect.get(manifest, "mcp") : undefined;
  const manifestEnabled = isRecord(raw) ? Reflect.get(raw, "enabled") : undefined;
  const manifestAllowRemote = isRecord(raw) ? Reflect.get(raw, "allowRemote") : undefined;
  const envEnabled = env("URBAN_MCP_ENABLED");
  const envAllowRemote = env("URBAN_MCP_ALLOW_REMOTE");
  const enabled = envEnabled === "false" ? false : envEnabled === "true" ? true : manifestEnabled !== false;
  const allowRemote =
    envAllowRemote === "true" ? true : envAllowRemote === "false" ? false : manifestAllowRemote === true;
  return { enabled, allowRemote };
}

/** The host portion of an HTTP `Host` header, lower-cased and stripped of any `:port` (and of the
 *  `[...]` brackets around an IPv6 literal), or `undefined` when there is no Host header. */
function hostName(req: HttpRequest): string | undefined {
  const host = req.headers.get("host");
  if (!host) return undefined;
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const colon = trimmed.indexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

/** Whether the request targets a loopback host — the best-effort loopback signal available at the
 *  host seam (which carries no peer address). A missing Host header is treated as loopback (a direct
 *  local client that sent none). */
export function isLoopbackRequest(req: HttpRequest): boolean {
  const name = hostName(req);
  return name === undefined || name === "localhost" || name === "127.0.0.1" || name === "::1";
}

/** True for a read-only operation — the only operations this slice projects as tools. Mutating
 *  operations (POST/PUT/PATCH/DELETE) are withheld until Slice 3 adds them behind a guard. */
function isReadOnlyOperation(op: OperationInfo): boolean {
  return op.method === "get" || op.method === "head";
}

/** A JSON Schema (OpenAPI object subset) describing a tool's input, derived from an operation's
 *  path/query parameters and its request-body schema. Keeping the property schemas verbatim from the
 *  spec means the tool input schema and the HTTP validation share one source of truth. */
function toolInputSchema(op: OperationInfo): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of op.parameters) {
    if (p.in === "path" || p.in === "query") {
      properties[p.name] = p.schema ?? {};
      if (p.required) required.push(p.name);
    }
  }
  if (op.requestBodySchema) {
    properties.body = op.requestBodySchema;
    if (op.requestBodyRequired) required.push("body");
  }
  const schema: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** Substitute an operation's `{param}` path-template segments with the supplied arguments, building
 *  the request path under the shared `/app/api` base so dispatch hits the exact `mountApi` route. */
function fillPath(op: OperationInfo, args: Record<string, unknown>): string {
  const path = op.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const value = args[name];
    return encodeURIComponent(value === undefined || value === null ? "" : String(value));
  });
  return `${API_BASE}${path}`;
}

/** Build the query string for a tool call from the operation's declared query parameters and the
 *  supplied arguments — repeated (array) values become repeated keys, exactly as an HTTP client
 *  would send them, so the reused dispatcher validates identical input. */
function toolQuery(op: OperationInfo, args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const p of op.parameters) {
    if (p.in !== "query") continue;
    const value = args[p.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(p.name, String(item));
    } else {
      query.append(p.name, String(value));
    }
  }
  return query;
}

/** Whether an argument is absent for presence purposes: unset (`undefined`/`null`), or a string that
 *  is empty or whitespace-only after trimming. This is the trimmed-presence rule
 *  {@link presentFormIdentifier} enforces for form identifiers, reused here so MCP required/path args
 *  and form resolution cannot drift on what "provided" means (a whitespace-only `"   "` is absent in
 *  both). A non-string value (e.g. a numeric path id) is considered present. */
function isBlankArg(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return presentFormIdentifier(value) === undefined;
  return false;
}

/** The required path parameters an operation declares that the tool `args` did not supply. Unlike
 *  an HTTP request (whose path can't structurally omit a segment), a tool call can leave a
 *  `{param}` unset or blank; `fillPath` would then substitute an empty string and silently mis-route
 *  (a 404 route mismatch, or worse a different route shape), so a missing/blank path arg is rejected
 *  up front. Blankness uses the shared trimmed-presence rule so a whitespace-only value is rejected
 *  too. */
function missingPathParams(op: OperationInfo, args: Record<string, unknown>): string[] {
  return op.parameters
    .filter((p) => p.in === "path" && isBlankArg(args[p.name]))
    .map((p) => p.name);
}

/** The `required` string keys a tool's `inputSchema` declares but the call omitted (absent, or not a
 *  non-empty-after-trim string). Derived from the schema's own `required` array — the single source
 *  of truth — so declaring a field required is enough to have missing (or whitespace-only) calls
 *  rejected rather than silently substituted with an empty string. */
function missingRequiredArgs(inputSchema: Record<string, unknown>, args: Record<string, unknown>): string[] {
  const required = inputSchema.required;
  if (!Array.isArray(required)) return [];
  const missing: string[] = [];
  for (const key of required) {
    if (typeof key !== "string") continue;
    const value = args[key];
    if (typeof value !== "string" || isBlankArg(value)) missing.push(key);
  }
  return missing;
}

/** Reconstruct the HTTP request an operation tool call is equivalent to, ready to hand to the
 *  reused `mountApi` router. The JSON body is the tool's `body` argument (when the op declares one).
 */
function toHttpRequest(op: OperationInfo, args: Record<string, unknown>): HttpRequest {
  const bodyText = op.requestBodySchema !== undefined && args.body !== undefined
    ? JSON.stringify(args.body)
    : "";
  return {
    method: op.method.toUpperCase(),
    path: fillPath(op, args),
    query: toolQuery(op, args),
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(bodyText),
  };
}

/** Wrap a value as an MCP tool text result. A JSON payload is stringified; `isError` flags a
 *  non-2xx dispatch so the client sees the failure (carrying the delegate's own error body). */
function textResult(value: unknown, isError = false): {
  content: { type: "text"; text: string }[];
  isError?: boolean;
} {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) if (typeof item === "string") out.push(item);
  return out;
}

function readProcessInstanceState(args: Record<string, unknown>, key: string): ProcessInstanceState | undefined {
  const v = args[key];
  return v === "ACTIVE" || v === "COMPLETED" || v === "TERMINATED" ? v : undefined;
}

function readUserTaskState(args: Record<string, unknown>, key: string): UserTaskState | undefined {
  const v = args[key];
  return v === "CREATED" || v === "COMPLETED" || v === "CANCELED" || v === "FAILED" ? v : undefined;
}

function readWaitStateType(args: Record<string, unknown>, key: string): WaitStateType | undefined {
  const v = args[key];
  return v === "JOB" || v === "MESSAGE" || v === "USER_TASK" || v === "TIMER" || v === "SIGNAL" || v === "CONDITION"
    ? v
    : undefined;
}

/** One framework-owned read-only debug tool: its MCP descriptor plus a handler that reads engine
 *  truth or a projection store and returns JSON. */
interface DebugTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

const OPTIONAL_STRING = { type: "string" } as const;

/** Build the framework debug tools, closing over the app's engine (truth plane) and default data
 *  source (the ADR 0065 projection stores). The engine tools consume only EXISTING `EngineClient`
 *  methods — no seam extension in this slice. */
function buildDebugTools(app: AppApi): DebugTool[] {
  const projectionDb = (): SqliteDb | undefined =>
    app.data.hasDefaultSource() ? app.data.source().db : undefined;

  return [
    {
      name: `${DEBUG_PREFIX}search_process_instances`,
      description: "Engine truth: search process instances by key and/or lifecycle state.",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKeys: { type: "array", items: OPTIONAL_STRING },
          state: { type: "string", enum: ["ACTIVE", "COMPLETED", "TERMINATED"] },
        },
      },
      run: (args) => {
        const filter: { processInstanceKeys?: string[]; state?: ProcessInstanceState } = {};
        const keys = readStringArray(args, "processInstanceKeys");
        if (keys) filter.processInstanceKeys = keys;
        const state = readProcessInstanceState(args, "state");
        if (state) filter.state = state;
        return app.engine.searchProcessInstances(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}search_element_instance_wait_states`,
      description: "Engine truth: search element-instance wait states (every park, not only user tasks).",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKey: OPTIONAL_STRING,
          elementId: OPTIONAL_STRING,
          waitStateType: {
            type: "string",
            enum: ["JOB", "MESSAGE", "USER_TASK", "TIMER", "SIGNAL", "CONDITION"],
          },
        },
      },
      run: (args) => {
        const filter: ElementInstanceWaitStateFilter = {};
        const pik = readString(args, "processInstanceKey");
        if (pik) filter.processInstanceKey = pik;
        const elementId = readString(args, "elementId");
        if (elementId) filter.elementId = elementId;
        const waitStateType = readWaitStateType(args, "waitStateType");
        if (waitStateType) filter.waitStateType = waitStateType;
        return app.engine.searchElementInstanceWaitStates(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}get_element_instance`,
      description: "Engine truth: fetch a single element instance by key (null when absent).",
      inputSchema: {
        type: "object",
        properties: { elementInstanceKey: OPTIONAL_STRING },
        required: ["elementInstanceKey"],
      },
      run: (args) => app.engine.getElementInstance(readString(args, "elementInstanceKey") ?? ""),
    },
    {
      name: `${DEBUG_PREFIX}search_user_tasks`,
      description: "Engine truth: search user tasks by process instance, assignee, candidate group, and/or state.",
      inputSchema: {
        type: "object",
        properties: {
          processInstanceKey: OPTIONAL_STRING,
          assignee: OPTIONAL_STRING,
          candidateGroup: OPTIONAL_STRING,
          state: { type: "string", enum: ["CREATED", "COMPLETED", "CANCELED", "FAILED"] },
        },
      },
      run: (args) => {
        const filter: UserTaskFilter & { state?: UserTaskState } = {};
        const pik = readString(args, "processInstanceKey");
        if (pik) filter.processInstanceKey = pik;
        const assignee = readString(args, "assignee");
        if (assignee) filter.assignee = assignee;
        const candidateGroup = readString(args, "candidateGroup");
        if (candidateGroup) filter.candidateGroup = candidateGroup;
        const state = readUserTaskState(args, "state");
        if (state) filter.state = state;
        return app.engine.searchUserTasks(filter);
      },
    },
    {
      name: `${DEBUG_PREFIX}instance_state`,
      description: "Projection (urban_instance_state, ADR 0065): the canonical engine-lifecycle state for an instance.",
      inputSchema: {
        type: "object",
        properties: { processInstanceKey: OPTIONAL_STRING },
        required: ["processInstanceKey"],
      },
      run: (args) => {
        const db = projectionDb();
        if (!db) return Promise.resolve(null);
        const key = readString(args, "processInstanceKey") ?? "";
        return Promise.resolve(new InstanceStateStore(db).getState(key) ?? null);
      },
    },
    {
      name: `${DEBUG_PREFIX}open_user_tasks`,
      description: "Projection (urban_open_user_tasks, ADR 0065): the currently-open user tasks for an instance.",
      inputSchema: {
        type: "object",
        properties: { processInstanceKey: OPTIONAL_STRING },
        required: ["processInstanceKey"],
      },
      run: (args) => {
        const db = projectionDb();
        if (!db) return Promise.resolve([]);
        const key = readString(args, "processInstanceKey") ?? "";
        return Promise.resolve(new OpenUserTasksStore(db).openTasks(key));
      },
    },
  ];
}

/**
 * Mount the runtime-served MCP surface at `/app/mcp` (ADR 0067). Returns a single `*`-method route
 * (mounted unconditionally, like `/app/agent`); the handler bridges the host request/response seam
 * to the SDK's Web-Standard Streamable-HTTP transport, maintaining one MCP session per
 * `mcp-session-id`. The tool projection reuses the SAME OpenAPI enumeration and dispatch path as
 * `mountApi`, so a tool call is equivalent to the corresponding HTTP call.
 */
export function mountMcp(ctx: RuntimeContext, app: AppApi, apiRoutes: Route[]): McpHandle {
  const config = readMcpConfig(ctx.manifest, ctx.host.env);
  // The effective HTTP bind interface. When the app is bound to all interfaces, the
  // client-controlled `Host` header is not a trustworthy loopback signal (a remote caller can send
  // `Host: localhost`), so a loopback-only surface must refuse EVERY caller rather than trust it.
  const bindMode = resolveBindMode(ctx.manifest, ctx.host.env);

  // Reuse the app's OpenAPI dispatch VERBATIM: `mountSurfaces` already built the `/app/api` router
  // (validation + delegate registry) via `mountApi` and hands us its routes here, so tool and HTTP
  // calls share ONE dispatcher instance (no forked dispatcher, no second doc/delegate cache). A tool
  // call is reconstructed into the operation's HTTP request and routed through this same router.
  const apiRouter = makeRouter(apiRoutes);

  // The read-only operation table, projected lazily from the same spec `mountApi` reads and cached
  // (mirroring `mountApi`'s lazy `loadDoc`). A missing/broken spec degrades to "no app tools"
  // rather than breaking the whole MCP endpoint (the debug tools + resource + prompt still serve).
  let opsPromise: Promise<OperationInfo[]> | undefined;
  const loadReadOnlyOps = (): Promise<OperationInfo[]> => {
    if (!opsPromise) {
      opsPromise = (async () => {
        const binding = readApiBinding(ctx.manifest);
        if (!binding) return [];
        const text = await ctx.host.readTextFile(resolveAppPath(ctx.root, binding.spec));
        const readOnly = collectOperations(parseSpec(text)).filter(isReadOnlyOperation);
        // The `urban_debug_` namespace is framework-reserved (see DEBUG_PREFIX). A `urban_debug_*`
        // operationId is a legal safe path segment, so an app could declare one — but `CallTool`
        // resolves `debugByName` before app ops, so such an op would be shadowed by the framework
        // tool AND surface a duplicate name in `tools/list`. Drop reserved-namespace app ops here
        // (the single projection source both `tools/list` and `CallTool` read), warning per drop,
        // so the collision is impossible by construction rather than order-dependent.
        return readOnly.filter((op) => {
          if (op.operationId.startsWith(DEBUG_PREFIX)) {
            ctx.host.log("warn", "mcp: dropped app operation using reserved framework tool namespace", {
              operationId: op.operationId,
              reservedPrefix: DEBUG_PREFIX,
            });
            return false;
          }
          return true;
        });
      })().catch((e) => {
        opsPromise = undefined; // don't cache the failure — let a later request retry
        ctx.host.log("warn", "mcp: failed to project app operations as tools", { error: errorMessage(e) });
        return [];
      });
    }
    return opsPromise;
  };

  const debugTools = buildDebugTools(app);
  const debugByName = new Map(debugTools.map((t) => [t.name, t]));

  const dispatchOperationTool = async (
    op: OperationInfo,
    args: Record<string, unknown>,
  ): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> => {
    const missing = missingPathParams(op, args);
    if (missing.length > 0) {
      // Surface as an error tool result (like a reused-validator failure), not a silent 404 from an
      // empty-string substitution — the calling agent sees exactly which required params it omitted.
      return textResult(
        { error: `validation failed: missing required path parameter(s): ${missing.join(", ")}` },
        true,
      );
    }
    const res = await apiRouter(toHttpRequest(op, args));
    const status = res.status ?? 200;
    return textResult(res.body ?? "", status >= 400);
  };

  const readSystemBrief = async (): Promise<string> => {
    const path = resolveAppPath(ctx.root, `${GENERATED_DIR}/${SYSTEM_BRIEF_JSON}`);
    if (!(await ctx.host.exists(path))) {
      throw new McpError(ErrorCode.InvalidParams, "system brief not generated — run `urban gen`");
    }
    return ctx.host.readTextFile(path);
  };

  const orientationText = (): string =>
    [
      `# ${ctx.manifest.name ?? "Urban app"} — MCP orientation`,
      "",
      "This endpoint is the app's runtime-served MCP surface (ADR 0067).",
      "",
      `- Read the \`${SYSTEM_BRIEF_URI}\` resource first for the app's system model (processes, service-task call graph, decisions, ownership).`,
      "- App tools mirror the app's read-only HTTP operations one-to-one: a tool call is equivalent to the corresponding `/app/api` HTTP call, validated identically.",
      `- \`${DEBUG_PREFIX}*\` tools are framework-owned read-only process-debugging tools: engine truth (process instances, wait states, element instances, user tasks) and the ADR 0065 projection stores (instance state, open user tasks).`,
      "- This slice is read-only; mutating tools are added in a later slice behind an access guard.",
    ].join("\n");

  /** Build a fresh low-level MCP `Server` with this app's tools/resources/prompts wired. One is
   *  created per session and connected to that session's transport. */
  const buildServer = (): Server => {
    const server = new Server(
      { name: "urban", version: "1.0.0" },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const ops = await loadReadOnlyOps();
      const appTools = ops.map((op) => ({
        name: op.operationId,
        description: op.summary ?? `${op.method.toUpperCase()} ${op.path}`,
        inputSchema: toolInputSchema(op),
        annotations: { readOnlyHint: true },
      }));
      const frameworkTools = debugTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: true },
      }));
      return { tools: [...appTools, ...frameworkTools] };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name } = request.params;
      const args = isRecord(request.params.arguments) ? request.params.arguments : {};
      const debug = debugByName.get(name);
      if (debug) {
        const missing = missingRequiredArgs(debug.inputSchema, args);
        if (missing.length > 0) {
          // Fail fast like an operation-tool validation error, instead of substituting an empty
          // string that makes an invalid call look like a legitimate "not found" result.
          return textResult(
            { error: `validation failed: missing required parameter(s): ${missing.join(", ")}` },
            true,
          );
        }
        try {
          return textResult(await debug.run(args));
        } catch (e) {
          return textResult({ error: errorMessage(e) }, true);
        }
      }
      const ops = await loadReadOnlyOps();
      const op = ops.find((o) => o.operationId === name);
      if (!op) {
        throw new McpError(ErrorCode.MethodNotFound, `no such tool: ${name}`);
      }
      return dispatchOperationTool(op, args);
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: SYSTEM_BRIEF_URI,
          name: "system-brief",
          title: "App system brief",
          description: "The app's derived institutional-memory brief (the /app/agent.json content).",
          mimeType: "application/json",
        },
      ],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (uri !== SYSTEM_BRIEF_URI) {
        throw new McpError(ErrorCode.InvalidParams, `no such resource: ${uri}`);
      }
      const text = await readSystemBrief();
      return { contents: [{ uri, mimeType: "application/json", text }] };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [
        {
          name: ORIENTATION_PROMPT,
          title: "Orient on this app",
          description: "How to use this app's MCP surface: its read tools, debug tools, and system-brief resource.",
          arguments: [],
        },
      ],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name !== ORIENTATION_PROMPT) {
        throw new McpError(ErrorCode.InvalidParams, `no such prompt: ${request.params.name}`);
      }
      return {
        description: "Orientation for working against this app over MCP.",
        messages: [{ role: "user", content: { type: "text", text: orientationText() } }],
      };
    });

    return server;
  };

  interface Session {
    readonly server: Server;
    readonly transport: WebStandardStreamableHTTPServerTransport;
  }
  const sessions = new Map<string, Session>();

  const createSession = async (): Promise<Session> => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = buildServer();
    await server.connect(transport);
    return { server, transport };
  };

  /** Convert the host request into the Web-Standard `Request` the SDK transport consumes. The body
   *  is passed separately (as `parsedBody`) so the transport never re-reads it; the Request carries
   *  the method + headers (Accept, content-type, `mcp-session-id`, protocol version) it inspects. */
  const toWebRequest = (req: HttpRequest): Request => {
    const search = req.query.toString();
    const url = `http://localhost${req.path}${search ? `?${search}` : ""}`;
    const headers = new Headers();
    for (const [key, value] of req.headers) headers.set(key, value);
    return new Request(url, { method: req.method, headers });
  };

  const toHttpResponse = async (res: Response): Promise<HttpResponse> => {
    const headers: Record<string, string> = {};
    for (const [key, value] of res.headers) headers[key] = value;
    return { status: res.status, headers, body: await res.text() };
  };

  const methodNotAllowed = (): HttpResponse => ({
    status: 405,
    headers: { allow: "POST, DELETE", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method Not Allowed: the MCP endpoint accepts POST (and DELETE to end a session)." },
      id: null,
    }),
  });

  const handle = async (req: HttpRequest): Promise<HttpResponse> => {
    if (!config.enabled) return json({ error: "MCP surface is disabled" }, 404);
    if (!config.allowRemote) {
      // Bound to all interfaces, `Host` can't be trusted as a loopback proof: refuse everyone
      // unless remote access is explicitly opted in (mcp.allowRemote / URBAN_MCP_ALLOW_REMOTE).
      if (bindMode === "all") {
        return json(
          { error: "MCP surface is loopback-only, but the app is bound to all interfaces; set mcp.allowRemote to expose it" },
          403,
        );
      }
      if (!isLoopbackRequest(req)) {
        return json({ error: "MCP surface is loopback-only" }, 403);
      }
    }
    const method = req.method.toUpperCase();
    // The string-body host seam cannot hold open an SSE stream, so the optional GET server→client
    // stream is declined with 405 (spec-compliant): clients fall back to POST request/response.
    if (method !== "POST" && method !== "DELETE") return methodNotAllowed();

    const rawBody = method === "POST" ? await req.text() : "";
    let parsedBody: unknown;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        return json(
          { jsonrpc: "2.0", error: { code: ErrorCode.ParseError, message: "request body is not valid JSON" }, id: null },
          400,
        );
      }
    }

    const sessionId = req.headers.get(SESSION_HEADER) ?? undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      if (!messages.some((m) => isInitializeRequest(m))) {
        return json(
          {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no valid session id, and not an initialize request." },
            id: null,
          },
          400,
        );
      }
      session = await createSession();
    }

    const webResponse = await session.transport.handleRequest(toWebRequest(req), { parsedBody });
    // A newly-initialized session assigns its id during handleRequest — register it so the client's
    // follow-up requests (carrying `mcp-session-id`) resolve back to this same server/transport.
    const assignedId = session.transport.sessionId;
    if (assignedId && !sessions.has(assignedId)) sessions.set(assignedId, session);
    return toHttpResponse(webResponse);
  };

  const routes: Route[] = [
    { method: "*", path: MCP_PATH, source: "surface:mcp", handler: handle },
  ];
  ctx.host.log("info", "mcp surface mounted", {
    path: MCP_PATH,
    enabled: config.enabled,
    loopbackOnly: !config.allowRemote,
  });
  return {
    name: "mcp",
    routes,
    describe: () => ({
      mcp: { path: MCP_PATH, enabled: config.enabled, loopbackOnly: !config.allowRemote },
    }),
  };
}
