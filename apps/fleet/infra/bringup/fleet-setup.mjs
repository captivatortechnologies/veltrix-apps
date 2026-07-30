#!/usr/bin/env node
// =============================================================================
// Fleet bring-up entrypoint (STUB / seed).
//
// The generic platform worker invokes this (spec.bringup) after `tofu apply`,
// with the tofu outputs + plan on the CLI, exactly as it invokes Splunk's
// ansible site.yml or Security Onion's Salt so-setup. Fleet's config management
// is fleetctl / server-config based — proving the worker is tool-agnostic: it
// runs whatever entrypoint the app declares.
//
// Real implementation (future) would, in order:
//   1. Provision MySQL (schema + `fleet prepare db` migrations) and Redis.
//   2. Start the Fleet server(s) against MySQL + Redis with TLS on 8080.
//   3. Seed the initial admin + an API-only user, and mint its API token.
//   4. Gate readiness on GET /healthz (server up) + a successful DB migration.
//
// This stub is deliberately inert; it documents the contract and exits 0 so the
// spec resolves. It lives under infra/ so the app validator treats it as
// out-of-process provisioning tooling (process.exit here is allowed). Verify the
// bring-up order against a live Fleet (fleetdm) deployment.
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  process.stdout.write(
    `[fleet/bringup] STUB — would run fleetctl / Fleet server setup.\n` +
      `  args: ${JSON.stringify(args)}\n` +
      `  order: MySQL (prepare db) + Redis -> fleet-server (TLS:8080) -> seed admin/API token -> readiness gate (/healthz up + DB migrated)\n`,
  );
  // A real run would exit non-zero on a failed readiness gate.
  process.exit(0);
}

main();
