// =============================================================================
// MISP — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion (a PHP/CakePHP threat-intel web app backed by MariaDB + Redis background
// workers), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): misp-core / database / redis /
// standalone.
//   misp-core   the MISP web UI + REST API + background workers (resque/supervisor)
//   database    MariaDB (the MISP datastore)
//   redis       Redis (background job queue + cache)
//   standalone  all-in-one single box (web + workers + DB + Redis)
//
// Ports (MISP reference — misp-project.org / INSTALL docs):
//   443   MISP web UI + REST API (HTTPS)
//   3306  MariaDB (peer-only)
//   6379  Redis (peer-only)
// Verify port/topology choices against your MISP deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 443, sources: ['alb'], description: 'MISP web UI + REST API (HTTPS)' },
    { port: 3306, sources: ['self'], description: 'MariaDB (MISP datastore, node-to-node)' },
    { port: 6379, sources: ['self'], description: 'Redis (background workers / cache, node-to-node)' },
  ],

  // The MISP web tier is native HTTPS on 443 — so the ALB re-encrypts to
  // misp-core (target protocol HTTPS). Health-checks hit the login page.
  loadBalancer: {
    targetPort: 443,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/users/login',
    healthCheckMatcher: '200-399',
    targetKinds: ['misp-core', 'standalone'],
  },

  dnsPrefixes: {
    'misp-core': 'misp',
    database: 'db',
    redis: 'redis',
    standalone: 'misp',
  },

  // No object storage: MISP attachments/data live on the misp-core volume and the
  // datastore is MariaDB — so `storage` is omitted (exercises has_storage=false).

  // Public MISP web UI behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (MISP install / DB init / worker bring-up)
  // lives entirely behind this entrypoint — proving the worker is tool-agnostic.
  bringup: './bringup/misp-setup.mjs',
};

export default spec;
