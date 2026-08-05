import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildQualysClient, qualysErrorMessage, xmlBlocks, xmlText, type QualysClient, type QualysResponse } from '../../lib/qualys'
import {
  extractReportTemplateSpecs,
  reportTemplateKey,
  reportTemplateTypeMeta,
  type LiveReportTemplate,
  type ReportTemplateSpec,
} from './validate'

/** The shared metadata list — the ONLY place a report template's id is exposed (Export never includes it). */
export const REPORT_TEMPLATE_LIST_PATH = '/msp/report_template_list.php'

/** The per-type create/update/delete/export endpoint. */
export function reportTemplatePath(templateType: string): string {
  const meta = reportTemplateTypeMeta(templateType)
  return `/api/2.0/fo/report/template/${meta?.path ?? templateType}/`
}

export interface ReportTemplateRollbackEntry {
  key: string
  label: string
  templateType: string
  existed: boolean
  id?: string
  prior?: LiveReportTemplate
}

/**
 * Deploy Qualys VM report templates via the classic v2 API.
 *
 * UNLIKE every other config type in this app, Create/Update send the template
 * as a literal XML DOCUMENT body (`Content-Type: text/xml`), not form-encoded
 * parameters — and Update uses HTTP PUT, not POST. This app treats the
 * settings as an opaque, user-authored XML fragment (typically produced by
 * exporting an existing template through the Qualys UI/API and pasting it in)
 * and only injects the TITLE section itself, so no attempt is made to
 * interpret/reconstruct the many nested settings sections (TARGET, DISPLAY,
 * FILTER, …) — the exact same shape Export returns is exactly what Create/
 * Update expect, so passing it through verbatim round-trips safely.
 *
 * Identity is the (template type, title) natural key. Because Export never
 * includes a template's own id, reconciliation instead uses the separate
 * `/msp/report_template_list.php` metadata list (id + title + type only).
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildQualysClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, platformUrl } = built

  const specs = extractReportTemplateSpecs(ctx.canvas).filter((s) => s.templateType && s.title)
  const rollbackState: ReportTemplateRollbackEntry[] = []
  const deployed: string[] = []

  try {
    const byType = new Map<string, Map<string, LiveReportTemplate>>()
    for (const templateType of new Set(specs.map((s) => s.templateType))) {
      const live = await listReportTemplates(client, templateType)
      byType.set(templateType, new Map(live.map((t) => [t.title.trim().toLowerCase(), t])))
    }

    for (const spec of specs) {
      const label = `${spec.templateType}:${spec.title}`
      const key = reportTemplateKey(spec)
      const live = byType.get(spec.templateType)?.get(spec.title.trim().toLowerCase())
      const path = reportTemplatePath(spec.templateType)
      const xml = wrapReportTemplateXml(spec)

      if (live) {
        rollbackState.push({ key, label, templateType: spec.templateType, existed: true, id: live.id, prior: live })
        const res = await client.sendXmlBody('PUT', path, { action: 'update', template_id: live.id, report_format: 'xml' }, xml)
        const failed = reportTemplateWriteError(res)
        if (failed) throw new Error(`Failed to update ${label} report template: ${failed}`)
      } else {
        const res = await client.sendXmlBody('POST', path, { action: 'create', report_format: 'xml' }, xml)
        const failed = reportTemplateWriteError(res)
        if (failed) throw new Error(`Failed to create ${label} report template: ${failed}`)
        const newId = reportTemplateReturnId(res.body)
        if (!newId) throw new Error(`${label} report template was created but the API returned no id`)
        rollbackState.push({ key, label, templateType: spec.templateType, existed: false, id: newId })
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} report template(s) to ${platformUrl}: ${deployed.join(', ')}`,
      artifacts: { platformUrl, deployedReportTemplates: deployed },
      rollbackData: { previousState: rollbackState },
    }
  } catch (error) {
    return {
      success: false,
      message: `Report template deployment failed after ${deployed.length} of ${specs.length}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { platformUrl, deployedReportTemplates: deployed },
      rollbackData: { previousState: rollbackState },
    }
  }
}

// --- Helpers ---

/**
 * List every report template's (id, title) for one template type from the
 * shared metadata list, filtered locally by `<TEMPLATE_TYPE>`. This endpoint is
 * not documented as paginated (unlike the `/api/2.0/fo/...` family), so this
 * issues a single request.
 */
