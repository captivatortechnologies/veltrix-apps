#!/usr/bin/env node
// =============================================================================
// Security Onion bring-up entrypoint (STUB / seed).
//
// The generic platform worker invokes this (spec.bringup) after `tofu apply`,
// with the tofu outputs + plan on the CLI, exactly as it invokes Splunk's
// ansible site.yml. Security Onion's config management is Salt-based (so-setup),
// NOT ansible — proving the worker is tool-agnostic: it runs whatever entrypoint
// the app declares.
//
// Real implementation (future) would, in order:
//   1. Designate the manager node; run `so-setup` in MANAGER mode (SOC, Kibana,
//      local Elasticsearch, Logstash, Salt master).
//   2. Join SEARCH nodes to the Elastic cluster (Salt highstate from the manager).
//   3. Join SENSOR / FORWARD nodes (Suricata/Zeek → Elastic Agent → manager).
//   4. Gate readiness on the Elastic cluster health (green) + SOC reachable.
//
// This stub is deliberately inert; it documents the contract and exits 0 so the
// spec resolves. It lives under infra/ so the app validator treats it as
// out-of-process provisioning tooling (process.exit here is allowed).
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  process.stdout.write(
    `[security-onion/bringup] STUB — would run so-setup (Salt) for grid nodes.\n` +
      `  args: ${JSON.stringify(args)}\n` +
      `  order: manager -> search-nodes -> sensors -> readiness gate (Elastic cluster green + SOC up)\n`,
  );
  // A real run would exit non-zero on a failed readiness gate.
  process.exit(0);
}

main();
