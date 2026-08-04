import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { extractElement, extractText, tag } from '../../lib/jamfClassicXml'

// =============================================================================
// Jamf Pro Static Computer Groups — Classic API (XML).
//
// Static groups share the same Classic endpoint as smart groups
// (https://developer.jamf.com/jamf-pro/reference/findcomputergroups /
// .../findcomputergroupsbyid / .../createcomputergroupbyid /
// .../updatecomputergroupbyid / .../deletecomputergroupbyid,
// /JSSResource/computergroups) but with `is_smart=false` and an explicit
// `<computers>` membership list instead of `<criteria>`. The modern Jamf Pro
// API v2 mirror (`GET /api/v2/computer-groups/static-groups`) is READ-ONLY
// (confirmed via developer.jamf.com), so this config type manages the object
// through the Classic API, same as Smart Computer Groups.
//
// Membership is declared by SERIAL NUMBER — a physical Mac's serial number
// is stable and human-readable off the device/shipping manifest, unlike the
// Jamf-internal numeric computer id (opaque, unknowable ahead of time) or the
// inventory "Computer Name" (can be renamed/duplicated more easily). Each
// serial is resolved to a live computer id via the Classic API's
// `GET /computers/serialnumber/{serialnumber}` — DEPRECATED as of 2025-02-11
// in favor of `GET /api/v3/computers-inventory`, but still functional; flagged
// here and in the README rather than silently relied upon.
// =============================================================================

export interface StaticGroupSpec {
  sectionName: string
  name: string
  memberSerialNumbers: string[]
}

/** A resolved static-group member — the fields this app sends on create/update. */
export interface StaticGroupMember {
  id: string
  name: string
  serialNumber: string
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

export function extractStaticGroupSpecs(canvas: CanvasSnapshot): StaticGroupSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    return {
      sectionName: section.name,
      name: str(fields.name),
      memberSerialNumbers: strList(fields.member_serial_numbers),
    }
  })
}

// --- Classic XML build/parse ---------------------------------------------------

export function buildMemberXml(member: StaticGroupMember): string {
  return `<computer>${tag('id', member.id)}${tag('name', member.name)}${tag('serial_number', member.serialNumber)}</computer>`
}

/** Build a full `<computer_group>` document for create/update. Omits `<site>` — same documented limitation as Smart Computer Groups (see README). */
export function buildStaticGroupXml(spec: { name: string }, members: StaticGroupMember[]): string {
  const membersXml = members.map(buildMemberXml).join('')
  return `<computer_group>${tag('name', spec.name)}${tag('is_smart', false)}<computers>${membersXml}</computers></computer_group>`
}

/**
 * Parse a single `<computer>` response from the Classic `computers` resource
 * (e.g. `GET /computers/serialnumber/{sn}`) into id/name/serial_number. The
 * full computer record nests general fields under `<general>` (mirroring
 * every other Classic resource this app reads) — this defensively checks for
 * that wrapper first and falls back to the root, since the exact nesting for
 * this specific deprecated endpoint was not conclusively shown in the docs
 * fetched for this app (flagged, not assumed).
 */
export function parseComputerLookupXml(xml: string): { id: string; name: string; serialNumber: string } {
  const scope = extractElement(xml, 'general') ?? xml
  return {
    id: extractText(scope, 'id'),
    name: extractText(scope, 'name'),
    serialNumber: extractText(scope, 'serial_number'),
  }
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate static computer group configurations: a name is required and
 * unique across the canvas (case-insensitive). An empty member list is a
 * valid declared state (an intentionally empty static group).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractStaticGroupSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Static group name is required', code: 'required' })
    }

    const dupeSerials = spec.memberSerialNumbers.filter((s, i, arr) => arr.findIndex((o) => o.toLowerCase() === s.toLowerCase()) !== i)
    if (dupeSerials.length > 0) {
      errors.push({
        field: `${prefix}.member_serial_numbers`,
        message: `Duplicate serial number(s) declared: ${[...new Set(dupeSerials)].join(', ')}`,
        code: 'duplicate_member',
      })
    }

    if (spec.name) {
      const key = spec.name.trim().toLowerCase()
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate static group "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_group',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
