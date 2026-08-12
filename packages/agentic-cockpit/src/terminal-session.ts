/**
 * The worker terminal session — S8's drill-into-a-worker live terminal.
 *
 * A consumer of the S5 relay sub-protocol that **survives a cockpit reconnect**
 * via resume-from-offset. It is deliberately timer-free and transport-free: it
 * emits the relay messages to send ({@link RelaySend}) and consumes the relay
 * messages received ({@link TerminalSession.handle}), tracking exactly one piece
 * of durable state — `nextOffset`, the offset to resume from. On any (re)attach
 * it re-subscribes from `nextOffset`, and it drops any replayed chunk it has
 * already applied, so a reconnect neither loses nor double-writes output (within
 * the relay ring's retained window). If the hub's `subscribed` ack reports a
 * `nextOffset` (stream head) *below* our resume point — a hub restart/reset left
 * us ahead of the stream — it clamps `nextOffset` back down so fresh chunks are
 * not dropped as stale.
 *
 * The S5 relay wire (see `@nanobpm/agentic-relay`):
 *  - outbound `{ op: "subscribe", stream, from, credit }` — (re)attach and resume,
 *  - outbound `{ op: "credit", credit }`                  — grant more bulk credit,
 *  - inbound  `{ op: "subscribed", stream, gap, nextOffset }` — the resume ack
 *             (`gap: boolean` — the S5 wire flags whether chunks aged out),
 *  - inbound  {@link RelayPayload} `{ stream, offset, chunk }` — a data chunk.
 */
import type { RelayPayload } from "@nanobpm/agentic-protocol";

/** The terminal sink the session writes decoded output to (xterm.js satisfies this). */
export interface TerminalSink {
  /** Append a chunk of terminal output. */
  write(chunk: string): void;
}

/** An outbound relay message the session asks its transport to send. */
export type RelayOutbound =
  | { readonly op: "subscribe"; readonly stream: string; readonly from: number; readonly credit: number }
  | { readonly op: "credit"; readonly credit: number };

/** An inbound relay message the session consumes (a data chunk or a resume ack). */
export type RelayInbound =
  | RelayPayload
  | { readonly op: "subscribed"; readonly stream: string; readonly gap: boolean; readonly nextOffset: number };

/** Sends one outbound relay message over the channel. */
export type RelaySend = (message: RelayOutbound) => void;

export interface TerminalSessionOptions {
  /** The relay stream id (one worker's terminal). */
  readonly stream: string;
  /** Where decoded output is written. */
  readonly sink: TerminalSink;
  /** Emits outbound relay messages. */
  readonly send: RelaySend;
  /** Bulk credit requested on each (re)subscribe. Default 1024. */
  readonly credit?: number;
  /** Offset to resume from on first attach. Default 0 (from the start). */
  readonly from?: number;
  /** Notified when the resume ack reports a gap (chunks aged out of the ring). */
  readonly onGap?: () => void;
}

const DEFAULT_CREDIT = 1024;

function isRelayData(message: RelayInbound): message is RelayPayload {
  return !("op" in message);
}

/**
 * A resume-from-offset consumer of one relay stream. Construct once per worker
 * drill-in; call {@link attach} on every (re)connection and feed every inbound
 * relay message to {@link handle}.
 */
export class TerminalSession {
  readonly #stream: string;
  readonly #sink: TerminalSink;
  readonly #send: RelaySend;
  readonly #credit: number;
  readonly #onGap: TerminalSessionOptions["onGap"];
  /** The next offset we still need — everything below it has been applied. */
  #nextOffset: number;
  /** Whether the most recent resume ack reported a gap (retained window overrun). */
  #gap = false;

  constructor(options: TerminalSessionOptions) {
    this.#stream = options.stream;
    this.#sink = options.sink;
    this.#send = options.send;
    this.#credit = options.credit ?? DEFAULT_CREDIT;
    this.#onGap = options.onGap;
    const from = options.from ?? 0;
    if (!Number.isInteger(from) || from < 0) {
      throw new RangeError(`TerminalSession.from must be a non-negative integer, got ${from}`);
    }
    this.#nextOffset = from;
  }

  /** The stream id this session follows. */
  get stream(): string {
    return this.#stream;
  }

  /** The offset the session will resume from on the next {@link attach}. */
  get nextOffset(): number {
    return this.#nextOffset;
  }

  /** Whether the most recent resume ack reported a gap (false when none was lost). */
  get gap(): boolean {
    return this.#gap;
  }

  /**
   * (Re)subscribe to the stream, resuming from {@link nextOffset}. Call this on
   * first connect AND after every reconnect — because it always resumes from the
   * offset just past the last applied chunk, a reconnect replays only the
   * un-applied tail (no loss) and re-delivered chunks below `nextOffset` are
   * dropped by {@link handle} (no duplication).
   */
  attach(): void {
    this.#send({ op: "subscribe", stream: this.#stream, from: this.#nextOffset, credit: this.#credit });
  }

  /** Grant additional bulk credit (backpressure release) mid-stream. */
  grant(credit: number): void {
    if (!Number.isInteger(credit) || credit <= 0) {
      throw new RangeError(`TerminalSession.grant credit must be a positive integer, got ${credit}`);
    }
    this.#send({ op: "credit", credit });
  }

  /**
   * Process one inbound relay message. A data chunk at or beyond `nextOffset` is
   * written and advances the resume point; a chunk below it (a duplicate replay
   * after a reconnect) is dropped. A resume ack records any gap and clamps the
   * resume point down to the hub's head when we are ahead of it.
   */
  handle(message: RelayInbound): void {
    if (isRelayData(message)) {
      this.#onData(message);
      return;
    }
    if (message.op === "subscribed" && message.stream === this.#stream) {
      this.#onSubscribed(message.gap, message.nextOffset);
    }
  }

  #onData(data: RelayPayload): void {
    if (data.stream !== this.#stream) return;
    // Idempotent apply: a reconnect resubscribes from nextOffset, so the hub may
    // re-deliver the boundary chunk; anything we have already applied is dropped.
    if (data.offset < this.#nextOffset) return;
    this.#sink.write(data.chunk);
    this.#nextOffset = data.offset + 1;
  }

  #onSubscribed(gap: boolean, nextOffset: number): void {
    // Clamp our resume point down to the hub's current head when we are ahead of
    // it. Without this, a hub restart/reset (or a `from` seeded past the head)
    // leaves #nextOffset above every offset the hub will now emit, so #onData
    // silently drops all fresh chunks until the stream catches back up — losing
    // terminal output, possibly indefinitely. Only clamp DOWN: a head at or above
    // #nextOffset is the normal case and must not skip un-applied chunks.
    if (nextOffset < this.#nextOffset) {
      this.#nextOffset = nextOffset;
    }
    // Record the gap on every ack so a later no-gap resume clears a prior gap.
    this.#gap = gap;
    if (gap) {
      this.#onGap?.();
    }
  }
}
