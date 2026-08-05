import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, decodeXmlEntities } from '../../lib/qualys'
import { attachDriftActor, veltrixActorLogins } from '../lib/qualysActivityLog'
import { listReportTemplates, reportTemplatePath, wrapReportTemplateXml } from './deploy'
import { extractReportTemplateSpecs, type LiveReportTemplate } from './validate'

const INFO_TAG_PATTERN = /<INFO\s+key="([^"]+)">([\s\S]*?)<\/INFO>/g

/** Every `<INFO key="…">value</INFO>` pair in a template document, CDATA-unwrapped. */
function parseInfoMap(xml: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const match of xml.matchAll(INFO_TAG_PATTERN)) {
    const cdata = match[2].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
    map.set(match[1], cdata ? cdata[1] : decodeXmlEntities(match[2]).trim())
  }
  return map
}

/**
 * Detect drift between the deployed report template and the live platform.
 * Re-finds each declared template by (type, title) via the shared metadata
 * list; a missing template is critical drift. For a found template, the live
 * settings are read back via Export and compared field-by-field (`INFO key`)
 * against what this app declared — only keys THIS app declares are compared,
 * so Qualys-filled defaults for undeclared settings never appear as noise.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractReportTemplateSpecs(ctx.deployedConfig).filter((s) => s.templateType && s.title)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  const excludeActorLogins = veltrixActorLogins(ctx.credential)

  try {
    const byType = new Map<string, Map<string, LiveReportTemplate>>()
    for (const templateType of new Set(specs.map((s) => s.templateType))) {
      const live = await listReportTemplates(client, templateType)
      byType.set(templateType, new Map(live.map((t) => [t.title.trim().toLowerCase(), t])))
    }

    for (const spec of specs) {
      const label = `${spec.templateType}:${spec.title}`
      const before = diffs.length
      const found = byType.get(spec.templateType)?.get(spec.title.trim().toLowerCase())
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        await attachDriftActor(client, diffs.slice(before), { targetName: spec.title, excludeActorLogins })
        continue
      }

      const res = await client.get(reportTemplatePath(spec.templateType), {
        action: 'export',
        report_format: 'xml',
        template_id: found.id,
      })
      if (res.ok) {
        const liveInfo = parseInfoMap(res.body)
        const expectedInfo = parseInfoMap(wrapReportTemplateXml(spec))
        for (const [key, expectedValue] of expectedInfo) {
          const liveValue = liveInfo.get(key) ?? ''
          if (liveValue !== expectedValue) {
            diffs.push({
              field: `${label}.${key}`,
              expected: expectedValue || 'not set',
              actual: liveValue || 'not set',
              severity: key === 'title' ? 'warning' : 'info',
            })
          }
        }
      }

      await attachDriftActor(client, diffs.slice(before), {
        targetId: found.id,
        targetName: spec.title,
        excludeActorLogins,
      })
    }
  } catch (error) {
    diffs.push({
      field: 'qualys',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
