// =============================================================================
// render — turn an app's declarative InfraSpec into the generic OpenTofu
// module's variable values (tfvars).
//
// The platform render+apply worker builds the BASE vars (app_id, customer_id,
// plan, subnet_cidr, tags, region, ...) from the DeployRequest, and merges these
// SPEC-derived vars on top. Field names are snake_case to match the HCL module
// variables 1:1. Defaults mirror the module's `optional(...)` defaults, applied
// here so the emitted tfvars are explicit and self-describing.
// =============================================================================

import type { InfraSpec } from './spec';

/** ALB spec as the module expects it (snake_case). */
export interface AwsLoadBalancerVars {
  target_port: number;
  target_protocol: 'HTTP' | 'HTTPS';
  health_check_path: string;
  health_check_matcher: string;
  health_check_protocol: string; // "" => module falls back to target_protocol
  target_kinds: string[];
  listener_port: number;
}

/** One rendered SG ingress rule (snake_case). */
export interface AwsSecurityRuleVars {
  port: number;
  protocol: 'tcp' | 'udp';
  sources: string[];
  description: string;
}

/** Cognito MFA vars (snake_case), always present so `var.alb_auth.enabled` resolves. */
export interface AwsAlbAuthVars {
  enabled: boolean;
  user_pool_arn: string;
  user_pool_client_id: string;
  user_pool_domain: string;
}

/** The spec-derived subset of the generic AWS module's variables. */
export interface AwsInfraVars {
  compute_kinds: string[];
  security_rules: AwsSecurityRuleVars[];
  load_balancer: AwsLoadBalancerVars | null;
  dns_prefixes: Record<string, string>;
  waf_enabled: boolean;
  alb_auth: AwsAlbAuthVars;
}

/**
 * Render the spec-derived tfvars for the generic AWS module. Pure and
 * deterministic — no I/O, no clock, no randomness.
 */
export function renderInfraVars(spec: InfraSpec): AwsInfraVars {
  const security_rules: AwsSecurityRuleVars[] = (spec.securityRules ?? []).map((r) => ({
    port: r.port,
    protocol: r.protocol ?? 'tcp',
    sources: [...r.sources],
    description: r.description ?? '',
  }));

  const load_balancer: AwsLoadBalancerVars | null = spec.loadBalancer
    ? {
        target_port: spec.loadBalancer.targetPort,
        target_protocol: spec.loadBalancer.targetProtocol ?? 'HTTP',
        health_check_path: spec.loadBalancer.healthCheckPath,
        health_check_matcher: spec.loadBalancer.healthCheckMatcher ?? '200-399',
        health_check_protocol: spec.loadBalancer.healthCheckProtocol ?? '',
        target_kinds: [...spec.loadBalancer.targetKinds],
        listener_port: spec.loadBalancer.listenerPort ?? 443,
      }
    : null;

  // WAF defaults ON when there is a load balancer, OFF otherwise (the module
  // ignores it without an ALB, but keep the emitted value honest).
  const waf_enabled = spec.waf ?? Boolean(spec.loadBalancer);

  const alb_auth: AwsAlbAuthVars = {
    enabled: spec.albAuth?.enabled ?? false,
    user_pool_arn: spec.albAuth?.userPoolArn ?? '',
    user_pool_client_id: spec.albAuth?.userPoolClientId ?? '',
    user_pool_domain: spec.albAuth?.userPoolDomain ?? '',
  };

  return {
    compute_kinds: spec.computeKinds ? [...spec.computeKinds] : [],
    security_rules,
    load_balancer,
    dns_prefixes: { ...spec.dnsPrefixes },
    waf_enabled,
    alb_auth,
  };
}
