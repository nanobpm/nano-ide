import { decodeFrame } from "./protocol.ts";
import type { Frame } from "./protocol.ts";
import type { Transport, TransportFactory, TransportHooks } from "./transport.ts";

/**
 * An in-memory transport double for exercising the client with no live hub. It
 * records every frame the client sends, lets a test drive the connection
 * lifecycle deterministically (open / deliver / drop / reopen), and can be
 * pointed at by a {@link TransportFactory} so reconnects rebuild it.
 */
export class FakeTransport implements Transport {
  readonly sent: Uint8Array[] = [];
  open = false;
  /**
   * When true, {@link send} throws synchronously WITHOUT firing `onClose` — the
   * minimum a transport is required to do per its contract. Models a channel
   * that signals disconnect solely by throwing, which must still drive the
   * client's reconnect path.
   */
  throwOnSend = false;
  /**
   * When true, {@link close} does NOT fire `onClose` — models a transport whose
   * close is asynchronous (a real WebSocket fires its close event on a later
   * tick) or one that never surfaces its own close. The client must still notify
   * its own `onClose` subscribers on a caller-initiated shutdown.
   */
  silentClose = false;
  private closedLocal = false;

  private readonly hooks: TransportHooks;

  constructor(hooks: TransportHooks) {
    this.hooks = hooks;
  }

  /** Frames decoded from what the client sent, in send order. */
  get sentFrames(): Frame[] {
    return this.sent.map((bytes) => decodeFrame(bytes));
  }

  send(bytes: Uint8Array): void {
    if (this.throwOnSend) {
      throw new Error("fake transport send failure (no onClose)");
    }
    if (!this.open) {
      throw new Error("fake transport not open");
    }
    this.sent.push(bytes);
  }

  close(): void {
    this.closedLocal = true;
    if (this.open) {
      this.open = false;
      if (!this.silentClose) {
        this.hooks.onClose({ local: true });
      }
    }
  }

  /** Simulate the channel coming up. */
  fireOpen(): void {
    this.open = true;
    this.hooks.onOpen();
  }

  /** Simulate a remote drop (hub outage / network loss). */
  drop(info: { code?: number; reason?: string } = {}): void {
    if (this.open) {
      this.open = false;
      this.hooks.onClose({ ...info, local: false });
    }
  }

  /** Deliver a raw inbound frame to the client. */
  deliver(bytes: Uint8Array): void {
    this.hooks.onFrame(bytes);
  }

  wasClosedLocally(): boolean {
    return this.closedLocal;
  }
}

/**
 * A {@link TransportFactory} that hands out {@link FakeTransport}s and records
 * each one it builds, so a test can drive reconnects (the client calls the
 * factory again on every reconnect attempt).
 */
export function fakeTransportFactory(): {
  factory: TransportFactory;
  transports: FakeTransport[];
  last(): FakeTransport;
} {
  const transports: FakeTransport[] = [];
  const factory: TransportFactory = (_url, hooks) => {
    const transport = new FakeTransport(hooks);
    transports.push(transport);
    return transport;
  };
  return {
    factory,
    transports,
    last: () => {
      const transport = transports[transports.length - 1];
      if (transport === undefined) {
        throw new Error("fakeTransportFactory().last() called before any transport was created");
      }
      return transport;
    },
  };
}
