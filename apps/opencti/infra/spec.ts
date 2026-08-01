// =============================================================================
// OpenCTI — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / MISP (a Node.js GraphQL/web threat-intel platform backed by a
// distributed Elasticsearch/OpenSearch search engine, Redis, RabbitMQ and an
// S3-compatible object store, fed by a pool of ingest workers), yet it composes
// the SAME generic OpenTofu modules (sdk/opentofu/modules/<cloud>) purely by
// declaring different data. No tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): opencti-platform / worker /
// search / redis / rabbitmq / minio / standalone.
//   opencti-platform  OpenCTI GraphQL API + web UI (the ALB target)
//   worker            ingest / enrichment workers
//   search            Elasticsearch / OpenSearch data nodes
//   redis             cache / session / stream broker (peer-only)
//   rabbitmq          worker message broker, AMQP (peer-only)
//   minio             S3-compatible object / file store (peer-only)
//   standalone        all-in-one single box (every role)
//
// Ports (OpenCTI reference — docs.opencti.io):
//   4000   OpenCTI GraphQL API + web UI (behind the ALB; HTTP, TLS at the ALB)
//   9200   Elasticsearch / OpenSearch REST (peers + admin)
//   9300   Elasticsearch transport (node-to-node)
//   6379   Redis (peer-only)
//   5672   RabbitMQ AMQP (peer-only)
//   15672  RabbitMQ management (peers + admin)
//   9000   MinIO / S3 object storage API (peer-only)
// Verify port/topology choices against your OpenCTI deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 4000, sources: ['alb'], description: 'OpenCTI GraphQL API + web UI (ALB only)' },
    { port: 9200, sources: ['self', 'admin'], description: 'Elasticsearch / OpenSearch REST' },
    { port: 9300, sources: ['self'], description: 'Elasticsearch transport (node-to-node)' },
    { port: 6379, sources: ['self'], description: 'Redis (cache / sessions / stream, node-to-node)' },
    { port: 5672, sources: ['self'], description: 'RabbitMQ AMQP (worker broker, node-to-node)' },
    { port: 15672, sources: ['self', 'admin'], description: 'RabbitMQ management' },
    { port: 9000, sources: ['self'], description: 'MinIO / S3 object storage API (node-to-node)' },
  ],

  // OpenCTI's web/GraphQL front door is plain HTTP on 4000; TLS terminates at
  // the ALB (target protocol HTTP), like Splunk Web on 8000. Health via the web
  // root (200-399 covers the SPA / any auth redirect).
  loadBalancer: {
    targetPort: 4000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/',
    healthCheckMatcher: '200-399',
    targetKinds: ['opencti-platform', 'standalone'],
  },

  dnsPrefixes: {
    'opencti-platform': 'opencti',
    worker: 'worker',
    search: 'search',
    redis: 'redis',
    rabbitmq: 'mq',
    minio: 'minio',
    standalone: 'opencti',
  },

  // OpenCTI stores files (imports, exports, artifacts) in an S3-compatible object
  // store. On cloud this is a managed bucket (declared here); a dedicated / self-
  // hosted stack additionally runs the `minio` data-tier node (see byolTopology.ts).
  storage: [{ name: 'objects' }],

  // Public OpenCTI web/GraphQL behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (OpenCTI init / platform + workers bring-up,
  // data-store wiring) lives entirely behind this entrypoint — proving the worker
  // is tool-agnostic.
  bringup: './bringup/opencti-setup.mjs',
};

export default spec;
