import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listCustomFields } from '../../lib/thehiveApi'
import {
  buildCustomFieldBody,
  customFieldsFromList,
  findCustomField,
  normalizeType,
  parseBool,
  parseOptions,
  type CustomField,
} from './_shared'

/**
 * Drift for custom fields: compare the declared type / group / mandatory /
 * options against the live field in TheHive. Best-effort — a field that can't be
 * matched (missing / transient error) is skipped rather than raising false drift.
 * Read-only. Verify against a live TheHive (see README, v4 vs v5).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: CustomField[]
  try {
    live = customFieldsFromList(await listCustomFields<CustomField>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read fields, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findCustomField(live, name)
    if (!match) continue

    const desired = buildCustomFieldBody(item.fields)

    const actualType = normalizeType(match.type)
    if (desired.type !== actualType) {
      diffs.push({ field: `${name}.type`, expected: desired.type, actual: actualType, severity: 'warning' })
    }

    const actualGroup = String(match.group ?? '').trim() || 'default'
    if (desired.group !== actualGroup) {
      diffs.push({ field: `${name}.group`, expected: desired.group, actual: actualGroup, severity: 'info' })
    }

    const actualMandatory = parseBool(match.mandatory)
    if (desired.mandatory !== actualMandatory) {
      diffs.push({ field: `${name}.mandatory`, expected: desired.mandatory, actual: actualMandatory, severity: 'warning' })
    }

    const expectedOptions = parseOptions((desired.options ?? []).join('\n')).sort()
    const actualOptions = parseOptions((Array.isArray(match.options) ? match.options : []).join('\n')).sort()
    if (expectedOptions.join(',') !== actualOptions.join(',')) {
      diffs.push({ field: `${name}.options`, expected: expectedOptions.join(', '), actual: actualOptions.join(', '), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
