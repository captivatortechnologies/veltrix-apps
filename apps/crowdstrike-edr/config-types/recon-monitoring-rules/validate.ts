import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { coerceBoolean } from '../../lib/falcon'

// --- Falcon Intelligence Recon API constraints -------------------------------
//
// A Recon monitoring rule watches a `topic` (the class of thing being monitored)
// for matches of an FQL `filter`. Its identity in the tenant is `name`. Verified
// against the FalconPy `recon` service collection (CreateRulesV1 / UpdateRulesV1
// body keywords). `topic` is only accepted on create — it is immutable and is
// absent from the update body — so a topic change is a delete + recreate.

/** Recon rule topics (the `topic` create field). Immutable after creation. */
export const RECON_TOPICS = [
  'SA_ALIAS',
  'SA_AUTHOR',
  'SA_BRAND_PRODUCT',
  'SA_CVE',
  'SA_DOMAIN',
  'SA_EMAIL',
  'SA_IP',
  'SA_THIRD_PARTY',
  'SA_CUSTOM',
] as const

export const RECON_PRIORITIES = ['low', 'medium', 'high'] as const
export const RECON_PERMISSIONS = ['public', 'private'] as const

/** Notification action constraints (CreateActionsV1 / UpdateActionV1). */
export const ACTION_TYPES = ['email'] as const
export const ACTION_FREQUENCIES = ['asap', 'daily', 'weekly'] as const
export const ACTION_CONTENT_FORMATS = ['standard', 'enhanced'] as const

export const MAX_RULE_NAME_LENGTH = 255

/** Loose email shape — action recipients are email addresses for email actions. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

/** One notification action declared under a rule, as the actions API expects it. */
export interface ActionSpec {
  type: string
  frequency: string
  recipients: string[]
  contentFormat: string
}

export interface ReconRuleSpec {
  sectionName: string
  name: string
  topic: string
  filter: string
  priority: string
  permissions: string
  breachMonitoring: boolean
  substringMatching: boolean
  /** Raw actions field (JSON array); parsed on demand via parseActions. */
  actionsRaw?: string
}

/** Shape of a notification action returned by the Recon actions API. */
export interface LiveAction {
  id?: string
  rule_id?: string
  type?: string
  frequency?: string
  recipients?: string[]
  content_format?: string
  status?: string
}

/** Each canvas section describes one Recon monitoring rule. */
export function extractReconRuleSpecs(canvas: CanvasSnapshot): ReconRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      topic:
        typeof fields.topic === 'string' && fields.topic.trim()
          ? fields.topic.trim().toUpperCase()
          : '',
      filter: typeof fields.filter === 'string' ? fields.filter.trim() : '',
      priority:
        typeof fields.priority === 'string' && fields.priority.trim()
          ? fields.priority.trim().toLowerCase()
          : 'medium',
      permissions:
        typeof fields.permissions === 'string' && fields.permissions.trim()
          ? fields.permissions.trim().toLowerCase()
          : 'private',
      breachMonitoring: coerceBoolean(fields.breachMonitoring, false),
      substringMatching: coerceBoolean(fields.substringMatching, false),
      actionsRaw:
        typeof fields.actions === 'string' && fields.actions.trim() ? fields.actions.trim() : undefined,
    }
  })
}

/**
 * Parse and structurally validate the actions JSON. Each entry must be
 * {type, frequency, recipients, contentFormat} where type/frequency/contentFormat
 * are from the known sets and recipients is a non-empty list of email addresses.
 * Two actions declared with the same type + frequency + recipients collide (they
 * converge to the same live action) and are rejected.
 */
