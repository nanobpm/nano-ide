// effectlite — a tiny, ZERO-DEPENDENCY, Effect-like core for Urban glue code.
//
// Urban's published surface is declarative JSON + a client renderer, so we do
// NOT want the `effect` package (bundle weight + viral paradigm) in the runtime.
// But the imperative seams — workers, provisioning, resource lifecycles — still
// benefit from the three Effect ergonomics we actually reach for. effectlite
// gives us those, in ~100 LOC of implementation with no runtime dependencies:
//
//   1. A typed-error `Result<A, E>` whose `E` composes automatically through
//      generator do-notation (`gen(function*(){ const x = yield* step })`),
//      short-circuiting on the first failure exactly like `Effect.gen` + `yield*`.
//   2. `tag()` tagged errors (cf. `Data.TaggedError`) + exhaustive `matchTags`
//      (cf. `catchTags`) — the compiler forces every failure mode to be handled.
//   3. `scoped` + `acquireRelease` (cf. `Effect.scoped`) — releases run on every
//      exit: success, failure, and thrown.
//
// It is synchronous over `Result`; the scope is async only so disposers may
// await. Consume via `import { gen, ok, fail } from "@nanobpm/urban/effect"`.

// ---------------------------------------------------------------------------
// Result + generator do-notation
// ---------------------------------------------------------------------------

export type Result<A, E> = Ok<A> | Fail<E>;

export class Ok<A> {
  readonly _tag = "Ok" as const;
  readonly value: A;
  constructor(value: A) {
    this.value = value;
  }
  // Delegated by `yield*`: returns the value, yields nothing to the driver.
  *[Symbol.iterator](): Generator<never, A, unknown> {
    return this.value;
  }
}

export class Fail<E> {
  readonly _tag = "Fail" as const;
  readonly error: E;
  constructor(error: E) {
    this.error = error;
  }
  // Delegated by `yield*`: yields itself so the driver can short-circuit; never
  // resumes (the driver abandons the generator on the first failure).
  *[Symbol.iterator](): Generator<Fail<E>, never, unknown> {
    yield this;
    throw new Error("effectlite: generator resumed after a failure");
  }
}

export const ok = <A>(value: A): Ok<A> => new Ok(value);
export const fail = <E>(error: E): Fail<E> => new Fail(error);

export const isOk = <A, E>(r: Result<A, E>): r is Ok<A> => r._tag === "Ok";
export const isFail = <A, E>(r: Result<A, E>): r is Fail<E> => r._tag === "Fail";

// Run a generator that `yield*`s Results. Because only `Fail` yields to us, a
// single `next()` either lands on the first failure or on the final return.
// `Y` captures the UNION of every yielded `Fail<…>`; `Y["error"]` distributes
// that index access into the Result's error channel (a union in ⇒ a union out).
export function gen<Y extends Fail<unknown>, A>(
  body: () => Generator<Y, A, unknown>,
): Result<A, Y["error"]> {
  // Typed as `Iterator` (not `Generator`) so `return` is the optional-arg
  // variant — lets us close a short-circuited body without inventing a return value.
  const it: Iterator<Y, A> = body();
  const step = it.next();
  if (step.done) return ok(step.value);
  // Not done ⇒ a `Fail` yielded to short-circuit. Close the generator first so
  // any `try/finally` in the body runs and captured resources aren't retained,
  // then surface its error on the failure channel.
  it.return?.();
  return fail(step.value.error);
}

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

// Extract the success/error channels from a `Result` (including a value typed as
// the union `Result<A, E>`), so the combinators below infer `A`/`E` cleanly
// instead of collapsing them to `unknown` on union inputs.
export type OkOf<R> = R extends Ok<infer A> ? A : never;
export type ErrOf<R> = R extends Fail<infer E> ? E : never;

// Narrowing guards that carry the *extracted* channel type, so `r.value` /
// `r.error` land as `OkOf<R>` / `ErrOf<R>` (not `unknown`) with no assertion —
// keeping the combinators within the repo's no-type-assertion convention.
const isOkOf = <R extends Result<unknown, unknown>>(r: R): r is R & Ok<OkOf<R>> => r._tag === "Ok";
const isFailOf = <R extends Result<unknown, unknown>>(r: R): r is R & Fail<ErrOf<R>> => r._tag === "Fail";

