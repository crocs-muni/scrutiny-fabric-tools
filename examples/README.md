# Examples

This directory contains reference implementations that demonstrate how to use the SCRUTINY Fabric protocol with your own infrastructure.

**Examples are not packages.** They live outside the `packages/` workspace, are never published, and are deliberately self-contained so you can copy them out and adapt them to your needs.

## Why examples, not packages?

- **Crypto lives here, never in core.** The D12 invariant forbids cryptography in `packages/*/src`. Signers, relay adapters, and other crypto-dependent code belong in `examples/`.
- **No forced dependencies.** Consumers should not be required to depend on a specific crypto library (D6). Copy what you need, adapt it, or replace it entirely.

Use examples as templates. Do not add them as dependencies.
