import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listCaseTemplates } from '../../lib/thehiveApi'
import {
  buildCaseTemplateBody,
  findCaseTemplate,
  templatesFromList,
  toBoundedInt,
  parseTags,
  SEVERITY_MIN,
  SEVERITY_MAX,
  TLP_MIN,
  TLP_MAX,
  PAP_MIN,
  PAP_MAX,
  type CaseTemplate,
} from './_shared'

/**
 * Drift for case templates: compare the declared severity / TLP / PAP / tags
 * against the live template in TheHive. Best-effort — a template that can't be
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

  let live: CaseTemplate[]
  try {
    live = templatesFromList(await listCaseTemplates<CaseTemplate>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read templates, no drift asserted
  }

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue
    const match = findCaseTemplate(live, name)
    if (!match) continue

    const desired = buildCaseTemplateBody(item.fields)

    const expectedSeverity = desired.severity
    const actualSeverity = toBoundedInt(match.severity, SEVERITY_MIN, SEVERITY_MAX, expectedSeverity ?? 2)
    if (expectedSeverity !== actualSeverity) {
      diffs.push({ field: `${name}.severity`, expected: expectedSeverity, actual: actualSeverity, severity: 'warning' })
    }

    const expectedTlp = desired.tlp
    const actualTlp = toBoundedInt(match.tlp, TLP_MIN, TLP_MAX, expectedTlp ?? 2)
    if (expectedTlp !== actualTlp) {
      diffs.push({ field: `${name}.tlp`, expected: expectedTlp, actual: actualTlp, severity: 'warning' })
    }

    const expectedPap = desired.pap
    const actualPap = toBoundedInt(match.pap, PAP_MIN, PAP_MAX, expectedPap ?? 2)
    if (expectedPap !== actualPap) {
      diffs.push({ field: `${name}.pap`, expected: expectedPap, actual: actualPap, severity: 'warning' })
    }

    const expectedTags = (desired.tags ?? []).slice().sort()
    const actualTags = parseTags((match.tags ?? []).join('\n')).sort()
    if (expectedTags.join(',') !== actualTags.join(',')) {
      diffs.push({ field: `${name}.tags`, expected: expectedTags.join(', '), actual: actualTags.join(', '), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
