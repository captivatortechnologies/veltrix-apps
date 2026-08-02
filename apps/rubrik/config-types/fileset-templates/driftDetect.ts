import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { rubrikConnect, getJson, resolveServiceAccount } from '../../lib/rubrikApi'
import {
  buildFilesetTemplateBody,
  filesetTemplatesFromList,
  findTemplateByName,
  normalizeName,
  summarizeTemplate,
  type RubrikFilesetTemplate,
} from './_shared'

/**
 * Drift for Fileset Templates: compare the OS type, include/exclude/exception path
 * sets and the network-mounts flag we declare against the live template in Rubrik.
 * Best-effort — a template that can't be matched (missing / transient error) is
 * skipped rather than raising false drift. Read-only: GET /api/v1/fileset_template.
 * FLAG: verify against a live Rubrik CDM.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, canvas, settings } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!resolveServiceAccount(credential)) return { hasDrift: false, diffs }

  let conn
  try {
    conn = await rubrikConnect(component, credential, settings)
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't connect, no drift asserted
  }

  let live
  try {
    live = filesetTemplatesFromList(await getJson<unknown>(conn, '/api/v1/fileset_template'))
  } catch {
    return { hasDrift: false, diffs }
  }

  const FIELD_SEVERITY: Record<string, DriftDiff['severity']> = {
    os: 'critical',
    includes: 'warning',
    excludes: 'warning',
    exceptions: 'info',
    networkMounts: 'info',
  }

  for (const item of items) {
    const name = normalizeName(item.fields.name)
    const match = findTemplateByName(live, name)
    if (!match) continue

    // Re-derive the expected template from the canvas so the comparison uses the
    // exact same normalization (sorted path sets, coerced flags) as a deploy.
    const expected = summarizeTemplate(buildFilesetTemplateBody(item.fields) as RubrikFilesetTemplate)
    const actual = summarizeTemplate(match)

    for (const key of Object.keys(FIELD_SEVERITY)) {
      const e = expected[key] ?? ''
      const a = actual[key] ?? ''
      if (e !== a) {
        diffs.push({ field: `${name}.${key}`, expected: e || '(empty)', actual: a || '(empty)', severity: FIELD_SEVERITY[key] })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
