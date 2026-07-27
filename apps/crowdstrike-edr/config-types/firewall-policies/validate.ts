import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { PolicyEndpoints } from '../../lib/policyAdapter'

// --- Firewall Policy API constraints ------------------------------------------
//
// A firewall policy is SPLIT across two collections. The shell (name,
// description, platform, enablement, host groups) lives on the /policy/ family
// and is driven through lib/policyAdapter. The rule-group assignment and default
// in/out actions live in the fwmgr "policy container" (PUT /fwmgr/entities/
// policies/v2). deploy owns wiring the two together — see deploy.ts.

export const FIREWALL_ENDPOINTS: PolicyEndpoints = {
  entity: '/policy/entities/firewall/v1',
  combined: '/policy/combined/firewall/v1',
  actions: '/policy/entities/firewall-actions/v1',
  perPlatform: true,
}

/** platform_name is title-case on the /policy family and immutable after creation. */
export const POLICY_PLATFORMS = ['Windows', 'Mac', 'Linux'] as const

/** Default in/out actions accepted by the fwmgr policy container. */
export const FIREWALL_DEFAULT_ACTIONS = ['ALLOW', 'DENY'] as const

/** platform_name → the numeric platform_id the fwmgr container uses. */
export const PLATFORM_NAME_TO_ID: Record<string, string> = {
  Windows: '0',
  Mac: '1',
  Linux: '3',
}

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface FirewallPolicySpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  hostGroups: string[]
  /** Ordered rule-group ids — first is highest precedence. */
  ruleGroups: string[]
  defaultInbound: string
  defaultOutbound: string
  enforce: boolean
  localLogging: boolean
  testMode: boolean
}

/** Shape of the policy shell returned by GET /policy/combined/firewall/v1. */
export interface LiveFirewallPolicy {
  id?: string
  name?: string
  description?: string
  platform_name?: string
  enabled?: boolean
  groups?: Array<{ id?: string; name?: string }>
  /** Last modifier recorded by Falcon — used for drift attribution. */
  modified_by?: string
  modified_timestamp?: string
  // Index signature keeps this assignable to the adapter's LivePolicy; the
  // explicit modifier fields above stay typed for attachDriftActor.
  [key: string]: unknown
}

/** Shape of the fwmgr policy container returned by GET /fwmgr/entities/policies/v1. */
export interface LiveFirewallContainer {
  policy_id?: string
  platform_id?: string
  default_inbound?: string
  default_outbound?: string
  enforce?: boolean
  test_mode?: boolean
  local_logging?: boolean
  rule_group_ids?: string[]
  /** Optimistic-concurrency token echoed back on the container PUT. */
  tracking?: string
  [key: string]: unknown
}

/** Each canvas section describes one firewall policy. */
export function extractFirewallPolicySpecs(canvas: CanvasSnapshot): FirewallPolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim() : 'Windows'
    const platform =
      (POLICY_PLATFORMS as readonly string[]).find(
        (p) => p.toLowerCase() === rawPlatform.toLowerCase(),
      ) ?? rawPlatform

    const inbound =
      typeof fields.defaultInbound === 'string' && fields.defaultInbound.trim()
        ? fields.defaultInbound.trim().toUpperCase()
        : 'DENY'
    const outbound =
      typeof fields.defaultOutbound === 'string' && fields.defaultOutbound.trim()
        ? fields.defaultOutbound.trim().toUpperCase()
        : 'ALLOW'

    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      platform,
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      enabled: coerceBoolean(fields.enabled, false),
      hostGroups: splitList(fields.hostGroups),
      ruleGroups: splitList(fields.ruleGroups),
      defaultInbound: inbound,
      defaultOutbound: outbound,
      enforce: coerceBoolean(fields.enforce, false),
      localLogging: coerceBoolean(fields.localLogging, false),
      testMode: coerceBoolean(fields.testMode, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate firewall policy configurations: naming, platform, host-group
 * targeting, ordered rule-group assignment, and the default in/out actions.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFirewallPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_POLICY_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Policy name must be ${MAX_POLICY_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (spec.name.toLowerCase() === 'platform_default') {
        errors.push({
          field: `${prefix}.name`,
          message: 'The built-in default policy (platform_default) cannot be managed by this app',
          code: 'reserved_name',
        })
      }
      const key = `${spec.platform}:${spec.name.toLowerCase()}`
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" for platform ${spec.platform} — each policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — title-case, immutable after creation
    if (!(POLICY_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${POLICY_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // default in/out actions
    if (!(FIREWALL_DEFAULT_ACTIONS as readonly string[]).includes(spec.defaultInbound)) {
      errors.push({
        field: `${prefix}.defaultInbound`,
        message: `Default inbound action must be one of: ${FIREWALL_DEFAULT_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }
    if (!(FIREWALL_DEFAULT_ACTIONS as readonly string[]).includes(spec.defaultOutbound)) {
      errors.push({
        field: `${prefix}.defaultOutbound`,
        message: `Default outbound action must be one of: ${FIREWALL_DEFAULT_ACTIONS.join(', ')}`,
        code: 'invalid_action',
      })
    }

    // an enabled policy with no host groups protects nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message: 'Policy is enabled but assigned to no host groups — it will not apply to any hosts',
        code: 'no_host_groups',
      })
    }

    // test (monitor) mode only takes effect when the policy enforces rules
    if (spec.testMode && !spec.enforce) {
      warnings.push({
        field: `${prefix}.testMode`,
        message: 'Test mode has no effect unless "enforce" is enabled',
        code: 'monitor_requires_enforce',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
