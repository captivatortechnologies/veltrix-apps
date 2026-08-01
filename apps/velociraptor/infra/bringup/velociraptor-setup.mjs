#!/usr/bin/env node
// =============================================================================
// Velociraptor bring-up entrypoint (STUB / seed).
//
// The generic platform worker invokes this (spec.bringup) after `tofu apply`,
// with the tofu outputs + plan on the CLI, exactly as it invokes Splunk's ansible
// site.yml or Security Onion's so-setup. This proves the worker is tool-agnostic:
// it runs whatever entrypoint the app declares.
//
// Real implementation (future) would, in order:
//   1. Stand up the MinIO datastore node(s); create the Velociraptor bucket +
//      credentials (the shared S3 file+datastore backend).
//   2. Generate the Velociraptor server config pointed at the MinIO endpoint, and
//      install the server (GUI + frontend + gRPC API) on each frontend node.
//   3. Create the initial GUI admin user + api-client config; start the server.
//   4. Gate readiness on the Velociraptor GUI answering (GET /app/index.html) and
//      the frontend accepting client connections.
//
// This stub is deliberately inert; it documents the contract and exits 0 so the
// spec resolves. It lives under infra/ so the app validator treats it as
// out-of-process provisioning tooling (process.exit here is allowed).
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  process.stdout.write(
    `[velociraptor/bringup] STUB — would run MinIO datastore + Velociraptor server install.\n` +
      `  args: ${JSON.stringify(args)}\n` +
      `  order: datastore (MinIO) -> velociraptor-server (GUI/frontend/API) -> admin user -> readiness gate (GUI up)\n`,
  );
  // A real run would exit non-zero on a failed readiness gate.
  process.exit(0);
}

main();
