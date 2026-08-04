import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAll, extractElement, extractText } from '../../lib/jamfClassicXml'

// =============================================================================
// Jamf Pro macOS Configuration Profiles — Classic API (XML).
// https://developer.jamf.com/jamf-pro/reference/findosxconfigurationprofiles (list)
// https://developer.jamf.com/jamf-pro/reference/findosxconfigurationprofilesbyid (detail)
// https://developer.jamf.com/jamf-pro/reference/createosxconfigurationprofilebyid
// https://developer.jamf.com/jamf-pro/reference/updateosxconfigurationprofilebyid
//
// Document shape (verified): `<os_x_configuration_profile><general>…</general>
// <scope>…</scope><self_service>…</self_service></os_x_configuration_profile>`.
//
// THE PAYLOAD IS OPAQUE. `general.payloads` is a single string field holding
// the full embedded Apple `.mobileconfig` plist (itself XML), confirmed by
// the Jamf Pro docs ("encoded plist payloads containing the actual Apple
// configuration details") but with no further structure documented for the
// Classic API to interpret. This config type therefore treats `payloads` as a
// verbatim passthrough string — paste the complete plist XML (starting
// `<?xml version="1.0" ...?><!DOCTYPE plist ...><plist version="1.0">…`) and
// it is escaped/unescaped as XML TEXT CONTENT of `<payloads>` (via the same
// `tag()`/`extractText()` helpers as every other leaf), never parsed or
// validated as a plist. Getting the plist's own internal payload UUIDs/types
// right is entirely the operator's responsibility — this is a deliberate,
// flagged scope boundary, not an oversight (see README § Coverage).
//
// Managed fields: general.name/description/distribution_method/
// user_removable/level, and scope (all_computers + computer-group scoping by
// name, matching the Policies/Restricted Software scope subset). NOT
// managed: category, site, uuid, redeploy_on_update (all server- or
// console-assigned), the self_service block (Self Service branding —
// cosmetic), and building/department/individual-user scope.
// =============================================================================

export const DISTRIBUTION_METHODS = ['Install Automatically', 'Make Available in Self Service'] as const
export const LEVELS = ['computer', 'user'] as const

export interface ProfileSpec {
  sectionName: string
  name: string
  description: string
  distributionMethod: string
  userRemovable: boolean
  level: string
  payloads: string
  allComputers: boolean
  computerGroupNames: string[]
  exclusionComputerGroupNames: string[]
}

export interface LiveProfileGeneral {
  name: string
  description: string
  distributionMethod: string
  userRemovable: boolean
  level: string
  payloads: string
}

export interface LiveProfileScope {
  allComputers: boolean
  groupNames: string[]
  exclusionGroupNames: string[]
}

/** Read a canvas value that may be a `tags` array, a single string, or a comma list. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v.trim() : '')).filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return []
}

export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

export function profileKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexProfilesByName<T extends { name?: string }>(items: T[]): Map<string, T> {
  const byName = new Map<string, T>()
  for (const item of items) {
    if (!item.name) continue
    const key = profileKey(item.name)
    if (!byName.has(key)) byName.set(key, item)
  }
  return byName
}

export function extractProfileSpecs(canvas: CanvasSnapshot): ProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      distributionMethod: str(fields.distribution_method) || 'Install Automatically',
      userRemovable: readBool(fields.user_removable, true),
      level: str(fields.level) || 'computer',
      payloads: typeof fields.payloads === 'string' ? fields.payloads : '',
      allComputers: readBool(fields.all_computers, false),
      computerGroupNames: strList(fields.computer_group_names),
      exclusionComputerGroupNames: strList(fields.exclusion_computer_group_names),
    }
  })
}

// --- Live XML parsing (drift / health check) ----------------------------------

export function parseProfileGeneralXml(generalXml: string): LiveProfileGeneral {
  return {
    name: extractText(generalXml, 'name'),
    description: extractText(generalXml, 'description'),
    distributionMethod: extractText(generalXml, 'distribution_method'),
    userRemovable: extractText(generalXml, 'user_removable').toLowerCase() === 'true',
    level: extractText(generalXml, 'level'),
    payloads: extractText(generalXml, 'payloads'),
  }
}

export function parseProfileScopeXml(scopeXml: string): LiveProfileScope {
  const allComputers = extractText(scopeXml, 'all_computers').toLowerCase() === 'true'
  const groupsBlock = extractElement(scopeXml, 'computer_groups')
  const groupNames = groupsBlock ? extractAll(groupsBlock, 'computer_group').map((el) => extractText(el, 'name')) : []
  const exclusionsBlock = extractElement(scopeXml, 'exclusions')
  const exclusionGroupsBlock = exclusionsBlock ? extractElement(exclusionsBlock, 'computer_groups') : null
  const exclusionGroupNames = exclusionGroupsBlock
    ? extractAll(exclusionGroupsBlock, 'computer_group').map((el) => extractText(el, 'name'))
    : []
  return { allComputers, groupNames, exclusionGroupNames }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate macOS configuration profile configurations: name and a non-empty
 * payload are required (Jamf Pro itself would reject a profile whose payload
 * doesn't parse as a plist — that surfaces as a deploy-time error, not here);
 * name unique across the canvas (case-insensitive); distribution_method and
 * level must be supported values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Profile name is required', code: 'required' })
    }
    if (!spec.payloads) {
      errors.push({ field: `${prefix}.payloads`, message: 'A plist payload is required', code: 'required' })
    } else if (!/<plist[\s>]/.test(spec.payloads)) {
      warnings.push({
        field: `${prefix}.payloads`,
        message: 'Payload does not look like a plist (no <plist> element found) — Jamf Pro will reject it at deploy time if malformed',
        code: 'payload_shape',
      })
    }
    if (!DISTRIBUTION_METHODS.includes(spec.distributionMethod as (typeof DISTRIBUTION_METHODS)[number])) {
      errors.push({
        field: `${prefix}.distribution_method`,
        message: `Unsupported distribution method "${spec.distributionMethod}"`,
        code: 'invalid_distribution_method',
      })
    }
    if (!LEVELS.includes(spec.level as (typeof LEVELS)[number])) {
      errors.push({ field: `${prefix}.level`, message: `Unsupported level "${spec.level}"`, code: 'invalid_level' })
    }

    if (spec.name) {
      const key = profileKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate profile "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_profile',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
