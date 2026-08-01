// =============================================================================
// SonarQube — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a completely different tool from Splunk / Security
// Onion / MISP / OpenCTI (a Java web/compute code-quality platform fronted by a
// load balancer, backed by an Elasticsearch search cluster and an external
// PostgreSQL database — the Data Center Edition topology), yet it composes the
// SAME generic OpenTofu modules (sdk/opentofu/modules/<cloud>) purely by
// declaring different data. No tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion): sonarqube-app / search /
// postgres / standalone.
//   sonarqube-app  SonarQube web server + compute engine (the ALB target)
//   search         Elasticsearch search data nodes
//   postgres       PostgreSQL database (peer-only, single)
//   standalone     all-in-one single box (web + compute + search)
//
// Ports (SonarQube reference — docs.sonarsource.com):
//   9000   SonarQube web UI + Web API (behind the ALB; HTTP, TLS at the ALB)
//   9001   Elasticsearch search port (app ↔ search + node-to-node)
//   5432   PostgreSQL (peer-only)
// Verify port/topology choices against your SonarQube deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 9000, sources: ['alb'], description: 'SonarQube web UI + Web API (ALB only)' },
    { port: 9001, sources: ['self'], description: 'Elasticsearch search port (app ↔ search, node-to-node)' },
    { port: 5432, sources: ['self'], description: 'PostgreSQL (node-to-node)' },
  ],

  // SonarQube's web/API front door is plain HTTP on 9000; TLS terminates at the
  // ALB (target protocol HTTP), like Splunk Web on 8000. Health via the Web API
  // system-status endpoint (200-399 covers UP / any auth redirect).
  loadBalancer: {
    targetPort: 9000,
    targetProtocol: 'HTTP',
    healthCheckPath: '/api/system/status',
    healthCheckMatcher: '200-399',
    targetKinds: ['sonarqube-app', 'standalone'],
  },

  dnsPrefixes: {
    'sonarqube-app': 'sonarqube',
    search: 'search',
    postgres: 'db',
    standalone: 'sonarqube',
  },

  // Public SonarQube web/API behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (SonarQube init / web + compute bring-up,
  // Elasticsearch + PostgreSQL wiring, DCE license) lives entirely behind this
  // entrypoint — proving the worker is tool-agnostic.
  bringup: './bringup/sonarqube-setup.mjs',
};

export default spec;
