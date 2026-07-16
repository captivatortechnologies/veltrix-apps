// =============================================================================
// Security Onion — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk (Salt-
// driven NSM/IDS grid, HTTPS SOC console on 443, Elasticsearch cluster, Elastic
// Agent/Fleet), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): manager / manager-search /
// search-node / sensor / forward-node / fleet-node / receiver / heavy-node /
// idh / standalone.
//
// Ports (Security Onion 2.4 firewall reference — docs.securityonion.net):
//   443   SOC web console + Kibana (analyst access; HTTPS)
//   4505  Salt master publish        4506  Salt master return
//   9200  Elasticsearch REST         9300  Elasticsearch node-to-node transport
//   9696  search-node cluster ops
//   5055  Elastic Agent data ingest  8220  Elastic Agent (Fleet) management
//   5056  Logstash-to-Logstash
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 443, sources: ['alb'], description: 'SOC console / Kibana (analyst)' },
    { port: 4505, sources: ['self'], description: 'Salt master publish' },
    { port: 4506, sources: ['self'], description: 'Salt master return' },
    { port: 9200, sources: ['self', 'admin'], description: 'Elasticsearch REST' },
    { port: 9300, sources: ['self'], description: 'Elasticsearch transport (node-to-node)' },
    { port: 9696, sources: ['self'], description: 'Search-node cluster operations' },
    { port: 5055, sources: ['self'], description: 'Elastic Agent data ingest' },
    { port: 8220, sources: ['self', 'admin'], description: 'Elastic Agent / Fleet management' },
    { port: 5056, sources: ['self'], description: 'Logstash-to-Logstash forwarding' },
  ],

  // The SOC console is native HTTPS on 443 — so the ALB re-encrypts to the
  // manager (target protocol HTTPS), unlike Splunk Web's plain HTTP on 8000.
  // This exercises the module's target_protocol / health_check_protocol path.
  loadBalancer: {
    targetPort: 443,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/login',
    healthCheckMatcher: '200-399',
    targetKinds: ['manager', 'manager-search', 'standalone'],
  },

  dnsPrefixes: {
    manager: 'manager',
    'manager-search': 'mgrsearch',
    'search-node': 'search',
    sensor: 'sensor',
    'forward-node': 'fwd',
    'fleet-node': 'fleet',
    receiver: 'receiver',
    'heavy-node': 'heavy',
    idh: 'idh',
    standalone: 'standalone',
  },

  // No object storage: PCAP stays local on sensors and ES data lives on search
  // nodes' volumes — so `storage` is omitted (exercises the has_storage=false
  // path, unlike Splunk's SmartStore bucket).

  // Public SOC console behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Salt-based bring-up (so-setup), NOT splunk-ansible — the tool-specific
  // config management lives entirely behind this entrypoint.
  bringup: './bringup/so-setup.mjs',
};

export default spec;
