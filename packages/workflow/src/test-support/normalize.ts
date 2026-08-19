// Canonicalize a BPMN 2.0 document down to its SEMANTIC structure, so two models
// that mean the same thing compare equal regardless of element ids, child
// ordering, or diagram-interchange (DI) layout. This is the oracle S1–S6 assert
// their derived flows against.
//
// What "semantic structure" keeps (and what it deliberately drops):
//   - DROPPED: the `bpmndi:BPMNDiagram` layout subtree (shapes, edges, bounds);
//     every element `id` and every `sequenceFlow` id (canonicalized away — a
//     flow node is identified by its TYPE + semantic definition, an edge by its
//     endpoints); cosmetic `name` labels on flow nodes and gateways (the routing
//     meaning lives in edge conditions and in derived task/message identities,
//     not in a human label); child ORDER (everything is compared as a sorted
//     multiset).
//   - KEPT: flow nodes (tasks, gateways, events) with their semantic definition
//     (task-definition job type, user-task / form / assignment / io-mapping /
//     linked-resources extension elements, multi-instance characteristics, event
//     definitions); sequence flows as endpoint pairs with their condition /
//     default marker; message subscriptions (a catch event's `messageRef`
//     resolved to the referenced message NAME); timer definitions; and boundary
//     events (their `attachedToRef` modelled as a structural attach edge to the
//     host, never as a raw-id attribute).

import { localName, parseXml, type XmlElement } from "./xml.js";

/** The id-agnostic, order-agnostic semantic structure of a BPMN model. Two
 *  models are structurally equal iff their three multisets are equal. */
export interface CanonicalModel {
  /** Semantic descriptor of every flow node (task/gateway/event/subProcess),
   *  sorted. Each carries its type, definition, and edge-degree signature. */
  nodes: string[];
  /** Every sequence flow as `«fromNode» =[tag]=> «toNode»`, plus structural
   *  attach (boundary→host) and containment (subProcess→child) edges, sorted. */
  flows: string[];
  /** Names of every message a catch event subscribes to, sorted (deduped). */
  messages: string[];
}

const FLOW_NODES = new Set([
  "startEvent",
  "endEvent",
  "intermediateCatchEvent",
  "intermediateThrowEvent",
  "boundaryEvent",
  "task",
  "serviceTask",
  "userTask",
  "scriptTask",
  "sendTask",
  "receiveTask",
  "manualTask",
  "businessRuleTask",
  "callActivity",
  "subProcess",
  "adHocSubProcess",
  "transaction",
  "exclusiveGateway",
  "parallelGateway",
  "inclusiveGateway",
  "eventBasedGateway",
  "complexGateway",
]);

const REF_ATTRS = new Set(["messageRef", "errorRef", "signalRef", "escalationRef"]);

function isDI(el: XmlElement): boolean {
  const prefix = el.name.includes(":") ? el.name.slice(0, el.name.indexOf(":")) : "";
  if (prefix === "bpmndi" || prefix === "di" || prefix === "dc" || prefix === "omgdi" || prefix === "omgdc") {
    return true;
  }
  const l = localName(el.name);
  return l === "BPMNDiagram" || l === "BPMNPlane" || l === "BPMNShape" || l === "BPMNEdge" || l === "BPMNLabel";
}

interface Node {
  id: string;
  type: string;
  label: string;
}

interface Edge {
  kind: "seq" | "attach" | "contain";
  from: string;
  to: string;
  tag: string;
}

/** Accumulates the flat graph while walking every process / sub-process. */
class Collector {
  readonly refNames = new Map<string, string>();
  readonly nodes = new Map<string, Node>();
  readonly edges: Edge[] = [];
  readonly messages = new Set<string>();
  readonly defaultFlows = new Set<string>();
  private readonly seqFlows: XmlElement[] = [];

  /** Resolve a *Ref value to the referenced element's name (falling back to the
   *  raw ref only when the target is unknown), recording message subscriptions. */
  private resolveRef(attr: string, value: string): string {
    const name = this.refNames.get(value) ?? value;
    if (attr === "messageRef") this.messages.add(name);
    return `@${name}`;
  }

  /** Serialize a definition/extension descendant fully (all descendants), with
   *  sorted attributes (ids dropped, refs resolved) and sorted children, so the
   *  string is invariant to attribute/child ordering and to id renaming. */
  private serialize(el: XmlElement): string {
    const attrs = Object.entries(el.attrs)
      .filter(([k]) => k !== "id")
      .map(([k, v]) => `${k}=${REF_ATTRS.has(k) ? this.resolveRef(k, v) : v}`)
      .sort();
    const kids = el.children.filter((c) => !isDI(c)).map((c) => this.serialize(c)).sort();
    const text = el.text ? `=${el.text}` : "";
    return `${localName(el.name)}{${attrs.join(",")}}${text}[${kids.join(";")}]`;
  }

  /** The id-agnostic semantic descriptor of a flow node: its type, its own
   *  discriminating attributes, and its definition subtree — but NOT nested flow
   *  nodes / sequence flows (those are separate graph entities) and NOT cosmetic
   *  id / name / structural-ref attributes. */
  private nodeLabel(el: XmlElement): string {
    const excluded = new Set(["id", "name", "default", "attachedToRef", "sourceRef", "targetRef"]);
    const attrs = Object.entries(el.attrs)
      .filter(([k]) => !excluded.has(k))
      .map(([k, v]) => `${k}=${REF_ATTRS.has(k) ? this.resolveRef(k, v) : v}`)
      .sort();
    const defs = el.children
      .filter((c) => {
        const cl = localName(c.name);
        // Skip nested flow nodes / sequence flows (separate graph entities) and
        // the `incoming`/`outgoing` flow-id back-references (fully redundant with
        // the sequence-flow edges, and carrying raw ids that must not leak here).
        return !isDI(c) && !FLOW_NODES.has(cl) && cl !== "sequenceFlow" && cl !== "incoming" && cl !== "outgoing";
      })
      .map((c) => this.serialize(c))
      .sort();
    return `${localName(el.name)}(${attrs.join(",")})[${defs.join(";")}]`;
  }

