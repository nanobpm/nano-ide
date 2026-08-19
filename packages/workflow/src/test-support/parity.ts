// The two assertions S1–S6 build their derivation-parity tests on:
//
//   assertDerivationParity(derivedFlow, goldenBpmnPath)
//     Derive the flow's BPMN, normalize it and the checked-in golden, and assert
//     they are structurally equal — throwing a legible red/green diff otherwise.
//
//   deploySmoke(derivedModel, opts?)
//     Deploy the derived model to a live/wasm engine and assert acceptance. When
//     no engine is reachable (no client, baseUrl, or WORKFLOW_GATEWAY_URL), it
//     resolves `{ deployed: false, skipped: true }` so unit-only CI stays green —
//     the caller decides whether to hard-require deployment.

import { readFileSync } from "node:fs";
import { WorkflowClient, type WorkflowClientOptions } from "../client.js";
import { declarativeToBpmn } from "../declarative.js";
import type { DeclarativeFlow, DeployResult, Workflow } from "../types.js";
import { diffModels } from "./diff.js";
import { normalize } from "./normalize.js";

/** A derived flow, or the derived BPMN XML directly. */
export type DerivedInput = DeclarativeFlow | string;

function toBpmnXml(input: DerivedInput): string {
  if (typeof input === "string") return input;
  return declarativeToBpmn(input);
}

/** Derive `derived`'s BPMN, normalize it and the golden at `goldenBpmnPath`, and
 *  assert structural equality. Throws with a legible structural diff on
 *  mismatch. Returns silently on parity. */
export function assertDerivationParity(derived: DerivedInput, goldenBpmnPath: string): void {
  const derivedXml = toBpmnXml(derived);
  const goldenXml = readFileSync(goldenBpmnPath, "utf8");
  const golden = normalize(goldenXml);
  const actual = normalize(derivedXml);
  const diff = diffModels(golden, actual);
  if (diff) {
    throw new Error(`derivation parity failed against ${goldenBpmnPath}:\n${diff}`);
  }
}

/** Options for {@link deploySmoke}. Supply a pre-built `client`, a `baseUrl`
 *  (a client is built for you), or rely on the `WORKFLOW_GATEWAY_URL` env var. */
export interface DeploySmokeOptions {
  client?: WorkflowClient;
  baseUrl?: string;
  token?: string;
  transport?: "auto" | "falcon" | "rest";
}

/** The outcome of a {@link deploySmoke}: either a completed deployment, or a
 *  skip because no engine was reachable. */
export interface DeploySmokeResult {
  deployed: boolean;
  skipped: boolean;
  reason?: string;
  result?: DeployResult;
}

function resolveClient(opts: DeploySmokeOptions): WorkflowClient | undefined {
  if (opts.client) return opts.client;
  const baseUrl = opts.baseUrl ?? process.env.WORKFLOW_GATEWAY_URL;
  if (!baseUrl) return undefined;
  const clientOpts: WorkflowClientOptions = {
    baseUrl,
    ...(opts.token ? { token: opts.token } : {}),
    ...(opts.transport ? { transport: opts.transport } : {}),
  };
  return new WorkflowClient(clientOpts);
}

/** Deploy `model` to the engine and assert the deployment is accepted. Resolves
 *  a skip (never throws) when no engine is reachable, so it is safe to call in
 *  unit-only CI; it throws only when a reachable engine REJECTS the model. */
export async function deploySmoke(model: Workflow, opts: DeploySmokeOptions = {}): Promise<DeploySmokeResult> {
  const client = resolveClient(opts);
  if (!client) {
    return { deployed: false, skipped: true, reason: "no engine reachable (set baseUrl/client/WORKFLOW_GATEWAY_URL)" };
  }
  const result = await client.deploy(model);
  if (!result || typeof result !== "object") {
    throw new Error(`deploySmoke: engine did not accept "${model.id}" (empty deploy result)`);
  }
  return { deployed: true, skipped: false, result };
}
