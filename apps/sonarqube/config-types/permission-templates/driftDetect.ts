import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildSonarqubeUrl, buildAuthHeader, getJson } from '../../lib/sonarqubeApi'
import {
  templatesFromSearch,
  findTemplate,
  parseGroupPermissions,
  groupPermsFromTemplateGroups,
  reconcileGroupPerms,
} from './_shared'

/**
 * Drift for permission templates: compare presence, description, project-key pattern and
 * the declared groups' grants against the live template. Best-effort — a template or
 * reading that can't be resolved is skipped rather than raising false drift. Read-only:
 *   GET /api/permissions/search_templates?q=..  → live template (description, pattern, id)
 *   GET /api/permissions/template_groups        → live group grants (declared groups only)
 * Verify against your SonarQube version.
 */
const enc = encodeURIComponent

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildSonarqubeUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  for (const item of items) {
    const name = String(item.fields.name ?? '').trim()
    if (!name) continue

    let match
    try {
      match = findTemplate(templatesFromSearch(await getJson<unknown>(`${base}/api/permissions/search_templates?q=${enc(name)}`, headers)), name)
    } catch {
      continue // can't read templates — skip rather than assert drift
    }
    if (!match) {
      diffs.push({ field: name, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const description = String(item.fields.description ?? '').trim()
    if (description && String(match.description ?? '') !== description) {
      diffs.push({ field: `${name}.description`, expected: description, actual: String(match.description ?? ''), severity: 'warning' })
    }

    const projectKeyPattern = String(item.fields.projectKeyPattern ?? '').trim()
    if (projectKeyPattern && String(match.projectKeyPattern ?? '') !== projectKeyPattern) {
      diffs.push({ field: `${name}.projectKeyPattern`, expected: projectKeyPattern, actual: String(match.projectKeyPattern ?? '(none)'), severity: 'warning' })
    }

    const { grants } = parseGroupPermissions(item.fields.groupPermissions)
    if (grants.length > 0) {
      let live
      try {
        live = groupPermsFromTemplateGroups(await getJson<unknown>(`${base}/api/permissions/template_groups?templateName=${enc(name)}&ps=100`, headers))
      } catch {
        continue // can't read group grants — skip rather than assert drift
      }
      const { toAdd, toRemove } = reconcileGroupPerms(grants, live)
      for (const { group, permission } of toAdd) {
        diffs.push({ field: `${name}.group:${group}`, expected: `${permission} granted`, actual: 'not granted', severity: 'warning' })
      }
      for (const { group, permission } of toRemove) {
        diffs.push({ field: `${name}.group:${group}`, expected: `${permission} not granted`, actual: 'granted', severity: 'warning' })
      }
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
