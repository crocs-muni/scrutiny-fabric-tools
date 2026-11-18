---
"@crocs-muni/scrutiny-fabric-mcp": patch
---

Closing the relay client now stops the resends and the dial: `close()` marks the client stopped before dropping the socket, `publish()` refuses a new attempt once stopped and rethrows the failed attempt's cause instead of retrying, and a lazy connect after close rejects rather than opening a socket — so a host that closes the publisher after its own timeout no longer gets writes from the run it abandoned.
