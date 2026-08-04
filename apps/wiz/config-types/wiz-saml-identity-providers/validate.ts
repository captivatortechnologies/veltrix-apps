import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface GroupMappingEntry {
  providerGroupId: string
  role: string
  projects: string[]
}

export interface SamlIdpSpec {
  sectionName: string
  name: string
  loginUrl: string
  issuerUrl: string
  logoutUrl: string
  certificate: string
  useProviderManagedRoles: boolean
  allowManualRoleOverride: boolean
  mergeGroupsMappingByRole: boolean
  domains: string[]
  /** Raw group-mapping JSON as typed by the user (validated separately). */
  groupMappingText: string
  /** Parsed + normalized group mapping — undefined when blank or malformed. */
  groupMapping: GroupMappingEntry[] | undefined
}

/** A provider as returned by the `samlIdentityProviders` list query. */
export interface LiveSamlIdp {
  id?: string
  name?: string
}

/** A provider as returned by the single-provider read query (full managed state). */
export interface FullSamlIdp {
  id?: string
  name?: string
  issuerURL?: string
  loginURL?: string
  logoutURL?: string
  useProviderManagedRoles?: boolean | null
  allowManualRoleOverride?: boolean | null
  certificate?: string
  domains?: string[]
  mergeGroupsMappingByRole?: boolean | null
  /** `role` reads back as a nested `{ id }` object even though create/update accept it as a plain role string/id. */
  groupMapping?: Array<{ providerGroupId?: string; role?: { id?: string }; projects?: Array<{ id?: string }> }>
}

/** The provider's logical identity: its name (case-insensitive, trimmed). */
export function idpKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Parse a checkbox/boolean-ish canvas value, falling back when absent. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
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

/** Try to parse JSON text; empty text is treated as absent (ok, undefined value). */
export function tryParseJson(text: string): { value: unknown; ok: boolean } {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return { value: undefined, ok: true }
  try {
    return { value: JSON.parse(trimmed), ok: true }
  } catch {
    return { value: undefined, ok: false }
  }
}

/** Normalize parsed group-mapping JSON into a typed array, or undefined when malformed. */
export function normalizeGroupMapping(value: unknown): GroupMappingEntry[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const entries: GroupMappingEntry[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const entry = raw as Record<string, unknown>
    const providerGroupId = typeof entry.providerGroupId === 'string' ? entry.providerGroupId.trim() : ''
    const role = typeof entry.role === 'string' ? entry.role.trim() : ''
    const projects = Array.isArray(entry.projects)
      ? entry.projects.map((p) => String(p).trim()).filter((p) => p !== '')
      : []
    entries.push({ providerGroupId, role, projects })
  }
  return entries
}

/** Each canvas item describes one Wiz SAML identity provider. */
export function extractSamlIdpSpecs(canvas: CanvasSnapshot): SamlIdpSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const groupMappingText = str(fields.group_mapping)
    const parsed = tryParseJson(groupMappingText)
    return {
      sectionName: section.name,
      name: str(fields.name),
      loginUrl: str(fields.login_url),
      issuerUrl: str(fields.issuer_url),
      logoutUrl: str(fields.logout_url),
      certificate: typeof fields.certificate === 'string' ? fields.certificate.trim() : '',
      useProviderManagedRoles: readBool(fields.use_provider_managed_roles, false),
      allowManualRoleOverride: readBool(fields.allow_manual_role_override, true),
      mergeGroupsMappingByRole: readBool(fields.merge_groups_mapping_by_role, false),
      domains: strList(fields.domains),
      groupMappingText,
      groupMapping: parsed.ok ? normalizeGroupMapping(parsed.value) : undefined,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate Wiz SAML identity provider configurations: name, login URL and
 * certificate are required; name is unique across the canvas
 * (case-insensitive); group mapping (when present) must be a JSON array of
 * {providerGroupId, role[, projects]} objects; and Allow Manual Role Override
 * must be enabled whenever Provider-Managed Roles is disabled (Wiz would
 * otherwise have no way to assign a role to a user).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractSamlIdpSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Provider name is required', code: 'required' })
    }
    if (!spec.loginUrl) {
      errors.push({ field: `${prefix}.login_url`, message: 'A login URL is required', code: 'required' })
    }
    if (!spec.certificate) {
      errors.push({ field: `${prefix}.certificate`, message: 'A signing certificate is required', code: 'required' })
    }

    if (spec.groupMapping === undefined) {
      errors.push({
        field: `${prefix}.group_mapping`,
        message: 'Group mapping must be a JSON array of {"providerGroupId","role"} objects',
        code: 'invalid_json',
      })
    } else {
      spec.groupMapping.forEach((entry, i) => {
        if (!entry.providerGroupId) {
          errors.push({ field: `${prefix}.group_mapping[${i}].providerGroupId`, message: 'Each mapping needs a provider group id', code: 'required' })
        }
        if (!entry.role) {
          errors.push({ field: `${prefix}.group_mapping[${i}].role`, message: 'Each mapping needs a Wiz role', code: 'required' })
        }
      })
    }

    if (!spec.useProviderManagedRoles && !spec.allowManualRoleOverride) {
      errors.push({
        field: `${prefix}.allow_manual_role_override`,
        message: 'Allow Manual Role Override must be enabled when Provider-Managed Roles is disabled',
        code: 'invalid_role_config',
      })
    }

    if (spec.name) {
      const key = idpKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate provider "${spec.name}" — each name may only be declared once`,
          code: 'duplicate_provider',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