export function parseActions(raw: string | undefined): {
  actions: ActionSpec[]
  errors: string[]
} {
  if (!raw) return { actions: [], errors: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      actions: [],
      errors: [`Actions is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`],
    }
  }

  if (!Array.isArray(parsed)) {
    return { actions: [], errors: ['Actions must be a JSON array of action objects'] }
  }

  const actions: ActionSpec[] = []
  const errors: string[] = []
  const seenKeys = new Set<string>()

  parsed.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`Action #${index + 1}: must be an object`)
      return
    }
    const e = entry as Record<string, unknown>

    const type = typeof e.type === 'string' && e.type.trim() ? e.type.trim().toLowerCase() : 'email'
    if (!(ACTION_TYPES as readonly string[]).includes(type)) {
      errors.push(`Action #${index + 1}: "type" must be one of ${ACTION_TYPES.join(', ')}`)
      return
    }

    const frequency =
      typeof e.frequency === 'string' ? e.frequency.trim().toLowerCase() : ''
    if (!(ACTION_FREQUENCIES as readonly string[]).includes(frequency)) {
      errors.push(`Action #${index + 1}: "frequency" must be one of ${ACTION_FREQUENCIES.join(', ')}`)
      return
    }

    const contentFormat =
      typeof e.contentFormat === 'string' && e.contentFormat.trim()
        ? e.contentFormat.trim().toLowerCase()
        : 'standard'
    if (!(ACTION_CONTENT_FORMATS as readonly string[]).includes(contentFormat)) {
      errors.push(
        `Action #${index + 1}: "contentFormat" must be one of ${ACTION_CONTENT_FORMATS.join(', ')}`,
      )
      return
    }

    if (!Array.isArray(e.recipients)) {
      errors.push(`Action #${index + 1}: "recipients" must be an array of email addresses`)
      return
    }
    const recipients = e.recipients.map((r) => String(r).trim()).filter((r) => r.length > 0)
    if (recipients.length === 0) {
      errors.push(`Action #${index + 1}: "recipients" must contain at least one email address`)
      return
    }
    const badEmail = recipients.find((r) => !EMAIL_RE.test(r))
    if (badEmail) {
      errors.push(`Action #${index + 1}: "${badEmail}" is not a valid email address`)
      return
    }

    const key = actionKey({ type, frequency, recipients })
    if (seenKeys.has(key)) {
      errors.push(
        `Action #${index + 1}: duplicates another action with the same type, frequency, and recipients`,
      )
      return
    }
    seenKeys.add(key)

    actions.push({ type, frequency, recipients, contentFormat })
  })

  return { actions, errors }
}

/**
 * Identity key for matching a declared action to a live one (and for deduping):
 * type + frequency + the recipient set. content_format is deliberately excluded
 * so a format-only change is an update rather than a delete + recreate.
 */
export function actionKey(action: {
  type: string
  frequency: string
  recipients: string[]
}): string {
  const recipients = [...action.recipients.map((r) => r.trim().toLowerCase())].sort()
  return `${action.type.toLowerCase()}|${action.frequency.toLowerCase()}|${recipients.join(',')}`
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Recon monitoring rule configurations against the Recon API: a unique
 * name (<= 255), a required FQL filter, a known topic/priority/permissions, and
 * well-formed notification actions (known type/frequency/content format, email
 * recipients).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractReconRuleSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name (identity)
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Rule name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_RULE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Rule name must be ${MAX_RULE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate rule "${spec.name}" — each rule name may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // topic — immutable after creation
    if (!spec.topic) {
      errors.push({ field: `${prefix}.topic`, message: 'Topic is required', code: 'required' })
    } else if (!(RECON_TOPICS as readonly string[]).includes(spec.topic)) {
      errors.push({
        field: `${prefix}.topic`,
        message: `Topic must be one of: ${RECON_TOPICS.join(', ')}`,
        code: 'invalid_topic',
      })
    }

    // filter (FQL) — required
    if (!spec.filter) {
      errors.push({ field: `${prefix}.filter`, message: 'Filter (FQL) is required', code: 'required' })
    }

    // priority
    if (!(RECON_PRIORITIES as readonly string[]).includes(spec.priority)) {
      errors.push({
        field: `${prefix}.priority`,
        message: `Priority must be one of: ${RECON_PRIORITIES.join(', ')}`,
        code: 'invalid_priority',
      })
    }

    // permissions
    if (!(RECON_PERMISSIONS as readonly string[]).includes(spec.permissions)) {
      errors.push({
        field: `${prefix}.permissions`,
        message: `Permissions must be one of: ${RECON_PERMISSIONS.join(', ')}`,
        code: 'invalid_permissions',
      })
    }

    // actions JSON
    const { actions, errors: actionErrors } = parseActions(spec.actionsRaw)
    for (const message of actionErrors) {
      errors.push({ field: `${prefix}.actions`, message, code: 'invalid_actions' })
    }
    if (spec.actionsRaw && actionErrors.length === 0 && actions.length === 0) {
      warnings.push({
        field: `${prefix}.actions`,
        message: 'Actions array is empty — the rule will match but send no notifications',
        code: 'no_actions',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
