// =============================================================================
// Splunk Enterprise — declarative InfraSpec.
//
// This is ALL of Splunk's cloud shape, as data. The SDK renders it into the
// generic OpenTofu module (sdk/opentofu/modules/<cloud>) — there is no
// Splunk-specific HCL anywhere. The bring-up (splunk-ansible + cluster-REST
// health gate) lives entirely behind `bringup`. Another tool (e.g. Security
// Onion) ships its own spec + bring-up and reuses the exact same modules.
//
// Ports (Splunk Validated Architecture C3):
//   8000  Splunk Web (behind the ALB only)
//   8089  splunkd management / REST (peers + admin control plane)
//   9997  S2S / forwarding (peers)
//   9887  indexer-cluster replication (peers)
//   8191  KV store / SHC replication (peers)
//   8088  HTTP Event Collector (peers + admin, fronted by the ALB)
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  // Compute is inferred by foundation-exclusion, so no computeKinds list needed:
  // indexer / search-head / cluster-manager / heavy-forwarder / etc. are all
  // compute automatically.

  securityRules: [
    { port: 8000, sources: ['alb'], description: 'Splunk Web (ALB only)' },
    { port: 8089, sources: ['self', 'admin'], description: 'splunkd management / REST' },
    { port: 9997, sources: ['self'], description: 'S2S / forwarding' },
    { port: 9887, sources: ['self'], description: 'Indexer cluster replication' },
    { port: 8191, sources: ['self'], description: 'KV store / SHC replication' },
    { port: 8088, sources: ['self', 'admin', 'alb'], description: 'HTTP Event Collector' },
  ],

  // Public front door: the search tier (SHC members, or the single standalone
  // node) behind the ALB. Splunk Web is plain HTTP on 8000; TLS terminates at
  // the ALB. Health via the login page (200-399 covers the unauth 303 redirect).
  loadBalancer: {
    targetPort: 8000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/en-US/account/login',
    healthCheckMatcher: '200-399',
    targetKinds: ['search-head', 'standalone'],
  },

  // Per-node function FQDN prefixes → mgmt1./idx1./sh1./hf1.<cust>-<env>.…
  dnsPrefixes: {
    'license-manager': 'lm',
    'cluster-manager': 'mgmt',
    'sh-deployer': 'shd',
    'deployment-server': 'ds',
    'monitoring-console': 'mc',
    indexer: 'idx',
    'search-head': 'sh',
    'heavy-forwarder': 'hf',
    standalone: 'splunk',
  },

  // SmartStore / warm-cold object storage.
  storage: [{ name: 'smartstore' }],

  // WAF managed rule sets + IP rate limit on the public ALB.
  waf: true,

  // splunk-ansible bring-up (ordered LM→CM→peers→DS→SHC→captain→integration→
  // deployer→HF) + the cluster-REST readiness gate. The generic worker invokes
  // this after `tofu apply`; nothing tool-specific leaks into the module.
  bringup: './bringup/ansible/site.yml',
};

export default spec;
