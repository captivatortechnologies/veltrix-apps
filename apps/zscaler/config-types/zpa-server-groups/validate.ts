import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ServerGroupSpec {
  sectionName: string
  /** The server group name — its logical identity (list + match). */
  name: string
  description?: string
  enabled: boolean
  /**
   * When true, ZPA discovers member servers automatically from the App Connector
   * groups; when false, the group routes only to the explicitly listed servers.
   */
  dynamicDiscovery: boolean
  /** App Connector group NAMES the group binds to (resolved to ids at deploy). */
  appConnectorGroups: string[]
  /** Server NAMES routed to when dynamic discovery is off (resolved at deploy). */
  servers: string[]
}

/** Shape of a server group returned by GET /serverGroup. */
export interface LiveServerGroup {
  id?: string
  name?: string
  description?: string
  enabled?: boolean
  dynamicDiscovery?: boolean
  appConnectorGroups?: Array<{ id?: string; name?: string }>
  servers?: Array<{ id?: string; name?: string }>
}

/** Read a boolean field, defaulting to `fallback` when unset/non-boolean. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Split a textarea value into trimmed, non-blank lines. */
export function splitLines(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Each canvas item describes one ZPA server group. */
export function extractServerGroupSpecs(canvas: CanvasSnapshot): ServerGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const description =
      typeof fields.description === 'string' && fields.description.trim()
        ? fields.description.trim()
        : undefined
    return {
      sectionName: section.name,
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      description,
      enabled: readBool(fields.enabled, true),
      dynamicDiscovery: readBool(fields.dynamic_discovery, true),
      appConnectorGroups: splitLines(fields.app_connector_groups),
      servers: splitLines(fields.servers),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate server group configurations: a name is required and unique across the
 * canvas (matched case-insensitively — ZPA rejects groups differing only in
 * case), at least one App Connector group must be referenced, and when dynamic
 * discovery is disabled at least one server must be listed (a group with
 * discovery off would otherwise have no members). Referenced names are resolved
 * to ids at deploy.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractServerGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Server group name is required', code: 'required' })
    } else {
      if (spec.name.length > 255) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Server group name must be 255 characters or fewer',
          code: 'max_length',
        })
      }
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate server group "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_server_group',
        })
      }
      seen.add(key)
    }

    if (spec.appConnectorGroups.length === 0) {
      errors.push({
        field: `${prefix}.app_connector_groups`,
        message: 'At least one App Connector group is required',
        code: 'required',
      })
    }

    if (!spec.dynamicDiscovery && spec.servers.length === 0) {
      errors.push({
        field: `${prefix}.servers`,
        message: `Server group "${spec.name || prefix}" has dynamic discovery disabled and must list at least one server`,
        code: 'required',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
