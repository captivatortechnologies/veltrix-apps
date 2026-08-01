// =============================================================================
// Keycloak — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / MISP / OpenCTI (a Java/Quarkus Identity-and-Access-Management server
// backed by a relational datastore and clustered via an embedded Infinispan
// cache), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): keycloak / database / standalone.
//   keycloak    Keycloak IAM server (the ALB target; Infinispan-clustered)
//   database    PostgreSQL (the Keycloak datastore, peer-only)
//   standalone  all-in-one single box (Keycloak + PostgreSQL)
//
// Ports (Keycloak reference — www.keycloak.org server/all-config guides):
//   8080   Keycloak HTTP (behind the ALB; TLS terminates at the ALB)
//   8443   Keycloak HTTPS (direct / inter-node, admin CIDR)
//   7800   Infinispan / JGroups cluster transport (node-to-node)
//   5432   PostgreSQL (peer-only)
// Verify port/topology choices against your Keycloak deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 8080, sources: ['alb'], description: 'Keycloak HTTP (ALB only; TLS terminates at the ALB)' },
    { port: 8443, sources: ['self', 'admin'], description: 'Keycloak HTTPS (direct / inter-node)' },
    { port: 7800, sources: ['self'], description: 'Infinispan / JGroups cluster transport (node-to-node)' },
    { port: 5432, sources: ['self'], description: 'PostgreSQL (Keycloak datastore, node-to-node)' },
  ],

  // Keycloak's web/admin front door is plain HTTP on 8080; TLS terminates at the
  // ALB (target protocol HTTP), like OpenCTI on 4000 / Splunk Web on 8000. Health
  // via the web root (200-399 covers the welcome/admin redirect).
  loadBalancer: {
    targetPort: 8080,
    targetProtocol: 'HTTP',
    healthCheckPath: '/',
    healthCheckMatcher: '200-399',
    targetKinds: ['keycloak', 'standalone'],
  },

  dnsPrefixes: {
    keycloak: 'keycloak',
    database: 'db',
    standalone: 'keycloak',
  },

  // No object storage: Keycloak persists everything in PostgreSQL — so `storage`
  // is omitted (exercises has_storage=false).

  // Public Keycloak web / admin console behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (Keycloak bring-up, DB wiring, realm/admin
  // init) lives entirely behind this entrypoint — proving the worker is
  // tool-agnostic.
  bringup: './bringup/keycloak-setup.mjs',
};

export default spec;
