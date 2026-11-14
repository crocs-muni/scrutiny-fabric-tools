/**
 * The relay transport the NIP-46 client is designed against, not an implementation of it (#108 A2).
 *
 * A2 could not use a socket library without also owning its lifecycle, reconnect policy, and the
 * relay client A4 already needs for publishing. So the boundary is drawn one level below NIP-46:
 * the client speaks NIP-01 relay frames (`["EVENT", …]`, `["REQ", …]`), and whoever wires the server
 * supplies a `RelayTransport` backed by `ws` or a platform WebSocket. Tests supply the in-memory
 * fake in `test/nip46.test.ts`.
 *
 * Keeping the port frame-shaped rather than event-shaped is deliberate: `REQ` needs a subscription
 * id and the client must see `EOSE`, and a raw-`string` port would push `JSON.parse` into the
 * crypto module for no reason.
 */

/** A decoded NIP-01 relay frame; the first element is the frame type. */
export type RelayFrame = readonly [string, ...(readonly unknown[])]

/** One live relay connection. */
export interface RelaySocket {
  /** Send one already-serialized relay frame. */
  send(frame: string): void
  /**
   * Subscribe to decoded inbound frames. Returns the unsubscribe function; a returned value is
   * required so `close()` can order unsubscribe-before-socket-close and stop a late `EVENT` from
   * reaching a torn-down client.
   */
  onMessage(handler: (frame: RelayFrame) => void): () => void
  /** Close the underlying connection. Idempotent. */
  close(): void
}

/** Opens `ws://`/`wss://` connections. A4 supplies the real one; A2 tests pin the fake. */
export interface RelayTransport {
  connect(relayUrl: string): Promise<RelaySocket>
}
