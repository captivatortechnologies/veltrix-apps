import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { asObject, ppErrorMessage, type PPClient } from '../../lib/proofpoint'

// --- Proofpoint Essentials organization feature constraints ------------------
//
// An organization exposes a set of security/protection features (URL Defense,
// Attachment Defense, DLP, Encryption, Anti-Spoofing, ...) as a dedicated
// sub-resource: /orgs/{org}/features. They are read via GET and updated via PUT.
// Every managed feature is a boolean. Which features are available depends on the
// org's licensing package — a PUT that enables a feature the package does not
// include is rejected with HTTP 403. See the Essentials Interface API overview
// ("Features": /api/v1/orgs/{domain}/features, GET/PUT) at
// help.proofpoint.com / the Essentials Interface API docs.
//
// The features the API documents as plain booleans. `instant_replay` is
// deliberately excluded: the API documents it as the one non-boolean feature, so
// it cannot be reconciled with a simple on/off toggle.
export const MANAGED_FEATURES = [
  'url_defense',
  'attachment_defense',
  'attachment_defense_sandboxing',
  'anti_spoofing',
  'dlp',
  'email_encryption',
  'email_warning_tags',
  'email_archive',
  'disclaimers',
  'social_media_account_protection',
  'outbound_relaying',
  'smtp_discovery',
  'one_click_remediation',
  'automatic_remediation',
] as const

export type ManagedFeature = (typeof MANAGED_FEATURES)[number]

const MANAGED_FEATURE_SET = new Set<string>(MANAGED_FEATURES)

export interface FeatureSpec {
  sectionName: string
  feature: string
  enabled: boolean
}

/** The feature name (lower-cased) — a feature's identity on the org. */
export function featureKey(feature: string): string {
  return feature.trim().toLowerCase()
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return fallback
}

/** Each canvas item describes one feature toggle. */
export function extractFeatureSpecs(canvas: CanvasSnapshot): FeatureSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      feature: typeof fields.feature === 'string' ? featureKey(fields.feature) : '',
      enabled: readBool(fields.enabled, true),
    }
  })
}

// --- Org features I/O (shared by deploy / rollback / healthCheck / drift) ------

/** Read the org features resource; throws on a non-OK response. */
export async function getFeatures(client: PPClient): Promise<Record<string, unknown>> {
  const res = await client.request('GET', `${client.orgPath}/features`)
  if (!res.ok) throw new Error(`Failed to read organization features: ${ppErrorMessage(res)}`)
  return asObject(res.body, 'features')
}

/**
 * Read one feature's boolean value off a features record. Returns null when the
 * feature is absent (e.g. not part of the org's licensing package).
 */
export function readFeature(features: Record<string, unknown>, feature: string): boolean | null {
  const key = featureKey(feature)
  const match = Object.keys(features).find((k) => k.toLowerCase() === key)
  if (match === undefined) return null
  const value = features[match]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true') return true
    if (v === 'false') return false
  }
  return null
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate feature configurations: the feature name is required and must be one
 * of the managed Essentials features; the enabled flag defaults to true; and each
 * feature (natural key) may be declared only once across the canvas.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractFeatureSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.feature) {
      errors.push({ field: `${prefix}.feature`, message: 'Feature is required', code: 'required' })
    } else if (!MANAGED_FEATURE_SET.has(spec.feature)) {
      errors.push({
        field: `${prefix}.feature`,
        message: `Unsupported feature "${spec.feature}" — choose one of: ${MANAGED_FEATURES.join(', ')}`,
        code: 'invalid_feature',
      })
    }

    if (spec.feature) {
      const key = featureKey(spec.feature)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.feature`,
          message: `Duplicate feature "${spec.feature}" — each feature may only be declared once`,
          code: 'duplicate_feature',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
