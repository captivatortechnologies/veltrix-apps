import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const CONFIG_NAME_PATTERN = /^[A-Za-z0-9._-]+$/

export interface DiscoveryConfigSpec {
  sectionName: string
  name: string
  discoveryGroup: string
  awsMatchersJson: string
  azureMatchersJson: string
  gcpMatchersJson: string
  kubeMatchersJson: string
}

/** Each canvas item describes one DiscoveryConfig. */
export function extractDiscoveryConfigSpecs(canvas: CanvasSnapshot): DiscoveryConfigSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (key: string) => (typeof fields[key] === 'string' ? (fields[key] as string).trim() : '')
    return {
      sectionName: section.name,
      name: str('name'),
      discoveryGroup: str('discoveryGroup'),
      awsMatchersJson: str('awsMatchersJson'),
      azureMatchersJson: str('azureMatchersJson'),
      gcpMatchersJson: str('gcpMatchersJson'),
      kubeMatchersJson: str('kubeMatchersJson'),
    }
  })
}

export type MatcherParseResult = { ok: true; value: unknown[] } | { ok: false; reason: string }

/** Parse a matcher JSON textarea: blank -> empty array; otherwise must be a JSON array. */
export function parseMatcherJson(raw: string): MatcherParseResult {
  if (!raw.trim()) return { ok: true, value: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${error instanceof Error ? error.message : 'parse error'}` }
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, reason: 'must be a JSON array' }
  }
  return { ok: true, value: parsed }
}

const MATCHER_FIELDS: Array<{ key: keyof DiscoveryConfigSpec; label: string }> = [
  { key: 'awsMatchersJson', label: 'AWS Matchers' },
  { key: 'azureMatchersJson', label: 'Azure Matchers' },
  { key: 'gcpMatchersJson', label: 'GCP Matchers' },
  { key: 'kubeMatchersJson', label: 'Kubernetes Matchers' },
]

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDiscoveryConfigSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (!CONFIG_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate discovery config "${spec.name}" — each name may only be declared once per canvas`,
          code: 'duplicate_config',
        })
      }
      seenNames.add(spec.name)
    }

    if (!spec.discoveryGroup) {
      errors.push({ field: `${prefix}.discoveryGroup`, message: 'Discovery group is required', code: 'required' })
    }

    let anyMatchers = false
    for (const { key, label } of MATCHER_FIELDS) {
      const raw = spec[key] as string
      const parsed = parseMatcherJson(raw)
      if (!parsed.ok) {
        errors.push({ field: `${prefix}.${key}`, message: `${label} ${parsed.reason}`, code: 'invalid_matchers_json' })
      } else if (parsed.value.length > 0) {
        anyMatchers = true
      }
    }
    if (!anyMatchers) {
      errors.push({
        field: `${prefix}.awsMatchersJson`,
        message: 'At least one matcher (AWS, Azure, GCP, or Kubernetes) is required',
        code: 'no_matchers',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
