// =============================================================================
// Fleet — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a different tool again from Splunk and Security
// Onion (an osquery fleet-management server backed by MySQL + Redis, HTTPS REST
// API), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): fleet-server / database
// (MySQL) / redis / standalone. `database` and `redis` are not generic
// FOUNDATION_KINDS, so they are realized as compute nodes automatically.
//
// Ports (Fleet / fleetdm reference — fleetdm.com/docs; verify against your
// deployment):
//   8080  Fleet server HTTPS — web UI + /api/v1/fleet REST (fleetdm default)
//   443   Fleet server HTTPS — common hosted/front-door listener
//   3306  MySQL — Fleet's primary datastore
//   6379  Redis — Fleet live-query results + cache
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 8080, sources: ['alb', 'admin'], description: 'Fleet server HTTPS — web UI + /api/v1/fleet REST (fleetdm default; ALB target)' },
    { port: 443, sources: ['alb'], description: 'Fleet server HTTPS — alternate public listener' },
    { port: 3306, sources: ['self'], description: 'MySQL — Fleet primary datastore (node-to-node)' },
    { port: 6379, sources: ['self'], description: 'Redis — Fleet live-query results + cache (node-to-node)' },
  ],

  // The Fleet server is native HTTPS — so the ALB re-encrypts to the server
  // (target protocol HTTPS) on Fleet's default 8080 listener, exercising the
  // module's target_protocol / health_check_protocol path. /healthz is Fleet's
  // unauthenticated health endpoint.
  loadBalancer: {
    targetPort: 8080,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/healthz',
    healthCheckMatcher: '200-399',
    targetKinds: ['fleet-server', 'standalone'],
  },

  dnsPrefixes: {
    'fleet-server': 'fleet',
    database: 'db',
    redis: 'redis',
    standalone: 'standalone',
  },

  // No object storage in the base stack: Fleet's state lives in MySQL + Redis, so
  // `storage` is omitted (exercises the has_storage=false path). Optional S3 for
  // software installers / file carving is a future enhancement.

  // Public Fleet console behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // fleetctl/Fleet bring-up (schema migration + server config), NOT ansible/Salt —
  // the tool-specific config management lives entirely behind this entrypoint.
  bringup: './bringup/fleet-setup.mjs',
};

export default spec;
