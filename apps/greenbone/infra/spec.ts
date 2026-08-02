// =============================================================================
// Greenbone / OpenVAS — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / OpenCTI (a GVM vulnerability-management stack — the gvmd manager and
// GSA web UI speaking GMP, a pool of openvas-scanner nodes running the feed's
// network vulnerability tests, backed by PostgreSQL and Redis), yet it composes
// the SAME generic OpenTofu modules (sdk/opentofu/modules/<cloud>) purely by
// declaring different data. No tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): greenbone / scanner / postgres
// / redis / standalone.
//   greenbone   gvmd (GMP) + GSA web UI (the ALB target)
//   scanner     openvas-scanner nodes (network vulnerability tests)
//   postgres    gvmd database (peer-only)
//   redis       scanner key-value store (peer-only)
//   standalone  all-in-one single box (every role)
//
// Ports (Greenbone / GVM reference — greenbone.github.io):
//   443    Greenbone Security Assistant (GSA) web UI (behind the ALB; HTTPS)
//   9390   Greenbone Management Protocol (GMP over TLS — gvmd; peers + admin)
//   5432   PostgreSQL (gvmd database; peer-only)
//   6379   Redis (scanner key-value store; peer-only)
// Verify port/topology choices against your Greenbone / GVM deployment guidance
// (plain TLS on 9390 is the classic GMP transport and is deprecated in newer
// Greenbone OS in favour of an SSH-tunnelled unix socket).
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 443, sources: ['alb'], description: 'Greenbone Security Assistant (GSA) web UI (ALB only)' },
    { port: 9390, sources: ['self', 'admin'], description: 'Greenbone Management Protocol (GMP over TLS)' },
    { port: 5432, sources: ['self'], description: 'PostgreSQL (gvmd database, node-to-node)' },
    { port: 6379, sources: ['self'], description: 'Redis (scanner key-value store, node-to-node)' },
  ],

  // The GSA web UI serves HTTPS on 443; the ALB re-encrypts to the manager tier
  // (target protocol HTTPS). Health via the web root (200-399 covers the SPA /
  // any auth redirect).
  loadBalancer: {
    targetPort: 443,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/',
    healthCheckMatcher: '200-399',
    targetKinds: ['greenbone', 'standalone'],
  },

  dnsPrefixes: {
    greenbone: 'gsa',
    scanner: 'scanner',
    postgres: 'db',
    redis: 'redis',
    standalone: 'greenbone',
  },

  // Greenbone stores everything in PostgreSQL + the feed on disk; there is no
  // object store (unlike OpenCTI's MinIO/S3), so `storage` is omitted entirely.

  // Public GSA web UI behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (gvmd bring-up, feed sync, scanner
  // registration, admin user) lives entirely behind this entrypoint — proving the
  // worker is tool-agnostic.
  bringup: './bringup/greenbone-setup.mjs',
};

export default spec;
