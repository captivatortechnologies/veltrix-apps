import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAll, extractElement, extractText } from '../../lib/jamfClassicXml'

// =============================================================================
// Jamf Pro Restricted Software — Classic API (XML).
// https://developer.jamf.com/jamf-pro/reference/findrestrictedsoftware (list)
// https://developer.jamf.com/jamf-pro/reference/findrestrictedsoftwarebyid (detail)
// https://developer.jamf.com/jamf-pro/reference/createrestrictedsoftwarebyid
// No modern Jamf Pro API v1/v2 equivalent was found for this resource — this
// remains Classic-API only.
//
// Document shape (verified): `<restricted_software><general>…</general>
// <scope>…</scope></restricted_software>` — same general+scope wrapper shape
// as Policies. The LIST endpoint wraps each item as `<restricted_software_title>`
// (NOT `<restricted_software>` — the one Classic list in this app whose item
// tag differs from its detail root; verified explicitly rather than assumed).
//
// This config type manages the same scope subset as Policies (all_computers
// + computer-group scoping/exclusions by name) — buildings/departments
// scoping, also present on this resource, is intentionally NOT managed, for
// consistency with the Policies scope subset.
// =============================================================================

export interface RestrictedSoftwareSpec {
  sectionName: string
  name: string
  processName: string
  matchExactProcessName: boolean
  sendNotification: boolean
  killProcess: boolean
  deleteExecutable: boolean
  displayMessage: string
  allComputers: boolean
  computerGroupNames: string[]
  exclusionComputerGroupNames: string[]
}

export interface LiveRestrictedSoftwareGeneral {
  name: string
  processName: string
  matchExactProcessName: boolean
  sendNotification: boolean
  killProcess: boolean
  deleteExecutable: boolean
  displayMessage: string
}

export interface LiveRestrictedSoftwareScope {
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

export function restrictedSoftwareKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexRestrictedSoftwareByName<T extends { name?: string }>(items: T[]): Map<string, T> {
  const byName = new Map<string, T>()
  for (const item of items) {
    if (!item.name) continue
    const key = restrictedSoftwareKey(item.name)
    if (!byName.has(key)) byName.set(key, item)
  }
  return byName
}

export function extractRestrictedSoftwareSpecs(canvas: CanvasSnapshot): RestrictedSoftwareSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      processName: str(fields.process_name),
      matchExactProcessName: readBool(fields.match_exact_process_name, false),
      sendNotification: readBool(fields.send_notification, false),
      killProcess: readBool(fields.kill_process, false),
      deleteExecutable: readBool(fields.delete_executable, false),
      displayMessage: str(fields.display_message),
      allComputers: readBool(fields.all_computers, false),
      computerGroupNames: strList(fields.computer_group_names),
      exclusionComputerGroupNames: strList(fields.exclusion_computer_group_names),
    }
  })
}

// --- Live XML parsing (drift / health check) ----------------------------------

export function parseRestrictedSoftwareGeneralXml(generalXml: string): LiveRestrictedSoftwareGeneral {
  return {
    name: extractText(generalXml, 'name'),
    processName: extractText(generalXml, 'process_name'),
    matchExactProcessName: extractText(generalXml, 'match_exact_process_name').toLowerCase() === 'true',
    sendNotification: extractText(generalXml, 'send_notification').toLowerCase() === 'true',
    killProcess: extractText(generalXml, 'kill_process').toLowerCase() === 'true',
    deleteExecutable: extractText(generalXml, 'delete_executable').toLowerCase() === 'true',
    displayMessage: extractText(generalXml, 'display_message'),
  }
}

export function parseRestrictedSoftwareScopeXml(scopeXml: string): LiveRestrictedSoftwareScope {
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
 * Validate restricted software configurations: name and process name are
 * required; name unique across the canvas (case-insensitive).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRestrictedSoftwareSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Restricted software name is required', code: 'required' })
    }
    if (!spec.processName) {
      errors.push({ field: `${prefix}.process_name`, message: 'Process name is required', code: 'required' })
    }

    if (spec.name) {
      const key = restrictedSoftwareKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate restricted software "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_restricted_software',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