export const map = <R extends Result<unknown, unknown>, B>(
  r: R,
  f: (a: OkOf<R>) => B,
): Result<B, ErrOf<R>> => {
  if (isOkOf(r)) return ok(f(r.value));
  if (isFailOf(r)) return r;
  throw new Error("effectlite: Result was neither Ok nor Fail");
};

export const mapError = <R extends Result<unknown, unknown>, E2>(
  r: R,
  f: (e: ErrOf<R>) => E2,
): Result<OkOf<R>, E2> => {
  if (isFailOf(r)) return fail(f(r.error));
  if (isOkOf(r)) return r;
  throw new Error("effectlite: Result was neither Ok nor Fail");
};

export const match = <R extends Result<unknown, unknown>, T>(
  r: R,
  onOk: (a: OkOf<R>) => T,
  onFail: (e: ErrOf<R>) => T,
): T => {
  if (isOkOf(r)) return onOk(r.value);
  if (isFailOf(r)) return onFail(r.error);
  throw new Error("effectlite: Result was neither Ok nor Fail");
};

// ---------------------------------------------------------------------------
// Tagged errors + exhaustive matching
// ---------------------------------------------------------------------------

export type Tagged<Tag extends string> = { readonly _tag: Tag };

// A distributive `Tagged<Tag> & P`: when `Tag` is a union (e.g. a
// `"merged" | "queued" | "blocked"` outcome), this expands to a discriminated
// UNION of tagged objects — `({_tag:"merged"} & P) | ({_tag:"queued"} & P) | …`
// — not a single object with a union-typed `_tag`. That is what lets `matchTags`
// `Extract` each variant and force an exhaustive handler per case.
export type TagUnion<Tag extends string, P> = Tag extends string ? Tagged<Tag> & P : never;

// Overloaded so the extra props type only appears when props are actually
// passed: `tag("X")` is exactly `Tagged<"X">` (no phantom `& P` that could read
// as `undefined` at runtime), while `tag("X", props)` carries them. Both return
// the distributive `TagUnion`, so a union `Tag` expands to a discriminated union.
// `props` is forbidden from carrying its own `_tag` (`{ _tag?: never }`) so it
// cannot shadow the discriminant, and the runtime spreads `props` *first* so the
// tag always wins even for props arriving through an untyped boundary.
export function tag<Tag extends string>(t: Tag): TagUnion<Tag, {}>;
export function tag<Tag extends string, P extends object>(
  t: Tag,
  props: P & { _tag?: never },
): TagUnion<Tag, P>;
export function tag(t: string, props?: object): Tagged<string> {
  return { ...props, _tag: t };
}

// Handle every tag in the union — the handlers object is keyed by `E["_tag"]`,
// so omitting a variant is a COMPILE error (no accidental dropped failure mode).
export const matchTags = <E extends Tagged<string>, R>(
  e: E,
  handlers: { [K in E["_tag"]]: (e: Extract<E, Tagged<K>>) => R },
): R =>
  // biome-ignore lint/plugin: the mapped handler type is precise for callers; internally we index it with the runtime tag, which needs this erasure to a plain record.
  (handlers as unknown as Record<string, (e: E) => R>)[e._tag](e);

// ---------------------------------------------------------------------------
// Scoped resources
// ---------------------------------------------------------------------------

export class Scope {
  #disposers: Array<() => void | Promise<void>> = [];
  add(dispose: () => void | Promise<void>): void {
    this.#disposers.push(dispose);
  }
  async close(): Promise<void> {
    // LIFO, best-effort — a failing disposer never blocks the others.
    for (const d of this.#disposers.reverse()) {
      try { await d(); } catch { /* best effort */ }
    }
    this.#disposers = [];
  }
}

// Acquire a resource and register its release with the scope in one step.
export function acquireRelease<A>(scope: Scope, acquire: () => A, release: (a: A) => void | Promise<void>): A {
  const a = acquire();
  scope.add(() => release(a));
  return a;
}

// Run `body` with a fresh scope; close it (releasing all resources) on every
// exit path — return, Result failure, or thrown.
export async function scoped<A>(body: (scope: Scope) => A | Promise<A>): Promise<A> {
  const scope = new Scope();
  try {
    return await body(scope);
  } finally {
    await scope.close();
  }
}
