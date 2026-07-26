import type { CanvasSnapshot, DriftDiff, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import type { PanoramaEntry, UpsertSpec } from '../../lib/panorama'

export const RESOURCE_PATH = '/Objects/AntivirusSecurityProfiles'

/** Antivirus / WildFire signature actions available on a decoder. */
export const AV_ACTIONS = ['default', 'allow', 'alert', 'drop', 'reset-client', 'reset-server', 'reset-both'] as const
export type AvAction = (typeof AV_ACTIONS)[number]

/** Protocol decoders present in PAN-OS 10.x/11.x antivirus profiles. */
export const AV_DECODERS = ['ftp', 'http', 'http2', 'imap', 'pop3', 'smb', 'smtp'] as const

export interface AntivirusSpec {
  sectionName: string
  name: string
  description: string
  action: string
  wildfireAction: string
}

interface LiveDecoder {
  '@name'?: string
  action?: string
  'wildfire-action'?: string
}

export interface LiveAntivirus extends PanoramaEntry {
  description?: string
  decoder?: { entry?: LiveDecoder | LiveDecoder[] }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function extractAntivirusSpecs(canvas: CanvasSnapshot): AntivirusSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: str(fields.name),
      description: str(fields.description),
      action: str(fields.action) || 'reset-both',
      wildfireAction: str(fields.wildfire_action) || 'reset-both',
    }
  })
}

/** Build the REST entry fields — the chosen actions applied to every decoder. */
export function buildAntivirusFields(spec: AntivirusSpec): Record<string, unknown> {
  const entry = AV_DECODERS.map((name) => ({ '@name': name, action: spec.action, 'wildfire-action': spec.wildfireAction }))
  const fields: Record<string, unknown> = { decoder: { entry } }
  if (spec.description) fields.description = spec.description
  return fields
}

export function antivirusUpsertSpecs(canvas: CanvasSnapshot): UpsertSpec[] {
  return extractAntivirusSpecs(canvas)
    .filter((s) => s.name && AV_ACTIONS.includes(s.action as AvAction) && AV_ACTIONS.includes(s.wildfireAction as AvAction))
    .map((s) => ({ name: s.name, fields: buildAntivirusFields(s) }))
}

function liveDecoders(entry: PanoramaEntry): LiveDecoder[] {
  const decoder = (entry as LiveAntivirus).decoder?.entry
  if (!decoder) return []
  return Array.isArray(decoder) ? decoder : [decoder]
}

export function antivirusDriftDiffs(spec: AntivirusSpec, entry: PanoramaEntry): DriftDiff[] {
  const diffs: DriftDiff[] = []
  const live = entry as LiveAntivirus
  if (spec.description && str(live.description) !== spec.description) {
    diffs.push({ field: `${spec.name}.description`, expected: spec.description, actual: str(live.description) || 'not set', severity: 'info' })
  }
  const byName = new Map<string, LiveDecoder>()
  for (const d of liveDecoders(entry)) byName.set(str(d['@name']).toLowerCase(), d)
  for (const proto of AV_DECODERS) {
    const d = byName.get(proto)
    const liveAction = str(d?.action)
    const liveWf = str(d?.['wildfire-action'])
    if (liveAction && liveAction !== spec.action) {
      diffs.push({ field: `${spec.name}.${proto}.action`, expected: spec.action, actual: liveAction, severity: 'warning' })
    }
    if (liveWf && liveWf !== spec.wildfireAction) {
      diffs.push({ field: `${spec.name}.${proto}.wildfire-action`, expected: spec.wildfireAction, actual: liveWf, severity: 'warning' })
    }
  }
  return diffs
}

/**
 * Validate antivirus profiles: a name is required and unique across the canvas,
 * and the antivirus and WildFire actions are supported values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()
  for (const spec of extractAntivirusSpecs(ctx.canvas)) {
    const prefix = spec.sectionName
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Antivirus profile name is required', code: 'required' })
    }
    if (!AV_ACTIONS.includes(spec.action as AvAction)) {
      errors.push({ field: `${prefix}.action`, message: `Unsupported action "${spec.action}"`, code: 'invalid_action' })
    }
    if (!AV_ACTIONS.includes(spec.wildfireAction as AvAction)) {
      errors.push({ field: `${prefix}.wildfire_action`, message: `Unsupported WildFire action "${spec.wildfireAction}"`, code: 'invalid_action' })
    }
    if (spec.name) {
      const key = spec.name.toLowerCase()
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate antivirus profile "${spec.name}"`, code: 'duplicate' })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
