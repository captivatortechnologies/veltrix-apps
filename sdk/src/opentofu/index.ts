// =============================================================================
// @veltrixsecops/app-sdk/opentofu
//
// Declarative, tool-agnostic infrastructure for BYOI apps. An app ships an
// InfraSpec (apps/<app>/infra/spec.ts); the SDK renders it into the generic
// OpenTofu module's tfvars (sdk/opentofu/modules/<cloud>); the platform worker
// applies it and runs the app's bring-up. No per-tool HCL, ever.
// =============================================================================

export type {
  InfraSpec,
  SecurityRule,
  SecuritySource,
  LoadBalancerSpec,
  StorageSpec,
  AlbAuthSpec,
  FoundationKind,
} from './spec';
export { FOUNDATION_KINDS } from './spec';

export type {
  AwsInfraVars,
  AwsLoadBalancerVars,
  AwsSecurityRuleVars,
  AwsAlbAuthVars,
} from './render';
export { renderInfraVars } from './render';

export { validateInfraSpec } from './validate';
