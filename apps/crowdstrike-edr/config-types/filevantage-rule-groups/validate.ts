import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'
import type { LiveFileVantageEntity } from '../../lib/filevantageAdapter'

// --- FileVantage rule-group API constraints ----------------------------------
//
// A FileVantage rule group is a typed collection of file-integrity rules
// (createRuleGroups: name, description, type). `type` fixes what the group's
// rules may monitor and is immutable after creation. Verified against the
// Falcon FileVantage API (FalconPy `filevantage`) and the CrowdStrike Terraform
// provider's rule_group schema.

/** Rule-group `type` — the platform + object class the group's rules watch (immutable). */
export const RULE_GROUP_TYPES = ['WindowsFiles', 'WindowsRegistry', 'LinuxFiles', 'MacFiles'] as const

/** Per-rule `severity` categorizing the change events the rule produces. */
export const RULE_SEVERITIES = ['Low', 'Medium', 'High', 'Critical'] as const

/** Per-rule `depth` below the base path to monitor. ANY = fully recursive. */
export const RULE_DEPTHS = ['ANY', '1', '2', '3', '4', '5'] as const

export const MAX_RULE_GROUP_NAME_LENGTH = 255
export const MAX_RULE_DESCRIPTION_LENGTH = 500

// Watched-attribute toggles are the exact snake_case Falcon rule-body fields.
// File / directory events apply to the *Files types; registry key / value
// events apply only to WindowsRegistry — the API rejects a mismatch.
export const FILE_WATCH_ATTRIBUTES = [
  'watch_create_file_changes',
  'watch_write_file_changes',
  'watch_delete_file_changes',
  'watch_rename_file_changes',
  'watch_attributes_file_changes',
  'watch_permissions_file_changes',
  'watch_create_directory_changes',
  'watch_delete_directory_changes',
  'watch_rename_directory_changes',
  'watch_attributes_directory_changes',
  'watch_permissions_directory_changes',
] as const

export const REGISTRY_WATCH_ATTRIBUTES = [
  'watch_create_key_changes',
  'watch_delete_key_changes',
  'watch_rename_key_changes',
  'watch_permissions_key_changes',
  'watch_set_value_changes',
  'watch_delete_value_changes',
] as const

export const ALL_WATCH_ATTRIBUTES: readonly string[] = [
  ...FILE_WATCH_ATTRIBUTES,
  ...REGISTRY_WATCH_ATTRIBUTES,
]

/** Watched-attribute toggles valid for a given group type. */
export function watchAttributesForType(type: string): readonly string[] {
  return type === 'WindowsRegistry' ? REGISTRY_WATCH_ATTRIBUTES : FILE_WATCH_ATTRIBUTES
}

/** The content-capture content field + prerequisite watch toggle for a group type. */
export function contentFieldForType(type: string): {
  field: 'content_files' | 'content_registry_values'
  watch: string
} {
  return type === 'WindowsRegistry'
    ? { field: 'content_registry_values', watch: 'watch_set_value_changes' }
    : { field: 'content_files', watch: 'watch_write_file_changes' }
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

/**
 * One FileVantage rule declared under a group, mirroring the Falcon rule body.
 * `watchAttributes` holds only the toggles the author set; deploy fills the
 * remaining type-applicable toggles with false so it fully converges live state.
 */
export interface RuleSpec {
  path: string
  severity: string
  depth: string
  description: string
  include?: string
  exclude?: string
  includeUsers?: string
  excludeUsers?: string
  includeProcesses?: string
  excludeProcesses?: string
  contentFiles?: string[]
  contentRegistryValues?: string[]
  enableContentCapture: boolean
  watchAttributes: Record<string, boolean>
}

export interface RuleGroupSpec {
  sectionName: string
  name: string
  type: string
  description?: string
  rulesRaw?: string
}

/** Shape of a rule returned by GET /filevantage/entities/rule-groups-rules/v1. */
export interface LiveRule {
  id?: string
  precedence?: number
  path?: string
  severity?: string
  depth?: string
  description?: string
  include?: string
  exclude?: string
  include_users?: string
  exclude_users?: string
  include_processes?: string
  exclude_processes?: string
  content_files?: string[]
  content_registry_values?: string[]
  enable_content_capture?: boolean
  [key: string]: unknown
}

/** A group's ordered rule references as returned on the group entity (order = precedence). */
export interface AssignedRuleRef {
  id?: string
  href?: string
}

/** Shape of a rule group returned by GET /filevantage/entities/rule-groups/v1. */
export interface LiveRuleGroup extends LiveFileVantageEntity {
  type?: string
  /** Ordered rule references. `assigned_rules` is the documented field; `rules` is a defensive fallback. */
  assigned_rules?: AssignedRuleRef[]
  rules?: AssignedRuleRef[]
}

const normalizeType = (raw: string): string => {
  const t = raw.trim()
  return (RULE_GROUP_TYPES as readonly string[]).find((x) => x.toLowerCase() === t.toLowerCase()) ?? t
}

/** Each canvas item describes one FileVantage rule group. */
export function extractRuleGroupSpecs(canvas: CanvasSnapshot): RuleGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      type: normalizeType(typeof fields.type === 'string' ? fields.type : 'WindowsFiles'),
      description:
        typeof fields.description === 'string' && fields.description.trim()
          ? fields.description.trim()
          : undefined,
      rulesRaw:
        typeof fields.rules === 'string' && fields.rules.trim() ? fields.rules.trim() : undefined,
    }
  })
}

function asStringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  return out.length ? out : undefined
}

/**
 * Parse and structurally validate the rules JSON. Each entry must carry a
 * non-empty `path`, a known `severity`, a valid `depth` (default ANY) and a
 * `description` (1–500 chars, matching the API). Rule paths must be unique
 * within the group. Recognized `watch_*` toggles are collected; an unknown
 * `watch_*` key is reported (likely a typo) — other unknown keys are ignored so
 * the app forward-tolerates new Falcon rule fields.
 */
