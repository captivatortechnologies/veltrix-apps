import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Snyk Infrastructure as Code (IaC) settings — a SINGLETON org setting (REST).
//
// GET/PATCH /orgs/{org_id}/settings/iac (GA since 2021-12-09) configures the
// org's IaC CUSTOM RULES bundle — an OCI-hosted rules artifact Snyk IaC
// evaluates alongside its built-in rules. It is NOT a simple on/off toggle for
// IaC scanning itself (there is no such org-level switch): the managed shape is
// `attributes.custom_rules { is_enabled, inherit_from_parent, oci_registry_url,
// oci_registry_tag }`. `inherit_from_parent` has exactly one accepted value
// ("group") — present to inherit the parent Group's bundle instead of the
// registry below, absent to use the org-level registry. The canvas therefore
// carries exactly one (non-repeatable) item.
// =============================================================================

export interface IacSettingsSpec {
  sectionName: string
  isEnabled: boolean
  inheritFromParent: boolean
  ociRegistryUrl: string
  ociRegistryTag: string
}

/** The live `custom_rules` object as returned by GET (a subset of Snyk's full response). */
export interface LiveIacCustomRules {
  is_enabled?: boolean
  inherit_from_parent?: string
  oci_registry_url?: string
  oci_registry_tag?: string
}

/** Read a checkbox/boolean-ish field, falling back to `fallback` when unset. */
export function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === 'yes' || t === '1') return true
    if (t === 'false' || t === 'no' || t === '0' || t === '') return false
  }
  return fallback
}

/** An IaC settings canvas holds a single item. Extract it (or a disabled default). */
export function extractIacSettings(canvas: CanvasSnapshot): IacSettingsSpec {
  const section = (canvas.sections ?? [])[0]
  const fields = section?.fields ?? {}
  return {
    sectionName: section?.name ?? 'IaC Settings',
    isEnabled: readBool(fields.is_enabled, false),
    inheritFromParent: readBool(fields.inherit_from_parent, false),
    ociRegistryUrl: typeof fields.oci_registry_url === 'string' ? fields.oci_registry_url.trim() : '',
    ociRegistryTag: typeof fields.oci_registry_tag === 'string' ? fields.oci_registry_tag.trim() : '',
  }
}

/**
 * Build the `custom_rules` attributes Snyk expects, given a spec. Declarative:
 * `is_enabled` is always sent; the registry fields are sent only when NOT
 * inheriting from the parent group (Snyk ignores them in that case anyway).
 * Exported so deploy/rollback share one construction path.
 */
export function buildCustomRulesAttributes(spec: {
  isEnabled: boolean
  inheritFromParent: boolean
  ociRegistryUrl: string
  ociRegistryTag: string
}): Record<string, unknown> {
  const attrs: Record<string, unknown> = { is_enabled: spec.isEnabled }
  if (spec.inheritFromParent) {
    attrs.inherit_from_parent = 'group'
  } else {
    if (spec.ociRegistryUrl) attrs.oci_registry_url = spec.ociRegistryUrl
    if (spec.ociRegistryTag) attrs.oci_registry_tag = spec.ociRegistryTag
  }
  return attrs
}

/**
 * Validate IaC settings: exactly one item is expected (it is a singleton org
 * setting). Warns when custom rules are enabled with no registry configured
 * (nothing for Snyk to fetch), and when a registry is set while also
 * inheriting from the parent Group (the registry fields are ignored).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no IaC settings item', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }
  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'IaC settings is a single org-wide setting — declare only one item',
      code: 'singleton_only',
    })
  }

  const spec = extractIacSettings(ctx.canvas)

  if (spec.isEnabled && !spec.inheritFromParent && !spec.ociRegistryUrl) {
    warnings.push({
      field: `${spec.sectionName}.oci_registry_url`,
      message: 'Custom IaC rules are enabled but no OCI registry URL is set and the parent Group is not inherited — Snyk has no bundle to evaluate',
      code: 'iac_custom_rules_incomplete',
    })
  }

  if (spec.inheritFromParent && (spec.ociRegistryUrl || spec.ociRegistryTag)) {
    warnings.push({
      field: `${spec.sectionName}.inherit_from_parent`,
      message: 'Inheriting from the parent Group — the OCI registry URL/tag set here are ignored by Snyk',
      code: 'iac_inherit_ignores_registry',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
