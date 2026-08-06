import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// Kandji Library "Custom Profiles" — https://api-docs.iru.com:
//   GET    /api/v1/library/custom-profiles          — list (page param)
//   GET    /api/v1/library/custom-profiles/{id}     — get
//   POST   /api/v1/library/custom-profiles          — create (Body: multipart formdata; `file` is REQUIRED — the
//                                                      raw .mobileconfig bytes, not an embedded JSON string)
//   PATCH  /api/v1/library/custom-profiles/{id}     — update (Body: multipart formdata; same shape, all optional)
//   DELETE /api/v1/library/custom-profiles/{id}     — delete
//
// THE PAYLOAD IS OPAQUE. Kandji's own docs give no further structure for the
// Custom Profile API to interpret beyond "the path to the profile's
// .mobileconfig file" — this config type therefore treats `profile` as a
// verbatim passthrough string, exactly as apps/jamf/config-types/
// macos-configuration-profiles treats its own plist payload field. Getting
// the plist's own internal payload UUIDs/types right is entirely the
// operator's responsibility — a deliberate, flagged scope boundary (see
// README § Coverage), not an oversight.

export interface CustomProfileSpec {
  sectionName: string
  name: string
  active: boolean
  runsOnMac: boolean
  runsOnIphone: boolean
  runsOnIpad: boolean
  runsOnTv: boolean
  profile: string
}

/** Shape of a Kandji Custom Profile Library item, as returned by list/get/create/update. */
export interface LiveCustomProfile {
  id?: string
  name?: string
  active?: boolean
  profile?: string
  mdm_identifier?: string
  runs_on_mac?: boolean
  runs_on_iphone?: boolean
  runs_on_ipad?: boolean
  runs_on_tv?: boolean
}

export function customProfileKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexCustomProfilesByName(items: LiveCustomProfile[]): Map<string, LiveCustomProfile> {
  const byName = new Map<string, LiveCustomProfile>()
  for (const item of items) {
    if (!item.name) continue
    const key = customProfileKey(item.name)
    if (!byName.has(key)) byName.set(key, item)
  }
  return byName
}

export function extractCustomProfileSpecs(canvas: CanvasSnapshot): CustomProfileSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const bool = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback
    return {
      sectionName: section.name,
      name: str(fields.name),
      active: bool(fields.active, true),
      runsOnMac: bool(fields.runs_on_mac, true),
      runsOnIphone: bool(fields.runs_on_iphone, false),
      runsOnIpad: bool(fields.runs_on_ipad, false),
      runsOnTv: bool(fields.runs_on_tv, false),
      profile: typeof fields.profile === 'string' ? fields.profile : '',
    }
  })
}

/**
 * Build the multipart/form-data body POST/PATCH /api/v1/library/custom-profiles
 * accepts for a spec. The plist text authored in the canvas becomes the
 * `file` part's content — Kandji's API takes the profile as an uploaded
 * file, never as an embedded JSON string (see the file header).
 */
export function buildCustomProfileForm(spec: CustomProfileSpec): FormData {
  const form = new FormData()
  form.append('name', spec.name)
  form.append('active', String(spec.active))
  form.append('runs_on_mac', String(spec.runsOnMac))
  form.append('runs_on_iphone', String(spec.runsOnIphone))
  form.append('runs_on_ipad', String(spec.runsOnIpad))
  form.append('runs_on_tv', String(spec.runsOnTv))
  form.append(
    'file',
    new Blob([spec.profile], { type: 'application/x-apple-aspen-config' }),
    `${spec.name || 'profile'}.mobileconfig`,
  )
  return form
}

/**
 * Validate Custom Profile configurations: name and a non-empty payload are
 * required (Kandji itself would reject a profile whose payload doesn't parse
 * as a plist — that surfaces as a deploy-time error, not here); at least one
 * target platform must be enabled; names unique across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractCustomProfileSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Custom Profile name is required', code: 'required' })
    }
    if (!spec.profile) {
      errors.push({ field: `${prefix}.profile`, message: 'A .mobileconfig plist payload is required', code: 'required' })
    } else if (!/<plist[\s>]/.test(spec.profile)) {
      warnings.push({
        field: `${prefix}.profile`,
        message: 'Payload does not look like a plist (no <plist> element found) — Kandji will reject it at deploy time if malformed',
        code: 'payload_shape',
      })
    }
    if (!spec.runsOnMac && !spec.runsOnIphone && !spec.runsOnIpad && !spec.runsOnTv) {
      errors.push({
        field: `${prefix}.runs_on_mac`,
        message: 'At least one target platform (macOS, iPhone, iPad or Apple TV) must be enabled',
        code: 'no_target_platform',
      })
    }

    if (spec.name) {
      const key = customProfileKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate Custom Profile "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_custom_profile',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
