import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildThehiveUrl, buildAuthHeader, listPageTemplates, isPageTemplateSupported } from '../../lib/thehiveApi'
import { buildPageTemplateUpdateBody, findPageTemplate, pageTemplatesFromList, type PageTemplate } from './_shared'

/**
 * Drift for page templates: compare the declared content / category / order
 * against the live template in TheHive. V5-only — on a non-v5 target this
 * reports no drift (best-effort, same posture as an unreadable target) rather
 * than calling a path that doesn't exist. Read-only. See README.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  if (!isPageTemplateSupported()) return { hasDrift: false, diffs: [] }

  const { component, credential, connectivity, connectivityProvider, canvas } = ctx
  const items = canvas.items ?? canvas.sections ?? []
  const diffs: DriftDiff[] = []

  if (!credential) return { hasDrift: false, diffs }

  const base = buildThehiveUrl(component, connectivity, connectivityProvider)
  const headers = buildAuthHeader(credential)

  let live: PageTemplate[]
  try {
    live = pageTemplatesFromList(await listPageTemplates<PageTemplate>(base, headers))
  } catch {
    return { hasDrift: false, diffs } // best-effort: can't read templates, no drift asserted
  }

  for (const item of items) {
    const title = String(item.fields.title ?? '').trim()
    if (!title) continue
    const match = findPageTemplate(live, title)
    if (!match) {
      diffs.push({ field: title, expected: 'present', actual: 'missing', severity: 'warning' })
      continue
    }

    const desired = buildPageTemplateUpdateBody(item.fields)

    const actualContent = String(match.content ?? '')
    if (desired.content !== actualContent) {
      diffs.push({ field: `${title}.content`, expected: desired.content, actual: actualContent, severity: 'info' })
    }
    const actualCategory = String(match.category ?? '')
    if (desired.category !== actualCategory) {
      diffs.push({ field: `${title}.category`, expected: desired.category, actual: actualCategory, severity: 'info' })
    }
    const actualOrder = Number(match.order ?? 0)
    if (desired.order !== actualOrder) {
      diffs.push({ field: `${title}.order`, expected: String(desired.order), actual: String(actualOrder), severity: 'info' })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
