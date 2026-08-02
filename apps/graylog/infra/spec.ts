// =============================================================================
// Graylog — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / OpenCTI (an open-source SIEM / log-management platform: a JVM Graylog
// server exposing a web UI + REST API, backed by a distributed OpenSearch /
// Elasticsearch search engine and a MongoDB metadata store), yet it composes the
// SAME generic OpenTofu modules (sdk/opentofu/modules/<cloud>) purely by
// declaring different data. No tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): graylog / opensearch / mongodb
// / standalone.
//   graylog     Graylog server — web UI + REST API (the ALB target)
//   opensearch  OpenSearch / Elasticsearch search + storage nodes
//   mongodb     MongoDB metadata / configuration store (peer-only, single)
//   standalone  all-in-one single box (every role)
//
// Ports (Graylog reference — docs.graylog.org):
//   9000   Graylog web UI + REST API (behind the ALB; HTTP, TLS at the ALB)
//   9200   OpenSearch / Elasticsearch REST (peers + admin)
//   9300   OpenSearch / Elasticsearch transport (node-to-node)
//   27017  MongoDB (peer-only)
// Verify port/topology choices against your Graylog deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 9000, sources: ['alb'], description: 'Graylog web UI + REST API (ALB only)' },
    { port: 9200, sources: ['self', 'admin'], description: 'OpenSearch / Elasticsearch REST' },
    { port: 9300, sources: ['self'], description: 'OpenSearch / Elasticsearch transport (node-to-node)' },
    { port: 27017, sources: ['self'], description: 'MongoDB metadata store (node-to-node)' },
  ],

  // Graylog's web/REST front door is plain HTTP on 9000; TLS terminates at the
  // ALB (target protocol HTTP), like Splunk Web on 8000. Health via Graylog's
  // dedicated load-balancer status endpoint (200 = ALIVE, 503 = DEAD).
  loadBalancer: {
    targetPort: 9000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/api/system/lbstatus',
    healthCheckMatcher: '200-299',
    targetKinds: ['graylog', 'standalone'],
  },

  dnsPrefixes: {
    graylog: 'graylog',
    opensearch: 'opensearch',
    mongodb: 'mongo',
    standalone: 'graylog',
  },

  // Graylog needs no S3-compatible object store — OpenSearch owns the message
  // archive and MongoDB owns metadata — so no `storage` bucket is declared.

  // Public Graylog web/REST behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (Graylog init / server bring-up, data-store
  // wiring) lives entirely behind this entrypoint — proving the worker is
  // tool-agnostic.
  bringup: './bringup/graylog-setup.mjs',
};

export default spec;