export async function listReportTemplates(client: QualysClient, templateType: string): Promise<LiveReportTemplate[]> {
  const meta = reportTemplateTypeMeta(templateType)
  const res = await client.get(REPORT_TEMPLATE_LIST_PATH, {})
  if (!res.ok) {
    throw new Error(`Failed to list ${templateType} report templates: ${qualysErrorMessage({ status: res.status, ok: false, body: res.body })}`)
  }
  const wantType = (meta?.listTemplateType ?? templateType).toLowerCase()
  return xmlBlocks(res.body, 'REPORT_TEMPLATE')
    .filter((block) => xmlText(block, 'TEMPLATE_TYPE').toLowerCase() === wantType)
    .map((block) => ({ id: xmlText(block, 'ID'), title: xmlText(block, 'TITLE') }))
    .filter((t) => t.id && t.title)
}

/** Escape `]]>` so a value can be safely wrapped in a CDATA section. */
export function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
}

/**
 * Build the full `<REPORTTEMPLATE><wrapperTag>…</wrapperTag></REPORTTEMPLATE>`
 * document Create/Update expect. Only the TITLE section (title + owner) is
 * generated by this app; `settingsXml` — every other section (TARGET, DISPLAY,
 * FILTER, SERVICESPORTS, USERACCESS, …) — is passed through verbatim exactly as
 * the operator authored it (normally by pasting in an Export'd template).
 */
export function wrapReportTemplateXml(spec: ReportTemplateSpec): string {
  const meta = reportTemplateTypeMeta(spec.templateType)
  const wrapperTag = meta?.wrapperTag ?? 'SCANTEMPLATE'
  const titleInfo = [
    `<INFO key="title">${cdata(spec.title)}</INFO>`,
    spec.owner ? `<INFO key="owner">${cdata(spec.owner)}</INFO>` : '',
  ]
    .filter(Boolean)
    .join('')
  return `<REPORTTEMPLATE><${wrapperTag}><TITLE>${titleInfo}</TITLE>${spec.settingsXml}</${wrapperTag}></REPORTTEMPLATE>`
}

/**
 * The Report Template create/update/delete endpoints report SUCCESS by putting
 * a human-readable message IN `<CODE>` (e.g. "Scan Report Template(s) Created
 * Successfully [89876]") — the OPPOSITE of every other classic-API call in this
 * app, where a populated `<CODE>` means failure and success carries no code at
 * all. This is the one write-response contract in this app that is NOT
 * `qualysWriteError`/`SIMPLE_RETURN`-standard; it is kept local to this config
 * type rather than added to the shared client.
 */
export function reportTemplateWriteError(res: QualysResponse): string | null {
  if (!res.ok) return reportTemplateErrorMessage(res)
  const code = xmlText(res.body, 'CODE')
  if (code && /success/i.test(code)) return null
  return reportTemplateErrorMessage(res)
}

/** Human-readable message from a report-template SIMPLE_RETURN — prefers CODE (where the message lives here). */
export function reportTemplateErrorMessage(res: QualysResponse): string {
  const code = xmlText(res.body, 'CODE')
  if (code) return code
  return qualysErrorMessage(res)
}

/** The new template id embedded in a success CODE message (e.g. "…Successfully [89876]"), or null. */
export function reportTemplateReturnId(xml: string): string | null {
  const code = xmlText(xml, 'CODE')
  const match = code.match(/\[(\d+)\]/)
  return match ? match[1] : null
}
