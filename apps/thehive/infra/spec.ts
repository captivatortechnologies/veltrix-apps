// =============================================================================
// TheHive — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / MISP / OpenCTI (TheHive 5 is a Scala/Play Security Incident Response
// Platform / SOAR backed by Apache Cassandra as its primary store, Elasticsearch
// as its search index, and an S3-compatible object store for file attachments),
// yet it composes the SAME generic OpenTofu modules (sdk/opentofu/modules/<cloud>)
// purely by declaring different data. No tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): thehive / cassandra / index /
// minio / standalone.
//   thehive     TheHive web/API application (the ALB target)
//   cassandra   Apache Cassandra data store (peer-only)
//   index       Elasticsearch search index (peers + admin)
//   minio       S3-compatible object / file store (peer-only)
//   standalone  all-in-one single box (every role)
//
// Ports (TheHive 5 reference — docs.strangebee.com):
//   9000   TheHive web/API (behind the ALB; HTTP, TLS at the ALB)
//   9042   Apache Cassandra CQL (node-to-node)
//   9200   Elasticsearch REST (peers + admin)
//   9300   Elasticsearch transport (node-to-node)
//   9100   MinIO / S3 object storage API (peer-only; a distinct port from
//          TheHive's own 9000 so the two never collide in the security group)
// Verify port/topology choices against your TheHive 5 deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 9000, sources: ['alb'], description: 'TheHive web/API (ALB only)' },
    { port: 9042, sources: ['self'], description: 'Apache Cassandra CQL (node-to-node)' },
    { port: 9200, sources: ['self', 'admin'], description: 'Elasticsearch REST' },
    { port: 9300, sources: ['self'], description: 'Elasticsearch transport (node-to-node)' },
    { port: 9100, sources: ['self'], description: 'MinIO / S3 object storage API (node-to-node)' },
  ],

  // TheHive's web/API front door is plain HTTP on 9000; TLS terminates at the
  // ALB (target protocol HTTP), like Splunk Web on 8000. Health via the public
  // status endpoint (200-399 covers any auth redirect).
  loadBalancer: {
    targetPort: 9000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/api/v1/status',
    healthCheckMatcher: '200-399',
    targetKinds: ['thehive', 'standalone'],
  },

  dnsPrefixes: {
    thehive: 'thehive',
    cassandra: 'cassandra',
    index: 'index',
    minio: 'minio',
    standalone: 'thehive',
  },

  // TheHive 5 stores file attachments in an S3-compatible object store. On cloud
  // this is a managed bucket (declared here); a dedicated / self-hosted stack
  // additionally runs the `minio` data-tier node (see byolTopology.ts).
  storage: [{ name: 'objects' }],

  // Public TheHive web/API behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (TheHive init / application + data-store
  // wiring) lives entirely behind this entrypoint — proving the worker is
  // tool-agnostic.
  bringup: './bringup/thehive-setup.mjs',
};

export default spec;
