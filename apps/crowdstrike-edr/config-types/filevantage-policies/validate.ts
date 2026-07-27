import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList } from '../../lib/falcon'
import type { LiveFileVantageEntity } from '../../lib/filevantageAdapter'

// --- FileVantage Policy API constraints ---------------------------------------

/** platform is title-case in the API and immutable after creation. */
export const FILEVANTAGE_PLATFORMS = ['Windows', 'Linux', 'Mac'] as const

export const MAX_POLICY_NAME_LENGTH = 255

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface FileVantagePolicySpec {
  sectionName: string
  name: string
  platform: string
  description?: string
  enabled: boolean
  /** Assigned host group ids — order-insensitive. */
  hostGroups: string[]
  /** Assigned rule group ids — ORDERED (the order sets rule-group precedence). */
  ruleGroups: string[]
}

/** Each canvas section describes one Falcon FileVantage policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): FileVantagePolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const rawPlatform = typeof fields.platform === 'string' ? fields.platform.trim() : 'Windows'
    const platform =
      (FILEVANTAGE_PLATFORMS as readonly string[]).find(
        (p) => p.toLowerCase() === rawPlatform.toLowerCase(),
      ) ?? rawPlatform

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
    }
  })
}

/** Host-group ids attached to a live policy (host_groups may be ids or {id} objects). */
export function fileVantageHostGroupIds(entity: LiveFileVantageEntity): string[] {
  return extractGroupIds(entity.host_groups)
}

/** Rule-group ids attached to a live policy, in precedence order (rule_groups may be ids or {id} objects). */
export function fileVantageRuleGroupIds(entity: LiveFileVantageEntity): string[] {
  return extractGroupIds(entity.rule_groups)
}

function extractGroupIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((g) =>
      typeof g === 'string'
        ? g
        : g && typeof g === 'object'
          ? (g as { id?: unknown }).id
          : undefined,
    )
    .filter((id): id is string => typeof id === 'string')
}

/** Ordered list equality — rule-group precedence drifts when the order differs. */
export function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate FileVantage policy configurations against FileVantage Policy API
 * constraints: naming, platform names, host group targeting, and the ordered
 * rule group assignment that decides which files the policy monitors.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPolicySpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — FileVantage looks a policy up by name alone, so names are global
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
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each FileVantage policy may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // platform — title-case, immutable after creation
    if (!(FILEVANTAGE_PLATFORMS as readonly string[]).includes(spec.platform)) {
      errors.push({
        field: `${prefix}.platform`,
        message: `Platform must be one of: ${FILEVANTAGE_PLATFORMS.join(', ')}`,
        code: 'invalid_platform',
      })
    }

    // a rule group declared twice makes precedence ambiguous
    const seenRuleGroups = new Set<string>()
    for (const ruleGroup of spec.ruleGroups) {
      if (seenRuleGroups.has(ruleGroup)) {
        warnings.push({
          field: `${prefix}.ruleGroups`,
          message: `Rule group "${ruleGroup}" is listed more than once — precedence is ambiguous`,
          code: 'duplicate_rule_group',
        })
      }
      seenRuleGroups.add(ruleGroup)
    }

    // an enabled policy with no host groups applies to nothing
    if (spec.enabled && spec.hostGroups.length === 0) {
      warnings.push({
        field: `${prefix}.hostGroups`,
        message:
          'Policy is enabled but assigned to no host groups — it will not apply to any hosts',
        code: 'no_host_groups',
      })
    }

    // an enabled policy with no rule groups monitors nothing
    if (spec.enabled && spec.ruleGroups.length === 0) {
      warnings.push({
        field: `${prefix}.ruleGroups`,
        message:
          'Policy is enabled but has no rule groups — it monitors no files or registry keys',
        code: 'no_rule_groups',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
