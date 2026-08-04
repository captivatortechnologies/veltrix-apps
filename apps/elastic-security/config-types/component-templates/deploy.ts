import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildElasticClient, elasticErrorMessage, parseJson, type ElasticClient } from '../../lib/elastic'
import {
  extractTemplateSpecs,
  isManagedTemplate,
  parseJsonObject,
  type ComponentTemplateSpec,
  type LiveComponentTemplateEntry,
  type LiveComponentTemplateResponse,
} from './validate'

export interface ComponentTemplateRollbackEntry {
  name: string
  /** True when a template of this name already existed before the deploy. */
  existed: boolean
  /** The prior live entry, captured so an update can be restored. */
  prior?: LiveComponentTemplateEntry
}

/**
 * Deploy Elasticsearch component templates via the _component_template API.
 *
 * Identity is the template NAME, carried in the path.
 * `PUT /_component_template/{name}` is a TRUE UPSERT — the same call creates a
 * missing template and replaces an existing one — so there is no separate
 * create/update branch. For each template:
 *   - GET  /_component_template/{name}  — read prior state (404 = absent).
 *                                         Capture the prior entry for rollback
 *                                         and whether it existed. If the live
 *                                         template carries `_meta.managed: true`
 *                                         it is Elastic/integration-MANAGED and
 *                                         the deploy FAILS (never modify those).
 *   - PUT  /_component_template/{name}  — upsert the body { template, version?, _meta?, deprecated? }.
 *
 * Component templates are an Elasticsearch endpoint, so all requests go
 * through client.elasticsearch(), which requires the "Elasticsearch URL" app
 * setting; if it is unset the first request returns status 0 with an
 * explanatory body, which surfaces here as the deploy failure message.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildElasticClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, kibanaUrl } = built

  const specs = extractTemplateSpecs(ctx.canvas).filter((s) => s.name && s.templateJson)
  const rollbackState: ComponentTemplateRollbackEntry[] = []
  const createdTemplates: string[] = []
  const deployed: string[] = []

  try {
    for (const spec of specs) {
      const body = buildTemplateBody(spec)

      const existing = await getComponentTemplate(client, spec.name)

      if (existing && isManagedTemplate(existing)) {
        throw new Error(
          `Component template "${spec.name}" is Elastic/integration-managed (_meta.managed = true) — refusing to modify a managed template`,
        )
      }

      rollbackState.push({ name: spec.name, existed: existing !== null, prior: existing ?? undefined })
      if (existing === null) createdTemplates.push(spec.name)

      // TRUE UPSERT — one PUT both creates and replaces.
      const res = await client.elasticsearch('PUT', `/_component_template/${encodeURIComponent(spec.name)}`, { body })
      if (!res.ok) {
        throw new Error(`Failed to upsert component template "${spec.name}": ${elasticErrorMessage(res)}`)
      }

      deployed.push(spec.name)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} component template(s) to the Elastic deployment at ${kibanaUrl}: ${deployed.join(', ')}`,
      artifacts: { deployment: kibanaUrl, deployedTemplates: deployed },
      rollbackData: { previousState: rollbackState, createdTemplates },
    }
  } catch (error) {
    return {
      success: false,
      message: `Component template deployment failed after ${deployed.length} of ${specs.length} template(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { deployment: kibanaUrl, deployedTemplates: deployed },
      // Partial rollback data lets the platform revert what was already applied.
      rollbackData: { previousState: rollbackState, createdTemplates },
    }
  }
}

// --- Helpers ---

/**
 * Fetch a single component template by name; null on 404 (absent). The
 * response wraps matches under `component_templates: [{ name, component_template }]`,
 * so we find the exact-name match.
 */
export async function getComponentTemplate(
  client: ElasticClient,
  name: string,
): Promise<LiveComponentTemplateEntry | null> {
  const res = await client.elasticsearch('GET', `/_component_template/${encodeURIComponent(name)}`)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`Failed to read component template "${name}": ${elasticErrorMessage(res)}`)
  }
  const parsed = parseJson<LiveComponentTemplateResponse>(res.body)
  return parsed?.component_templates?.find((entry) => entry.name === name) ?? null
}

/** Build the upsert body from a spec. Validated upstream; re-parsed here to fail loudly rather than PUT a malformed template. */
export function buildTemplateBody(spec: ComponentTemplateSpec): Record<string, unknown> {
  const template = spec.templateJson ? parseJsonObject(spec.templateJson) : null
  if (!template) {
    throw new Error(`Component template "${spec.name}": Template is not a valid JSON object`)
  }

  const body: Record<string, unknown> = { template, deprecated: spec.deprecated }
  if (spec.version !== undefined) body.version = spec.version

  if (spec.metaJson) {
    const meta = parseJsonObject(spec.metaJson)
    if (!meta) throw new Error(`Component template "${spec.name}": Meta is not a valid JSON object`)
    body._meta = meta
  }

  return body
}
