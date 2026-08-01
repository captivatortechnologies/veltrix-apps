// =============================================================================
// Velociraptor — declarative InfraSpec.
//
// PROOF OF GENERICITY: this is a different tool from Splunk / Security Onion /
// MISP (a Go endpoint-DFIR / hunting server: GUI + frontend + gRPC API, backed by
// an S3/MinIO file+datastore), yet it composes the SAME generic OpenTofu modules
// (sdk/opentofu/modules/<cloud>) purely by declaring different data. No
// tool-specific HCL exists anywhere.
//
// Node roles (compute, via foundation-exclusion):
//   velociraptor-server  the Velociraptor server: GUI + frontend + gRPC API.
//                        Scales horizontally — many frontends behind the ALB, all
//                        pointed at the shared datastore. This is the ALB target.
//   datastore            MinIO (S3-compatible shared file+datastore backend).
//   standalone           all-in-one single box (server + embedded datastore).
//
// Ports (Velociraptor reference — docs.velociraptor.app):
//   8889  Velociraptor GUI (HTTPS)                    — ALB-fronted
//   8000  Velociraptor frontend (endpoint client comms) — ALB-fronted
//   8001  Velociraptor gRPC API (mutual TLS)          — management
//   9000  MinIO S3 datastore (peer-only)
// Verify port/topology choices against your Velociraptor deployment guidance.
// =============================================================================

import type { InfraSpec } from '@veltrixsecops/app-sdk/opentofu';

export const spec: InfraSpec = {
  securityRules: [
    { port: 8889, sources: ['alb'], description: 'Velociraptor GUI (HTTPS)' },
    { port: 8000, sources: ['alb'], description: 'Velociraptor frontend — endpoint client comms' },
    { port: 8001, sources: ['admin'], description: 'Velociraptor gRPC API (mutual TLS, management)' },
    { port: 9000, sources: ['self'], description: 'MinIO S3 file+datastore backend (node-to-node)' },
  ],

  // The Velociraptor GUI is native HTTPS on 8889 — so the ALB re-encrypts to the
  // frontend nodes (target protocol HTTPS). Health-checks hit the GUI app entry.
  loadBalancer: {
    targetPort: 8889,
    targetProtocol: 'HTTPS',
    healthCheckPath: '/app/index.html',
    healthCheckMatcher: '200-399',
    targetKinds: ['velociraptor-server', 'standalone'],
  },

  dnsPrefixes: {
    'velociraptor-server': 'velociraptor',
    datastore: 'minio',
    standalone: 'velociraptor',
  },

  // No foundation object storage: the Velociraptor datastore is MinIO, modeled as
  // a compute node in the data tier — so `storage` is omitted (has_storage=false).

  // Public Velociraptor GUI behind the ALB → WAF managed rules + rate limit.
  waf: true,

  // Post-apply configuration management (server config generation, MinIO bring-up,
  // GUI admin user, artifact/monitoring seeding) lives entirely behind this
  // entrypoint — proving the worker is tool-agnostic.
  bringup: './bringup/velociraptor-setup.mjs',
};

export default spec;
