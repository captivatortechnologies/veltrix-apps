import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildSplunkUrl, buildAuthHeader, getEntityContent, postForm, splunkRequest } from '../../lib/splunkApi'
import { parseConf, upsertStanza } from '../../lib/splunkConf'

/**
 * Deploy Splunk .conf stanzas into a target-app namespace via the REST configs
 * API. Each authored `default/local *.conf` file is parsed into stanzas and
 * upserted at:
 *   /servicesNS/nobody/<targetApp>/configs/conf-<file>
 *
 * Non-conf files (bin/static/lib/…) are reported as skipped — this config type
 * manages configuration stanzas, not packaged assets.
 */

interface FileEntry {
  path?: string
  content?: string
}

interface StanzaSnapshot {
  nsBase: string
  stanza: string
  existed: boolean
  prev: Record<string, string> | null
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const { component, credential, connectivity, canvas } = ctx

  if (!credential || !connectivity) {
    return { success: false, message: 'Missing credential or connectivity for config file deployment' }
  }

  const baseUrl = buildSplunkUrl(component, connectivity)
  const auth = buildAuthHeader(credential)
  const snapshot: StanzaSnapshot[] = []
  const applied: string[] = []
  const skipped: string[] = []

  try {
    for (const section of canvas.sections) {
      const fields = section.fields
      const targetApp = ((fields.targetApp as string | undefined) ?? 'system').trim() || 'system'
      const files = Array.isArray(fields.files) ? (fields.files as FileEntry[]) : []

      for (const file of files) {
        const path = typeof file?.path === 'string' ? file.path.trim() : ''
        if (!path) continue
        const slash = path.indexOf('/')
        const folder = slash === -1 ? 'default' : path.slice(0, slash)
        const filename = slash === -1 ? path : path.slice(slash + 1)

        if (!((folder === 'default' || folder === 'local') && filename.endsWith('.conf'))) {
          skipped.push(path)
          continue
        }

        const confName = filename.slice(0, -'.conf'.length)
        const nsBase = `/servicesNS/nobody/${encodeURIComponent(targetApp)}/configs/conf-${encodeURIComponent(confName)}`

        for (const stanza of parseConf(file.content ?? '')) {
          const existing = await getEntityContent(baseUrl, auth, `${nsBase}/${encodeURIComponent(stanza.name)}`)
          const prev: Record<string, string> | null = existing
            ? Object.fromEntries(
                Object.keys(stanza.settings)
                  .filter((k) => existing[k] !== undefined)
                  .map((k) => [k, String(existing[k])]),
              )
            : null
          snapshot.push({ nsBase, stanza: stanza.name, existed: Boolean(existing), prev })
          await upsertStanza(baseUrl, auth, nsBase, stanza)
        }
        applied.push(`${targetApp}:${confName}`)
      }
    }

    let message = `Applied ${applied.length} .conf file(s)${applied.length ? `: ${applied.join(', ')}` : ''}`
    if (skipped.length > 0) message += `. Skipped ${skipped.length} non-conf file(s): ${skipped.join(', ')}`

    return {
      success: true,
      message,
      artifacts: { applied, skipped },
      rollbackData: { stanzas: snapshot },
    }
  } catch (error) {
    return {
      success: false,
      message: `Config file deployment failed after ${applied.length} file(s): ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied, skipped },
      rollbackData: { stanzas: snapshot },
    }
  }
}
