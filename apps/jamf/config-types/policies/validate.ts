import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractAll, extractElement, extractText } from '../../lib/jamfClassicXml'

// =============================================================================
// Jamf Pro Policies — Classic API (XML).
//
// Policies are still Classic-API only:
// https://developer.jamf.com/jamf-pro/reference/findpoliciesbyid documents
// the full XML schema (general / scope / scripts / package_configuration /
// self_service / maintenance / …), rooted at https://<host>/JSSResource.
//
// THIS CONFIG TYPE MANAGES ONLY: general.name, general.enabled, the six
// boolean triggers, general.frequency, scope (all_computers + computer group
// scoping/exclusions), scripts, and packages — the exact field set specified
// for this release. Every OTHER policy section (self_service, maintenance,
// account_maintenance, disk_encryption, printers, dock_items, reboot,
// files_processes, user_interaction, vpp, category, site, …) is intentionally
// UNMANAGED: deploy.ts merges only these fields into (or out of) the policy's
// existing XML rather than replacing the whole document, so an admin's
// Self Service description, maintenance tasks, etc. configured through the
// Jamf Pro UI are never silently wiped by a Veltrix deploy. See deploy.ts.
// =============================================================================

export const FREQUENCIES = [
  'Once per computer',
  'Once per user per computer',
  'Once per user',
  'Once every day',
  'Once every week',
  'Once every month',
  'Ongoing',
] as const

/** Canvas `triggers` multiselect values → the Classic API's six boolean trigger leaves. */
export const TRIGGER_KEYS = [
  'trigger_checkin',
  'trigger_enrollment_complete',
  'trigger_login',
  'trigger_logout',
  'trigger_network_state_changed',
  'trigger_startup',
] as const
export type TriggerKey = (typeof TRIGGER_KEYS)[number]

export const SCRIPT_PRIORITIES = ['Before', 'After'] as const
export const PACKAGE_ACTIONS = ['Install', 'Cache', 'Install Cached'] as const

/** One script attached to the policy, resolved against an existing Jamf Pro script BY NAME. */
export interface PolicyScriptRef {
  name: string
  priority: 'Before' | 'After'
}

/** One package attached to the policy, resolved against an existing Jamf Pro package BY NAME. */
export interface PolicyPackageRef {
  name: string
  action: 'Install' | 'Cache' | 'Install Cached'
}

export type PolicySpec = {
  sectionName: string
  name: string
  enabled: boolean
  frequency: string
  allComputers: boolean
  computerGroupNames: string[]
  exclusionComputerGroupNames: string[]
  scripts: PolicyScriptRef[]
  packages: PolicyPackageRef[]
} & Record<TriggerKey, boolean>

/** The policy's logical identity: its name (case-insensitive, trimmed). Jamf Pro does not enforce unique policy names — see README. */
export function policyKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Index a list of `{id, name}` policy refs by name (case-insensitive; first match wins on a live duplicate). */
export function indexPoliciesByName<T extends { name?: string }>(policies: T[]): Map<string, T> {
  const byName = new Map<string, T>()
  for (const policy of policies) {
    if (!policy.name) continue
    const key = policyKey(policy.name)
    if (!byName.has(key)) byName.set(key, policy)
  }
  return byName
}

/** Read a canvas value that may be a `tags`/`multiselect` array, a single string, or a comma list. */
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

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

/** Try to parse a JSON blob into an array; empty/blank text is an empty (ok) list. */
export function tryParseJsonArray(text: string): { value: unknown[] | null; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: [], ok: true }
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? { value: parsed, ok: true } : { value: null, ok: false }
  } catch {
    return { value: null, ok: false }
  }
}

function coerceScriptRef(raw: unknown): PolicyScriptRef {
  const r = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const priority = r.priority === 'Before' ? 'Before' : 'After'
  return { name, priority }
}

function coercePackageRef(raw: unknown): PolicyPackageRef {
  const r = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  const action = PACKAGE_ACTIONS.includes(r.action as (typeof PACKAGE_ACTIONS)[number])
    ? (r.action as PolicyPackageRef['action'])
    : 'Install'
  return { name, action }
}

/** Each canvas item describes one Jamf Pro policy. */
export function extractPolicySpecs(canvas: CanvasSnapshot): PolicySpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const triggers = new Set(strList(fields.triggers))
    const scriptsParsed = tryParseJsonArray(typeof fields.scripts_json === 'string' ? fields.scripts_json : '')
    const packagesParsed = tryParseJsonArray(typeof fields.packages_json === 'string' ? fields.packages_json : '')

    const triggerFlags = Object.fromEntries(TRIGGER_KEYS.map((k) => [k, triggers.has(k)])) as Record<
      TriggerKey,
      boolean
    >

    return {
      sectionName: section.name,
      name: str(fields.name),
      enabled: readBool(fields.enabled, true),
      frequency: str(fields.frequency) || 'Once per computer',
      allComputers: readBool(fields.all_computers, false),
      computerGroupNames: strList(fields.computer_group_names),
      exclusionComputerGroupNames: strList(fields.exclusion_computer_group_names),
      scripts: (scriptsParsed.value ?? []).map(coerceScriptRef),
      packages: (packagesParsed.value ?? []).map(coercePackageRef),
      ...triggerFlags,
    }
  })
}

