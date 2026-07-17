// =============================================================================
// validateInfraSpec — cheap, dependency-free checks that catch the InfraSpec
// mistakes the OpenTofu module can't (or would only surface at apply time).
// Returns a list of human-readable errors; empty === valid.
// =============================================================================

import type { InfraSpec } from './spec';

export function validateInfraSpec(spec: InfraSpec): string[] {
  const errors: string[] = [];

  if (!Array.isArray(spec.securityRules) || spec.securityRules.length === 0) {
    errors.push('securityRules must contain at least one rule.');
  }

  const validSources = new Set(['self', 'alb', 'admin']);
  const usesAlbSource = (spec.securityRules ?? []).some((r) =>
    (r.sources ?? []).includes('alb'),
  );

  for (const r of spec.securityRules ?? []) {
    if (typeof r.port !== 'number' || r.port < 1 || r.port > 65535) {
      errors.push(`securityRules: invalid port ${JSON.stringify(r.port)}.`);
    }
    if (!Array.isArray(r.sources) || r.sources.length === 0) {
      errors.push(`securityRules[port ${r.port}]: sources must be non-empty.`);
    }
    for (const s of r.sources ?? []) {
      if (!validSources.has(s)) {
        errors.push(`securityRules[port ${r.port}]: unknown source "${s}" (expected self|alb|admin).`);
      }
    }
  }

  // "alb" sources are meaningless without a load balancer.
  if (usesAlbSource && !spec.loadBalancer) {
    errors.push('a securityRules entry uses source "alb" but no loadBalancer is declared.');
  }

  if (spec.loadBalancer) {
    const lb = spec.loadBalancer;
    if (typeof lb.targetPort !== 'number') {
      errors.push('loadBalancer.targetPort is required.');
    }
    if (!lb.healthCheckPath || !lb.healthCheckPath.startsWith('/')) {
      errors.push('loadBalancer.healthCheckPath must be an absolute path (start with "/").');
    }
    if (!Array.isArray(lb.targetKinds) || lb.targetKinds.length === 0) {
      errors.push('loadBalancer.targetKinds must name at least one compute kind.');
    }
    // The web tier must be reachable from the ALB.
    const targetPortOpen = (spec.securityRules ?? []).some(
      (r) => r.port === lb.targetPort && (r.sources ?? []).includes('alb'),
    );
    if (!targetPortOpen) {
      errors.push(
        `loadBalancer.targetPort ${lb.targetPort} is not opened to source "alb" in securityRules — the ALB can't reach the web tier.`,
      );
    }
  }

  if (spec.albAuth?.enabled) {
    const a = spec.albAuth;
    if (!a.userPoolArn || !a.userPoolClientId || !a.userPoolDomain) {
      errors.push('albAuth.enabled requires userPoolArn, userPoolClientId and userPoolDomain.');
    }
    if (!spec.loadBalancer) {
      errors.push('albAuth is set but there is no loadBalancer to attach it to.');
    }
  }

  return errors;
}