  private registerNode(el: XmlElement): void {
    const id = el.attrs.id;
    if (!id) return;
    this.nodes.set(id, { id, type: localName(el.name), label: this.nodeLabel(el) });
    if (el.attrs.default) this.defaultFlows.add(el.attrs.default);
  }

  /** Walk a container (process or sub-process), registering its flow nodes and
   *  sequence flows and recursing into nested sub-processes. `scope` is the
   *  enclosing sub-process id (containment edges point scope→child). */
  collectContainer(container: XmlElement, scope: string | undefined): void {
    for (const child of container.children) {
      if (isDI(child)) continue;
      const l = localName(child.name);
      if (FLOW_NODES.has(l)) {
        this.registerNode(child);
        const id = child.attrs.id;
        if (id && scope) this.edges.push({ kind: "contain", from: scope, to: id, tag: "" });
        if (l === "boundaryEvent" && child.attrs.attachedToRef && id) {
          this.edges.push({ kind: "attach", from: id, to: child.attrs.attachedToRef, tag: "" });
        }
        if (l === "subProcess" || l === "adHocSubProcess" || l === "transaction") {
          this.collectContainer(child, id);
        }
      } else if (l === "sequenceFlow") {
        this.seqFlows.push(child);
      }
    }
  }

  /** Turn collected sequence-flow elements into endpoint edges once every node
   *  and default marker is known. */
  finalizeFlows(): void {
    for (const sf of this.seqFlows) {
      const from = sf.attrs.sourceRef;
      const to = sf.attrs.targetRef;
      if (!from || !to) continue;
      const cond = sf.children.find((c) => localName(c.name) === "conditionExpression");
      let tag = "";
      if (cond?.text) tag = `if:${cond.text}`;
      else if (sf.attrs.id && this.defaultFlows.has(sf.attrs.id)) tag = "default";
      this.edges.push({ kind: "seq", from, to, tag });
    }
  }
}

/** Record every referenceable root definition (`message`/`error`/`signal`/
 *  `escalation`) so a `*Ref` can be resolved to a stable name. */
function collectRefs(el: XmlElement, c: Collector): void {
  const l = localName(el.name);
  if ((l === "message" || l === "error" || l === "signal" || l === "escalation") && el.attrs.id) {
    c.refNames.set(el.attrs.id, el.attrs.name ?? el.attrs.errorCode ?? el.attrs.id);
  }
  for (const child of el.children) if (!isDI(child)) collectRefs(child, c);
}

function findContainers(el: XmlElement, out: XmlElement[]): void {
  const l = localName(el.name);
  if (l === "process") out.push(el);
  for (const child of el.children) if (!isDI(child)) findContainers(child, out);
}

/** Normalize a BPMN XML document to its canonical semantic model. Strips DI and
 *  canonicalizes ids, child ordering, and sequence-flow ids so only semantic
 *  structure remains. */
export function normalize(bpmnXml: string): CanonicalModel {
  const root = parseXml(bpmnXml);
  const c = new Collector();
  collectRefs(root, c);

  const processes: XmlElement[] = [];
  findContainers(root, processes);
  if (processes.length === 0) throw new Error("normalize: no <process> element found");
  for (const p of processes) c.collectContainer(p, undefined);
  c.finalizeFlows();

  // Per-node edge-degree signature — captures wiring (how many sequence flows in
  // / out, whether it hosts or is a boundary, whether it contains or is
  // contained) so a rewiring that preserves node labels still shows up.
  const deg = new Map<string, { si: number; so: number; at: number; ah: number; ci: number; co: number }>();
  const bump = (id: string) => {
    let d = deg.get(id);
    if (!d) {
      d = { si: 0, so: 0, at: 0, ah: 0, ci: 0, co: 0 };
      deg.set(id, d);
    }
    return d;
  };
  for (const e of c.edges) {
    if (e.kind === "seq") {
      bump(e.from).so += 1;
      bump(e.to).si += 1;
    } else if (e.kind === "attach") {
      bump(e.from).at += 1; // this node is a boundary attached to something
      bump(e.to).ah += 1; // this node hosts a boundary
    } else {
      bump(e.from).co += 1; // this sub-process contains children
      bump(e.to).ci += 1; // this node is contained
    }
  }

  const labelWithDegree = (id: string): string => {
    const node = c.nodes.get(id);
    if (!node) return `«unknown:${id}»`;
    const d = deg.get(id) ?? { si: 0, so: 0, at: 0, ah: 0, ci: 0, co: 0 };
    return `${node.label}<in=${d.si},out=${d.so},boundary=${d.at},hosts=${d.ah},contained=${d.ci},contains=${d.co}>`;
  };

  const nodes = [...c.nodes.keys()].map(labelWithDegree).sort();
  const flows = c.edges
    .map((e) => {
      const arrow = e.kind === "attach" ? "--attach-->" : e.kind === "contain" ? "--contains-->" : `=[${e.tag}]=>`;
      return `${labelWithDegree(e.from)} ${arrow} ${labelWithDegree(e.to)}`;
    })
    .sort();
  const messages = [...c.messages].sort();

  return { nodes, flows, messages };
}
