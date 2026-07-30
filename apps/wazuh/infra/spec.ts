// =============================================================================
// Wazuh — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion (a Wazuh cluster — manager master/worker, an OpenSearch-based indexer, and
// a dashboard), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion):
//   manager-master  — Wazuh manager master node (analysisd, remoted, API, cluster)
//   manager-worker  — Wazuh manager worker node (horizontal agent-capacity scale)
//   indexer         — Wazuh indexer (OpenSearch) — event storage + search
//   dashboard       — Wazuh dashboard (OpenSearch Dashboards) — analyst web UI
//
// Ports (Wazuh 4.x reference — documentation.wazuh.com; verify against your build):
//   443    Wazuh dashboard (analyst web UI; HTTPS)
//   55000  Wazuh manager REST API (this app's control plane)
//   1514   Agent connection (agents → manager; events)
//   1515   Agent enrollment (authd registration)
//   1516   Wazuh cluster daemon (manager master ↔ worker)
//   9200   Wazuh indexer REST (OpenSearch)
//   9300   Wazuh indexer transport (node-to-node)
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    // The dashboard is the only ALB-fronted web tier (native HTTPS on 443).
    { port: 443, sources: ['alb'], description: 'Wazuh dashboard (analyst web UI)' },
    // The manager REST API — reachable from the ALB (control plane) and admin CIDRs.
    { port: 55000, sources: ['alb', 'admin'], description: 'Wazuh manager REST API' },
    // Agent-facing ports. Agents live on customer endpoints, outside the cluster —
    // in a real deployment 'admin' should be widened to the agent fleet CIDRs.
    { port: 1514, sources: ['self', 'admin'], description: 'Agent connection (events)' },
    { port: 1515, sources: ['self', 'admin'], description: 'Agent enrollment (authd)' },
    // Intra-cluster only.
    { port: 1516, sources: ['self'], description: 'Wazuh cluster daemon (master ↔ worker)' },
    { port: 9200, sources: ['self', 'admin'], description: 'Wazuh indexer REST (OpenSearch)' },
    { port: 9300, sources: ['self'], description: 'Wazuh indexer transport (node-to-node)' },
  ],

  // The dashboard is native HTTPS on 443 — so the ALB re-encrypts to it (target
  // protocol HTTPS). Verify the health-check path against your dashboard build;
  // '/app/login' answers 200 and the matcher also tolerates the root redirect.
  loadBalancer: {
    targetPort: 443,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/app/login',
    healthCheckMatcher: '200-399',
    targetKinds: ['dashboard'],
  },

  dnsPrefixes: {
    'manager-master': 'manager',
    'manager-worker': 'worker',
    indexer: 'indexer',
    dashboard: 'dashboard',
  },

  // No object storage: indexer data lives on the indexer nodes' volumes — so
  // `storage` is omitted (exercises the has_storage=false path).

  // Public dashboard behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Wazuh install/cluster bring-up (wazuh-setup), NOT ansible/salt — the
  // tool-specific configuration lives entirely behind this entrypoint.
  bringup: './bringup/wazuh-setup.mjs',
};

export default spec;
