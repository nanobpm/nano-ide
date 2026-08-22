// A small fake DOM for unit-testing the browser runtime's element-building code
// (the shared form-js renderer and the dataGrid engine-form path) under Node,
// without a real browser. Records every created node so a test can grab an input
// or button and fire its listeners. Kept intentionally minimal — it supports only
// the DOM surface those functions touch.

export class FakeElement {
  tagName: string;
  attributes: Record<string, string> = {};
  className = "";
  children: Array<FakeElement | { text: string }> = [];
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  checked = false;
  type = "";
  name = "";
  id = "";
  listeners: Record<string, Array<(ev: unknown) => unknown>> = {};

  constructor(tag: string) {
    this.tagName = String(tag).toUpperCase();
  }
  setAttribute(k: string, v: unknown): void {
    this.attributes[k] = String(v);
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string): string | null {
    return k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(type: string, fn: (ev: unknown) => unknown): void {
    (this.listeners[type] ||= []).push(fn);
  }
  async fire(type: string, ev: unknown = { preventDefault() {}, stopPropagation() {} }): Promise<void> {
    for (const fn of this.listeners[type] || []) await fn(ev);
  }
  append(...kids: Array<FakeElement | { text: string } | string>): void {
    for (const kid of kids) {
      if (typeof kid === "string") {
        this.children.push({ text: kid });
        this.textContent += kid;
      } else if ("text" in kid) {
        this.children.push(kid);
        this.textContent += kid.text;
      } else {
        this.children.push(kid);
        this.textContent += kid.textContent || "";
      }
    }
  }
  appendChild(kid: FakeElement | { text: string }): void {
    this.append(kid);
  }
  replaceChildren(...kids: Array<FakeElement | { text: string } | string>): void {
    this.children = [];
    this.textContent = "";
    this.append(...kids);
  }
  get firstChild(): FakeElement | { text: string } | null {
    return this.children[0] ?? null;
  }
  querySelector(selector: string): FakeElement | null {
    const walk = (nodes: Array<FakeElement | { text: string }>): FakeElement | null => {
      for (const kid of nodes) {
        if (kid instanceof FakeElement) {
          if (fakeSelectorMatches(kid, selector)) return kid;
          const found = walk(kid.children);
          if (found) return found;
        }
      }
      return null;
    };
    return walk(this.children);
  }
}

// Minimal CSS-selector matcher for the DOM surface the browser runtime touches
// (currently the radio group's `input:checked` lookup). Supports an optional tag
// name plus `:checked`; any other pseudo/selector deliberately fails to match so
// unsupported queries surface rather than silently returning a wrong node.
function fakeSelectorMatches(node: FakeElement, selector: string): boolean {
  const parts = selector.trim().split(":");
  const tag = parts[0];
  if (tag && node.tagName !== tag.toUpperCase()) return false;
  for (const pseudo of parts.slice(1)) {
    if (pseudo === "checked") {
      if (!node.checked) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** Install a fake `document` on globalThis; returns a restore function. */
export function installFakeDom(created: FakeElement[]): () => void {
  const doc = {
    createElement: (tag: string) => {
      const n = new FakeElement(tag);
      created.push(n);
      return n;
    },
    createTextNode: (text: string) => ({ text: String(text) }),
    getElementById: () => null,
    dispatchEvent: () => true,
  };
  const prior = Reflect.getOwnPropertyDescriptor(globalThis, "document");
  Reflect.set(globalThis, "document", doc);
  return () => {
    if (prior) Reflect.defineProperty(globalThis, "document", prior);
    else Reflect.deleteProperty(globalThis, "document");
  };
}
