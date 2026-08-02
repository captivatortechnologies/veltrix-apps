// =============================================================================
// authentik — declarative InfraSpec.
//
// PROOF OF GENERICITY: this composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) as every other BYOL app (Splunk, Greenbone,
// Keycloak, MISP, …) purely by declaring different data. No tool-specific HCL
// exists anywhere.
//
// Node roles (compute, via foundation-exclusion): authentik-server /
// authentik-worker / postgres / standalone.
//   authentik-server  authentik server process (web/API — the ALB target)
//   authentik-worker  authentik worker process (background tasks; no inbound port)
//   postgres          authentik's database (peer-only)
//   standalone        all-in-one single box (server + worker + postgres)
//
// authentik ships ONE container image (ghcr.io/goauthentik/server) that runs as
// either role via its startup COMMAND — `server` or `worker` — never separate
// images. Verified against the official docker-compose.yml
// (https://docs.goauthentik.io/compose.yml): both the `server` and `worker`
// services use `image: ${AUTHENTIK_IMAGE:-ghcr.io/goauthentik/server}` and
// differ only in `command: server` / `command: worker`; both `depends_on`
// PostgreSQL.
//
// Ports (authentik install docs —
// https://docs.goauthentik.io/docs/install-config/install/docker-compose):
//   443    Public HTTPS listener at the ALB (TLS terminates at the load balancer)
//   9000   authentik server — internal HTTP (the ALB's backend target; also the
//          port the `server`'s /-/health/live/ and /-/health/ready/ checks answer
//          on — verified against the official Helm chart's values.yaml,
//          `server.livenessProbe`/`readinessProbe`, httpGet port "http" = 9000)
//   9443   authentik server — internal HTTPS (direct/admin access, bypassing the ALB)
//   5432   PostgreSQL (authentik's database; peer-only)
// The worker exposes NO ports in the reference compose file — it runs no HTTP
// listener the ALB or peers would reach (its k8s liveness/readiness probes use
// `exec: [ak, healthcheck]`, not HTTP, per the same Helm values.yaml).
//
// ⚠ NO REDIS. Verified, not an oversight: authentik used Redis (caching, the
// task broker, the embedded outpost's session store, WebSocket connections)
// through 2025.8; the 2025.10 release migrated ALL of that to PostgreSQL and
// "fully remov[ed] the need for Redis" (authentik 2025.10 release notes,
// https://docs.goauthentik.io/releases/2025.10/ — "Breaking changes"). The
// CURRENT official docker-compose.yml (tag 2026.5.6 at research time) and Helm
// chart values.yaml both confirm this — neither references Redis anywhere. See
// lib/byolTopology.ts for the full citation trail.
//
// ⚠ STACK SIZING (instance sizing, exact port choices beyond what's verified
// above) IS A REASONABLE DEFAULT — VERIFY against current authentik deployment
// guidance (docs.goauthentik.io/docs/install-config) before treating this as
// production-grade for your scale.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 9000, sources: ['alb'], description: 'authentik server — internal HTTP (ALB target; TLS terminates at the load balancer)' },
    { port: 9443, sources: ['admin'], description: 'authentik server — internal HTTPS (direct/admin access, bypassing the ALB)' },
    { port: 5432, sources: ['self'], description: 'PostgreSQL (authentik database, node-to-node)' },
  ],

  // The ALB terminates public HTTPS (443) and forwards HTTP to the server
  // tier's internal port 9000. Health via authentik's own liveness endpoint.
  loadBalancer: {
    targetPort: 9000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/-/health/live/',
    healthCheckMatcher: '200',
    targetKinds: ['authentik-server', 'standalone'],
  },

  dnsPrefixes: {
    'authentik-server': 'app',
    'authentik-worker': 'worker',
    postgres: 'db',
    standalone: 'authentik',
  },

  // authentik stores everything in PostgreSQL; there is no object store (unlike
  // OpenCTI's MinIO/S3 or Splunk's SmartStore), so `storage` is omitted entirely.

  // Public authentik web UI behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (bootstrap admin token/user, default
  // flows/branding, readiness gate) lives entirely behind this entrypoint —
  // proving the worker is tool-agnostic.
  bringup: './bringup/authentik-setup.mjs',
};

export default spec;
