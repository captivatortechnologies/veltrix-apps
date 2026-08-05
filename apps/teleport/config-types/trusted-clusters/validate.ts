import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildResourceYaml, hasNonEmptySpec, parseResourceHeader } from '../../lib/resourceYaml'

export const CLUSTER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
export const CLUSTER_VERSIONS = new Set(['v2'])
export const KIND = 'trusted_cluster'

export interface TrustedClusterSpec {
  sectionName: string
  name: string
  version: string
  spec: string
}

/** Each canvas item describes one trusted cluster relationship. */
export function extractTrustedClusterSpecs(canvas: CanvasSnapshot): TrustedClusterSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const version = typeof fields.version === 'string' && fields.version.trim() ? fields.version.trim() : 'v2'
    const spec = typeof fields.spec === 'string' ? fields.spec.trim() : ''
    return { sectionName: section.name, name, version, spec }
  })
}

/** Build the full trusted_cluster resource YAML Teleport's web API expects. */
export function buildTrustedClusterYaml(spec: TrustedClusterSpec): string {
  return buildResourceYaml(KIND, spec.version, spec.name, spec.spec)
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractTrustedClusterSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Trusted cluster name is required', code: 'required' })
    } else {
      if (!CLUSTER_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Trusted cluster name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate trusted cluster "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_cluster',
        })
      }
      seenNames.add(spec.name)
    }

    if (!CLUSTER_VERSIONS.has(spec.version)) {
      errors.push({
        field: `${prefix}.version`,
        message: `Resource version must be one of ${[...CLUSTER_VERSIONS].join(', ')} (got "${spec.version}")`,
        code: 'invalid_version',
      })
    }

    if (!spec.spec || !hasNonEmptySpec(spec.spec)) {
      errors.push({ field: `${prefix}.spec`, message: 'Trusted cluster spec is required', code: 'required' })
    } else {
      const header = parseResourceHeader(spec.spec)
      if (header.kind || header.name) {
        errors.push({
          field: `${prefix}.spec`,
          message:
            'Spec must contain only the trusted cluster\'s `spec:` body — do not include a ' +
            'kind/metadata/version envelope, it is added automatically',
          code: 'unexpected_envelope',
        })
      }
      if (!/token\s*:/.test(spec.spec)) {
        warnings.push({
          field: `${prefix}.spec`,
          message: 'Spec has no token — Teleport requires the leaf cluster\'s join token to establish trust',
          code: 'missing_token',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
