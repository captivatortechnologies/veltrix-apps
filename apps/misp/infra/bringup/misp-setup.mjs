#!/usr/bin/env node
// =============================================================================
// MISP bring-up entrypoint (STUB / seed).
//
// The generic platform worker invokes this (spec.bringup) after `tofu apply`,
// with the tofu outputs + plan on the CLI, exactly as it invokes Splunk's ansible
// site.yml or Security Onion's so-setup. This proves the worker is tool-agnostic:
// it runs whatever entrypoint the app declares.
//
// Real implementation (future) would, in order:
//   1. Stand up MariaDB (database node) and Redis (redis node); create the MISP
//      schema and users.
//   2. Install/configure MISP on the misp-core node (web UI + REST API), pointed
//      at the DB + Redis endpoints.
//   3. Start the background workers (resque / supervisor) on misp-core.
//   4. Gate readiness on the MISP web UI answering (GET /users/login) and the
//      workers being up.
//
// This stub is deliberately inert; it documents the contract and exits 0 so the
// spec resolves. It lives under infra/ so the app validator treats it as
// out-of-process provisioning tooling (process.exit here is allowed).
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  process.stdout.write(
    `[misp/bringup] STUB — would run MISP install + DB/Redis init + workers.\n` +
      `  args: ${JSON.stringify(args)}\n` +
      `  order: database (MariaDB) + redis -> misp-core (web/API) -> workers -> readiness gate (MISP up)\n`,
  );
  // A real run would exit non-zero on a failed readiness gate.
  process.exit(0);
}

main();
