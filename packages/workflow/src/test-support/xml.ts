// A dependency-free XML reader, just enough to parse a BPMN 2.0 document into a
// tree the normalizer can canonicalize. BPMN files this package emits (and the
// hand-authored goldens) are plain XML — elements, attributes, text — with no
// DTDs, processing instructions beyond the `<?xml …?>` prolog, or mixed-content
// subtleties that would need a full parser. We keep prefixed names verbatim
// (`bpmn:serviceTask`, `zeebe:taskDefinition`) so the normalizer can reason about
// namespaces by local name.

/** A parsed XML element. `attrs` preserves declared attributes (entity-decoded);
 *  `children` are child elements in document order; `text` is the concatenated
 *  direct text content (trimmed), used for elements like `conditionExpression`. */
export interface XmlElement {
  /** The qualified name as written, e.g. `bpmn:serviceTask` or `process`. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/** The local (un-prefixed) name of an element or attribute. */
export function localName(qualified: string): string {
  const i = qualified.indexOf(":");
  return i === -1 ? qualified : qualified.slice(i + 1);
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "amp":
        return "&";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Only decode a valid Unicode scalar value. `String.fromCodePoint` throws
      // a `RangeError` for code points outside 0..0x10FFFF (e.g. `&#x110000;`),
      // and surrogate halves (0xD800..0xDFFF) are not valid characters — treat
      // any such reference as malformed and leave it verbatim rather than
      // throwing an opaque exception out of `parseXml`.
      const isScalar = Number.isInteger(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return isScalar ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null = re.exec(src);
  while (m !== null) {
    const value = m[3] !== undefined ? m[3] : (m[4] ?? "");
    attrs[m[1]] = decodeEntities(value);
    m = re.exec(src);
  }
  return attrs;
}

function appendText(el: XmlElement, chunk: string): void {
  if (chunk) el.text = el.text ? `${el.text} ${chunk}` : chunk;
}

/** Parse an XML document into its root element. Throws on a malformed document
 *  (unbalanced tags, no root, or more than one top-level element). Comments,
 *  CDATA, the `<?xml?>` prolog and other processing instructions are handled;
 *  CDATA content contributes to `text`. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) break;
    if (lt > i) appendText(stack[stack.length - 1], decodeEntities(xml.slice(i, lt)).trim());
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new Error("parseXml: unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new Error("parseXml: unterminated CDATA");
      appendText(stack[stack.length - 1], xml.slice(lt + 9, end).trim());
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end === -1) throw new Error("parseXml: unterminated processing instruction / declaration");
      i = end + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt === -1) throw new Error("parseXml: unterminated tag");
    let inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const closeName = inner.slice(1).trim();
      if (stack.length <= 1) throw new Error(`parseXml: unbalanced end tag </${closeName}>`);
      const open = stack.pop();
      if (open === undefined || open.name !== closeName) {
        throw new Error(`parseXml: mismatched end tag </${closeName}> (expected </${open?.name ?? "#root"}>)`);
      }
      i = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^\s*(\S+)/.exec(inner);
    if (!nameMatch) throw new Error("parseXml: malformed start tag");
    const name = nameMatch[1];
    const attrs = parseAttrs(inner.slice(nameMatch[0].length));
    const el: XmlElement = { name, attrs, children: [], text: "" };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
    i = gt + 1;
  }
  if (stack.length !== 1) {
    const unclosed = stack
      .slice(1)
      .map((el) => `<${el.name}>`)
      .join(", ");
    throw new Error(`parseXml: unclosed tag(s): ${unclosed}`);
  }
  if (root.children.length === 0) throw new Error("parseXml: no root element");
  if (root.children.length > 1) {
    const roots = root.children.map((el) => `<${el.name}>`).join(", ");
    throw new Error(`parseXml: multiple root elements (${roots}) — a well-formed document has exactly one`);
  }
  return root.children[0];
}
