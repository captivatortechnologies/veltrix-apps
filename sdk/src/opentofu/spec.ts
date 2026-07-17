// =============================================================================
// InfraSpec — the declarative, tool-agnostic infrastructure contract.
//
// An app ships one of these in `apps/<app>/infra/spec.ts`. The SDK renders it
// into the generic OpenTofu module's tfvars (see ./render). NOTHING in the
// module is tool-specific: an app supplies all of its shape (roles, ports,
// front-door, DNS, bring-up) as DATA here, so the same modules provision Splunk,
// Security Onion, or any other BYOI tool without a line of per-tool HCL.
//
// Pairs with sdk/opentofu/modules/<cloud> (the generic HCL) and the platform
// render+apply worker, which invokes the app's `bringup` entrypoint after apply.
// =============================================================================

/** Where a security-group ingress rule may allow traffic from. */
export type SecuritySource =
  | 'self' // peer nodes in this stack (the node SG referencing itself)
  | 'alb' // the public ALB security group (only valid when loadBalancer is set)
  | 'admin'; // the Veltrix control-plane / admin CIDR (var.admin_cidr)

/** One security-group ingress rule: a port and who may reach it. */
export interface SecurityRule {
  /** Destination port to open on the compute nodes. */
  port: number;
  /** IP protocol. Default 'tcp'. */
  protocol?: 'tcp' | 'udp';
  /** Origins allowed to reach `port`. At least one. */
  sources: SecuritySource[];
  /** Human-readable description (surfaced on the rule). */
  description?: string;
}

/** Front-door ALB spec. Omit entirely for forwarder-only / headless tools. */
export interface LoadBalancerSpec {
  /** Port the tool's web UI listens on behind the ALB (e.g. Splunk Web 8000). */
  targetPort: number;
  /** ALB→instance protocol. Default 'HTTP' (TLS terminates at the ALB). */
  targetProtocol?: 'HTTP' | 'HTTPS';
  /** Health-check path on the target (e.g. '/en-US/account/login'). */
  healthCheckPath: string;
  /** Health-check success matcher. Default '200-399'. */
  healthCheckMatcher?: string;
  /** Health-check protocol. Default = targetProtocol. */
  healthCheckProtocol?: 'HTTP' | 'HTTPS';
  /** Compute kinds that sit behind the ALB (e.g. ['search-head','standalone']). */
  targetKinds: string[];
  /** Public HTTPS listener port. Default 443. */
  listenerPort?: number;
}

/** An object-storage bucket the tool needs (e.g. Splunk SmartStore, frozen). */
export interface StorageSpec {
  /** Logical suffix for the bucket name (e.g. 'smartstore'). */
  name: string;
}

/** Optional Cognito/OIDC MFA enforced at the ALB, in front of the tool's UI. */
export interface AlbAuthSpec {
  enabled: boolean;
  userPoolArn?: string;
  userPoolClientId?: string;
  userPoolDomain?: string;
}

/**
 * The complete declarative infra spec for one app. Everything tool-shaped is a
 * value here; the generic module reads these via tfvars.
 */
export interface InfraSpec {
  /**
   * Explicit compute kinds. When omitted, ANY plan item whose `kind` is not a
   * generic FOUNDATION kind (see FOUNDATION_KINDS) is treated as compute — so an
   * app's roles become compute automatically without listing them here.
   */
  computeKinds?: string[];

  /** SG ingress rules: the tool's ports and who may reach each. */
  securityRules: SecurityRule[];

  /** ALB front-door. Omit for tools with no web UI. */
  loadBalancer?: LoadBalancerSpec;

  /**
   * kind → DNS label prefix for per-node function FQDNs
   * (e.g. { indexer: 'idx', 'search-head': 'sh', 'cluster-manager': 'mgmt' }).
   * A kind absent from the map falls back to the kind string itself.
   */
  dnsPrefixes: Record<string, string>;

  /** Object-storage buckets to create. Omit if the tool needs none. */
  storage?: StorageSpec[];

  /**
   * Attach a WAFv2 web ACL (AWS-managed rule sets + IP rate limit) to the ALB.
   * Defaults to true when `loadBalancer` is set; ignored otherwise.
   */
  waf?: boolean;

  /** Optional ALB Cognito MFA. */
  albAuth?: AlbAuthSpec;

  /**
   * Path, relative to the app's `infra/` dir, to the bring-up entrypoint the
   * generic worker runs after `tofu apply` succeeds (config management +
   * readiness gate). ALL tool-specific configuration lives behind this — e.g.
   * './bringup/ansible/site.yml' for Splunk. Omit for tools that are ready at
   * boot (no post-provision configuration).
   */
  bringup?: string;
}

/**
 * Generic foundation kinds the module realizes as shared infra (not compute).
 * Any plan `kind` NOT in this set is compute. Kept in sync with the module's
 * `var.foundation_kinds` default.
 */
export const FOUNDATION_KINDS = [
  'network',
  'storage',
  'secrets',
  'tls',
  'load-balancer',
  'dns',
  'license-file',
  'hec',
] as const;

export type FoundationKind = (typeof FOUNDATION_KINDS)[number];
