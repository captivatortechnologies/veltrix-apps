import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { buildResourceYaml, hasNonEmptySpec, parseResourceHeader } from '../../lib/resourceYaml'

export const CONNECTOR_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
export const CONNECTOR_VERSIONS = new Set(['v3'])
export const KIND = 'github'

export interface GithubConnectorSpec {
  sectionName: string
  name: string
  version: string
  spec: string
}

/** Each canvas item describes one GitHub auth connector. */
export function extractGithubConnectorSpecs(canvas: CanvasSnapshot): GithubConnectorSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const version = typeof fields.version === 'string' && fields.version.trim() ? fields.version.trim() : 'v3'
    const spec = typeof fields.spec === 'string' ? fields.spec.trim() : ''
    return { sectionName: section.name, name, version, spec }
  })
}

/** Build the full GitHub connector resource YAML Teleport's web API expects. */
export function buildGithubConnectorYaml(spec: GithubConnectorSpec): string {
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

  const specs = extractGithubConnectorSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Connector name is required', code: 'required' })
    } else {
      if (!CONNECTOR_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Connector name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate connector "${spec.name}" — each connector name may only be declared once per canvas`,
          code: 'duplicate_connector',
        })
      }
      seenNames.add(spec.name)
    }

    if (!CONNECTOR_VERSIONS.has(spec.version)) {
      errors.push({
        field: `${prefix}.version`,
        message: `Resource version must be one of ${[...CONNECTOR_VERSIONS].join(', ')} (got "${spec.version}")`,
        code: 'invalid_version',
      })
    }

    if (!spec.spec || !hasNonEmptySpec(spec.spec)) {
      errors.push({ field: `${prefix}.spec`, message: 'Connector spec is required', code: 'required' })
    } else {
      const header = parseResourceHeader(spec.spec)
      if (header.kind || header.name) {
        errors.push({
          field: `${prefix}.spec`,
          message:
            'Spec must contain only the connector\'s `spec:` body — do not include a kind/metadata/version ' +
            'envelope, it is added automatically',
          code: 'unexpected_envelope',
        })
      }
      if (!/client_id\s*:/.test(spec.spec)) {
        warnings.push({
          field: `${prefix}.spec`,
          message: 'Spec has no client_id — Teleport will reject this connector on write',
          code: 'missing_client_id',
        })
      }
      if (!/client_secret\s*:/.test(spec.spec)) {
        warnings.push({
          field: `${prefix}.spec`,
          message: 'Spec has no client_secret — Teleport will reject this connector on write',
          code: 'missing_client_secret',
        })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
