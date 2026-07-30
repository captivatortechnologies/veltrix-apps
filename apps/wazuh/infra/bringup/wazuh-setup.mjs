#!/usr/bin/env node
// =============================================================================
// Wazuh bring-up entrypoint (STUB / seed).
//
// The generic platform worker invokes this (spec.bringup) after `tofu apply`,
// with the tofu outputs + plan on the CLI, exactly as it invokes Splunk's
// ansible site.yml or Security Onion's so-setup. Wazuh's config management is its
// own installer/cluster bootstrap — proving the worker is tool-agnostic: it runs
// whatever entrypoint the app declares.
//
// Real implementation (future) would, in order:
//   1. Install the Wazuh indexer(s) (OpenSearch); form the indexer cluster and
//      generate/distribute certificates (wazuh-certs-tool).
//   2. Install the Wazuh manager master (analysisd, remoted, API on 55000) and
//      point it at the indexer; enable the cluster daemon (1516).
//   3. Join manager worker node(s) to the cluster for agent-capacity scale.
//   4. Install the Wazuh dashboard (OpenSearch Dashboards) → indexer + API.
//   5. Gate readiness on the indexer cluster health (green) + manager API (55000)
//      + dashboard (443) reachable.
//
// This stub is deliberately inert; it documents the contract and exits 0 so the
// spec resolves. It lives under infra/ so the app validator treats it as
// out-of-process provisioning tooling (process.exit here is allowed).
// =============================================================================

function main() {
  const args = process.argv.slice(2);
  process.stdout.write(
    `[wazuh/bringup] STUB — would run wazuh-setup (indexer/manager/dashboard).\n` +
      `  args: ${JSON.stringify(args)}\n` +
      `  order: indexer -> manager-master -> manager-worker -> dashboard -> readiness gate (indexer green + API 55000 + dashboard 443)\n`,
  );
  // A real run would exit non-zero on a failed readiness gate.
  process.exit(0);
}

main();
