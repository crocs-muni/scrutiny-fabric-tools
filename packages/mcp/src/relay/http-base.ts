/** The HTTP origin of a relay: `wss://host` → `https://host`, `ws://host` → `http://host`. */
export function httpBase(relayUrl: string): string {
  const url = new URL(relayUrl)
  url.protocol = url.protocol === 'ws:' ? 'http:' : 'https:'
  return url.origin
}