// --- Live XML parsing (drift / health check) ----------------------------------

export type LivePolicyGeneral = { name: string; enabled: boolean; frequency: string } & Record<TriggerKey, boolean>

/** Parse a policy's `<general>…</general>` block into the fields this config type manages. */
export function parsePolicyGeneralXml(generalXml: string): LivePolicyGeneral {
  const triggers = Object.fromEntries(
    TRIGGER_KEYS.map((k) => [k, extractText(generalXml, k).toLowerCase() === 'true']),
  ) as Record<TriggerKey, boolean>
  return {
    name: extractText(generalXml, 'name'),
    enabled: extractText(generalXml, 'enabled').toLowerCase() === 'true',
    frequency: extractText(generalXml, 'frequency'),
    ...triggers,
  }
}

export interface LivePolicyScope {
  allComputers: boolean
  groupNames: string[]
  exclusionGroupNames: string[]
}

/** Parse a policy's `<scope>…</scope>` block into the computer-group names this config type manages (by name, not id). */
export function parsePolicyScopeXml(scopeXml: string): LivePolicyScope {
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

/** Parse a policy's `<scripts>…</scripts>` block into the script refs this config type manages. */
export function parsePolicyScriptsXml(scriptsXml: string): PolicyScriptRef[] {
  return extractAll(scriptsXml, 'script').map((el) => ({
    name: extractText(el, 'name'),
    priority: extractText(el, 'priority') === 'Before' ? 'Before' : 'After',
  }))
}

/** Parse a policy's `<package_configuration>…</package_configuration>` block into the package refs this config type manages. */
export function parsePolicyPackagesXml(packageConfigXml: string): PolicyPackageRef[] {
  const packagesBlock = extractElement(packageConfigXml, 'packages')
  if (!packagesBlock) return []
  return extractAll(packagesBlock, 'package').map((el) => {
    const action = extractText(el, 'action')
    return {
      name: extractText(el, 'name'),
      action: PACKAGE_ACTIONS.includes(action as (typeof PACKAGE_ACTIONS)[number])
        ? (action as PolicyPackageRef['action'])
        : 'Install',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate policy configurations: name required + unique (case-insensitive);
 * frequency must be a supported value; `scripts_json`/`packages_json` must be
 * valid JSON array text, each item naming an EXISTING script/package (checked
 * live at deploy time — validate has no guaranteed connectivity, so name
 * resolution failures surface as a deploy error, not a validation error);
 * every script needs a name and a Before/After priority; every package needs
 * a name and a supported action.
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
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Policy name is required', code: 'required' })
    }

    if (!FREQUENCIES.includes(spec.frequency as (typeof FREQUENCIES)[number])) {
      errors.push({
        field: `${prefix}.frequency`,
        message: `Unsupported frequency "${spec.frequency}"`,
        code: 'invalid_frequency',
      })
    }

    const scriptsField = ctx.canvas.sections?.find((s) => s.name === spec.sectionName)?.fields?.scripts_json
    const scriptsParsed = tryParseJsonArray(typeof scriptsField === 'string' ? scriptsField : '')
    if (!scriptsParsed.ok) {
      errors.push({ field: `${prefix}.scripts_json`, message: 'Scripts must be valid JSON array text', code: 'invalid_json' })
    } else {
      spec.scripts.forEach((s, i) => {
        if (!s.name) errors.push({ field: `${prefix}.scripts_json[${i}].name`, message: 'Script name is required', code: 'required' })
      })
    }

    const packagesField = ctx.canvas.sections?.find((s) => s.name === spec.sectionName)?.fields?.packages_json
    const packagesParsed = tryParseJsonArray(typeof packagesField === 'string' ? packagesField : '')
    if (!packagesParsed.ok) {
      errors.push({ field: `${prefix}.packages_json`, message: 'Packages must be valid JSON array text', code: 'invalid_json' })
    } else {
      spec.packages.forEach((p, i) => {
        if (!p.name) errors.push({ field: `${prefix}.packages_json[${i}].name`, message: 'Package name is required', code: 'required' })
      })
    }

    if (spec.name) {
      const key = policyKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate policy "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_policy',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
