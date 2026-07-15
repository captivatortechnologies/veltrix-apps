import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Network Zones API constraints --------------------------------------

/** The three network-zone kinds Okta supports. */
export const ZONE_TYPES = ['IP', 'DYNAMIC', 'DYNAMIC_V2'] as const
export type ZoneType = (typeof ZONE_TYPES)[number]

/** A zone's lifecycle state — changed via the lifecycle endpoints, not PUT. */
export const ZONE_STATUSES = ['ACTIVE', 'INACTIVE'] as const

/** A zone name is capped at 128 characters. */
export const MAX_ZONE_NAME_LENGTH = 128

/**
 * Okta seeds every org with these system zones. They are `system: true`, so they
 * may only be updated in place — NEVER created or deleted. validate rejects these
 * names outright: they are not zones a customer should be authoring as code.
 */
export const PROTECTED_ZONE_NAMES = [
  'LegacyIpZone',
  'BlockedIpZone',
  'DefaultEnhancedDynamicZone',
  'DefaultExemptIpZone',
] as const

/** True when `name` matches a protected Okta system zone (case-insensitive). */
export function isProtectedZoneName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (PROTECTED_ZONE_NAMES as readonly string[]).some((n) => n.toLowerCase() === lower)
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift -------

export interface ZoneSpec {
  sectionName: string
  /** Zone kind — one of IP | DYNAMIC | DYNAMIC_V2. */
  type: string
  /** Zone name — the logical identity deploy matches on. */
  name: string
  /** Desired lifecycle status — ACTIVE | INACTIVE. */
  status: string
  /**
   * Raw JSON string of the type-specific definition arrays:
   *   - IP          → gateways / proxies
   *   - DYNAMIC     → asns / locations / proxyType
   *   - DYNAMIC_V2  → asns / locations / proxyType / ipServiceCategories
   * Parsed to an object and merged into the create/update body.
   */
  configJson?: string
}

/**
 * Shape of a zone returned by GET /zones. Carries an index signature so the
 * free-form definition keys (gateways, proxies, asns, …) are readable and so a
 * live zone can be handed to helpers typed as `Record<string, unknown>`.
 */
export interface LiveZone {
  id?: string
  name?: string
  type?: string
  status?: string
  system?: boolean
  created?: string
  lastUpdated?: string
  gateways?: unknown
  proxies?: unknown
  asns?: unknown
  locations?: unknown
  proxyType?: unknown
  ipServiceCategories?: unknown
  _links?: unknown
  _embedded?: unknown
  [key: string]: unknown
}

/**
 * Parse a raw JSON string, returning the object or null when the string is not a
 * JSON object (a JSON array or primitive counts as invalid too). Shared by
 * validate (to reject bad input) and deploy (to build the API body).
 */
export function parseConfigObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Each canvas item describes one Okta network zone. */
export function extractZoneSpecs(canvas: CanvasSnapshot): ZoneSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const configJson =
      typeof fields.configJson === 'string' && fields.configJson.trim()
        ? fields.configJson.trim()
        : undefined

    return {
      sectionName: section.name,
      // Zone types/statuses are upper-case enums; normalise so a lower-case
      // entry still matches instead of failing as "invalid".
      type: typeof fields.type === 'string' ? fields.type.trim().toUpperCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      status: typeof fields.status === 'string' ? fields.status.trim().toUpperCase() : 'ACTIVE',
      configJson,
    }
  })
}

// --- Per-type definition helpers ---------------------------------------------

function isNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
}

/**
 * A light per-type sanity check that the definition blob carries at least one of
 * the fields the zone kind requires. Returns an error message, or null when the
 * definition is sufficient. Deliberately shallow — it never validates the shape
 * of individual gateways/locations, only that the zone is not empty.
 */
export function checkZoneDefinition(type: string, config: Record<string, unknown>): string | null {
  if (type === 'IP') {
    if (isNonEmptyArray(config.gateways) || isNonEmptyArray(config.proxies)) return null
    return 'An IP zone needs at least one entry in "gateways" or "proxies", e.g. {"gateways":[{"type":"CIDR","value":"1.2.3.0/24"}]}'
  }
  if (type === 'DYNAMIC') {
    if (isNonEmptyArray(config.asns) || isNonEmptyArray(config.locations) || isPresent(config.proxyType)) {
      return null
    }
    return 'A DYNAMIC zone needs at least one of "asns", "locations" or "proxyType", e.g. {"locations":[{"country":"US"}]}'
  }
  if (type === 'DYNAMIC_V2') {
    if (
      isNonEmptyArray(config.asns) ||
      isNonEmptyArray(config.locations) ||
      isNonEmptyArray(config.ipServiceCategories)
    ) {
      return null
    }
    return 'A DYNAMIC_V2 zone needs at least one of "asns", "locations" or "ipServiceCategories"'
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate network-zone configurations against the Okta Zones API. Static only —
 * it never contacts Okta:
 *   - name is required, <= 128 chars, and unique within the canvas
 *   - name is not one of the protected Okta system zones
 *   - type is one of IP | DYNAMIC | DYNAMIC_V2
 *   - status (when set) is ACTIVE | INACTIVE
 *   - configJson (when set) parses to a JSON OBJECT, and the object carries the
 *     minimum definition fields for the zone's type
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractZoneSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // name — required, <= 128 chars, unique, and not a protected system zone
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Zone name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_ZONE_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.name`,
          message: `Zone name must be ${MAX_ZONE_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (isProtectedZoneName(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `"${spec.name}" is a protected Okta system zone — it may not be created or deleted through this app (Okta manages it). Choose a different zone name.`,
          code: 'protected_zone',
        })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate zone "${spec.name}" — each zone may only be declared once per canvas`,
          code: 'duplicate_name',
        })
      }
      seenNames.add(key)
    }

    // type — required and in the supported enum
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Zone type is required', code: 'required' })
    } else if (!(ZONE_TYPES as readonly string[]).includes(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Zone type must be one of: ${ZONE_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // status — when set, must be ACTIVE or INACTIVE
    if (spec.status && !(ZONE_STATUSES as readonly string[]).includes(spec.status)) {
      errors.push({
        field: `${prefix}.status`,
        message: `Status must be one of: ${ZONE_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    // configJson — when present it must parse to a JSON object; then run the
    // light per-type definition check. A malformed blob short-circuits the
    // per-type check to avoid a confusing double error.
    const config = spec.configJson ? parseConfigObject(spec.configJson) : {}
    if (spec.configJson && config === null) {
      errors.push({
        field: `${prefix}.configJson`,
        message:
          'Zone definition must be a valid JSON object, e.g. {"gateways":[{"type":"CIDR","value":"1.2.3.0/24"}]}',
        code: 'invalid_config',
      })
    } else if (config && (ZONE_TYPES as readonly string[]).includes(spec.type)) {
      const problem = checkZoneDefinition(spec.type, config)
      if (problem) {
        errors.push({ field: `${prefix}.configJson`, message: problem, code: 'missing_definition' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