export function parseRuleSpecs(raw: string | undefined): { rules: RuleSpec[]; errors: string[] } {
  if (!raw) return { rules: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      rules: [],
      errors: [`Rules is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { rules: [], errors: ['Rules must be a JSON array of rule objects'] }
  }

  const rules: RuleSpec[] = []
  const errors: string[] = []
  const seenPaths = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Rule #${index + 1}: must be an object`)
      return
    }
    const e = entry as Record<string, unknown>

    const path = typeof e.path === 'string' ? e.path.trim() : ''
    if (!path) {
      errors.push(`Rule #${index + 1}: "path" must be a non-empty string`)
      return
    }
    if (seenPaths.has(path.toLowerCase())) {
      errors.push(`Rule "${path}": declared more than once`)
      return
    }
    seenPaths.add(path.toLowerCase())

    const rawSeverity = typeof e.severity === 'string' ? e.severity.trim() : ''
    const severity = (RULE_SEVERITIES as readonly string[]).find(
      (s) => s.toLowerCase() === rawSeverity.toLowerCase(),
    )
    if (!severity) {
      errors.push(`Rule "${path}": "severity" must be one of ${RULE_SEVERITIES.join(', ')}`)
      return
    }

    const rawDepth =
      typeof e.depth === 'string' ? e.depth.trim() : typeof e.depth === 'number' ? String(e.depth) : ''
    const depth = rawDepth === '' ? 'ANY' : (RULE_DEPTHS as readonly string[]).find((d) => d === rawDepth)
    if (!depth) {
      errors.push(`Rule "${path}": "depth" must be one of ${RULE_DEPTHS.join(', ')}`)
      return
    }

    const description = typeof e.description === 'string' ? e.description.trim() : ''
    if (!description) {
      errors.push(`Rule "${path}": "description" is required`)
      return
    }
    if (description.length > MAX_RULE_DESCRIPTION_LENGTH) {
      errors.push(`Rule "${path}": "description" must be ${MAX_RULE_DESCRIPTION_LENGTH} characters or fewer`)
      return
    }

    const watchAttributes: Record<string, boolean> = {}
    let watchError = ''
    for (const key of Object.keys(e)) {
      if (!key.startsWith('watch_')) continue
      if (!ALL_WATCH_ATTRIBUTES.includes(key)) {
        watchError = `Rule "${path}": unknown watched attribute "${key}"`
        break
      }
      watchAttributes[key] = coerceBoolean(e[key], false)
    }
    if (watchError) {
      errors.push(watchError)
      return
    }

    rules.push({
      path,
      severity,
      depth,
      description,
      include: asStringField(e.include),
      exclude: asStringField(e.exclude),
      includeUsers: asStringField(e.include_users),
      excludeUsers: asStringField(e.exclude_users),
      includeProcesses: asStringField(e.include_processes),
      excludeProcesses: asStringField(e.exclude_processes),
      contentFiles: asStringArray(e.content_files),
      contentRegistryValues: asStringArray(e.content_registry_values),
      enableContentCapture: coerceBoolean(e.enable_content_capture, false),
      watchAttributes,
    })
  })

  return { rules, errors }
}

/**
 * Semantic checks that depend on the group `type`: every declared watched
 * attribute must be valid for the type, and content capture requires its
 * type-specific content list plus the prerequisite watch toggle. Returns
 * human-readable error strings (empty when the rules fit the type).
 */
export function validateRulesForType(rules: RuleSpec[], type: string): string[] {
  const errors: string[] = []
  const allowed = new Set(watchAttributesForType(type))
  const { field, watch } = contentFieldForType(type)

  for (const rule of rules) {
    for (const key of Object.keys(rule.watchAttributes)) {
      if (!allowed.has(key)) {
        errors.push(
          `Rule "${rule.path}": watched attribute "${key}" is not valid for a ${type} rule group`,
        )
      }
    }

    if (rule.enableContentCapture) {
      const contentList = field === 'content_files' ? rule.contentFiles : rule.contentRegistryValues
      if (!contentList || contentList.length === 0) {
        errors.push(
          `Rule "${rule.path}": content capture requires "${field}" to list at least one entry`,
        )
      }
      if (!rule.watchAttributes[watch]) {
        errors.push(`Rule "${rule.path}": content capture requires "${watch}" to be enabled`)
      }
    }
  }

  return errors
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate FileVantage rule group configurations against the FileVantage API:
 * naming, group type, and the embedded rules model (path, severity, depth,
 * description, watched attributes, and content-capture prerequisites).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRuleGroupSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule group name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_GROUP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule group name must be ${MAX_RULE_GROUP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule group "${spec.name}" — each group may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — immutable after creation
    if (!(RULE_GROUP_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Type must be one of: ${RULE_GROUP_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // rules JSON — structural then type-specific
    const { rules, errors: ruleErrors } = parseRuleSpecs(spec.rulesRaw)
    for (const message of ruleErrors) {
      errors.push({ field: `${prefix}.rules`, message, code: 'invalid_rules' })
    }
    if (ruleErrors.length === 0 && (RULE_GROUP_TYPES as readonly string[]).includes(spec.type)) {
      for (const message of validateRulesForType(rules, spec.type)) {
        errors.push({ field: `${prefix}.rules`, message, code: 'invalid_rules' })
      }
    }

    // a rule group with no rules monitors nothing
    if (ruleErrors.length === 0 && rules.length === 0) {
      warnings.push({
        field: `${prefix}.rules`,
        message: 'Rule group declares no rules — it will not monitor anything until rules are added',
        code: 'no_rules',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
