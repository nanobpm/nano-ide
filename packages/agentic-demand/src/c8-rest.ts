/**
 * Read deployed models' `taskDefinition` leaves from the engine's C8 REST API.
 *
 * S4 is a read-only mirror: it reads what the *engine* already has deployed and
 * diffs it against live supply — it never places work. The Camunda-8 engine stays
 * frozen (design invariant 2): we speak the ordinary C8 v2 REST API over the
 * app's own HTTP client, on a connection entirely separate from the agentic
 * channel and from the worker's C8 job protocol. Nothing here rides the engine's
 * transport or mutates engine state.
 *
 * The concrete reader ({@link httpC8RestReader}) is a thin fetch adapter over two
 * C8 v2 endpoints:
 *
 *  - `POST {rest}/process-definitions/search` → the deployed definition keys.
 *  - `GET  {rest}/process-definitions/{key}/xml` → each definition's BPMN XML.
 *
 * It is expressed against a small structural {@link C8RestReader} seam so the
 * model can be driven by an in-memory reader in tests without a live engine.
 */
import { distinctTaskTypes, scanTaskDefinitions, type TaskDefinitionLeaf } from "./taskdef.ts";

/**
 * The minimal C8 REST surface the demand reader needs: enumerate deployed
 * process-definition keys and fetch each one's BPMN XML. Structural so tests can
 * supply an in-memory implementation.
 */
export interface C8RestReader {
  /** Every deployed process-definition key currently known to the engine. */
  searchProcessDefinitionKeys(): Promise<string[]>;
  /** The BPMN XML of one process definition. */
  getProcessDefinitionXml(processDefinitionKey: string): Promise<string>;
}

/** A `fetch`-shaped function, so the HTTP reader is testable without the global. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** Options for {@link httpC8RestReader}. */
export interface HttpC8RestReaderOptions {
  /** The C8 REST base address, e.g. `http://localhost:8080/v2`. */
  readonly restAddress: string;
  /** Optional bearer token for the C8 REST API. */
  readonly token?: string;
  /** Injected `fetch` (defaults to the global). */
  readonly fetch?: FetchLike;
  /** Search page size (C8 caps the result set; the reader pages until drained). */
  readonly pageSize?: number;
}

function trimSlash(address: string): string {
  return address.endsWith("/") ? address.slice(0, -1) : address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asKey(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  const key = item.processDefinitionKey;
  if (typeof key === "string") return key;
  if (typeof key === "number") return String(key);
  return undefined;
}

function itemsOf(body: unknown): unknown[] {
  if (!isRecord(body)) return [];
  return Array.isArray(body.items) ? body.items : [];
}

/**
 * Build a {@link C8RestReader} backed by the live C8 v2 REST API.
 *
 * `searchProcessDefinitionKeys` pages `POST /process-definitions/search` until the
 * engine returns fewer than a full page, de-duplicating keys. `getProcessDefinitionXml`
 * reads `GET /process-definitions/{key}/xml`. Both raise on a non-2xx response so a
 * misconfigured endpoint fails loudly rather than reporting phantom zero demand.
 */
export function httpC8RestReader(options: HttpC8RestReaderOptions): C8RestReader {
  const base = trimSlash(options.restAddress);
  const doFetch: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const pageSize = options.pageSize ?? 100;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

  return {
    async searchProcessDefinitionKeys(): Promise<string[]> {
      const keys: string[] = [];
      const seen = new Set<string>();
      let from = 0;
      for (;;) {
        const response = await doFetch(`${base}/process-definitions/search`, {
          method: "POST",
          headers,
          body: JSON.stringify({ page: { from, limit: pageSize } }),
        });
        if (!response.ok) {
          throw new Error(`C8 REST process-definitions/search failed: ${response.status} ${response.statusText}`);
        }
        const items = itemsOf(await response.json());
        for (const item of items) {
          const key = asKey(item);
          if (key !== undefined && !seen.has(key)) {
            seen.add(key);
            keys.push(key);
          }
        }
        if (items.length < pageSize) break;
        from += items.length;
      }
      return keys;
    },
    async getProcessDefinitionXml(processDefinitionKey: string): Promise<string> {
      const response = await doFetch(`${base}/process-definitions/${encodeURIComponent(processDefinitionKey)}/xml`, {
        method: "GET",
        headers,
      });
      if (!response.ok) {
        throw new Error(
          `C8 REST process-definitions/${processDefinitionKey}/xml failed: ${response.status} ${response.statusText}`,
        );
      }
      return response.text();
    },
  };
}

/**
 * Read every deployed model's `taskDefinition` leaves through a {@link C8RestReader}.
 *
 * Enumerates the deployed definitions, fetches each one's BPMN XML, and scans out
 * its service-task task-definition leaves. The result is the raw demand corpus the
 * {@link ./model.ts} model buckets and diffs against supply.
 */
export async function readDeployedTaskDefinitions(reader: C8RestReader): Promise<TaskDefinitionLeaf[]> {
  const keys = await reader.searchProcessDefinitionKeys();
  const leaves: TaskDefinitionLeaf[] = [];
  for (const key of keys) {
    const xml = await reader.getProcessDefinitionXml(key);
    leaves.push(...scanTaskDefinitions(xml));
  }
  return leaves;
}

/**
 * Read the distinct demanded job types (routing tokens) from the engine — the
 * convenience path for callers that only need the demand token set, not element
 * provenance.
 */
export async function readDeployedTaskTypes(reader: C8RestReader): Promise<string[]> {
  return distinctTaskTypes(await readDeployedTaskDefinitions(reader));
}
