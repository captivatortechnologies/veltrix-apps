import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildCloudflareClient,
  cloudflareErrorMessage,
  cloudflareResult,
  MISSING_ACCOUNT_MESSAGE,
  type CloudflareClient,
} from '../../lib/cloudflare'
import {
  accessAppKey,
  extractAccessAppSpecs,
  parseJsonObject,
  type AccessAppSpec,
  type LiveAccessApp,
} from './validate'

export interface AccessAppRollbackEntry {
  name: string
  label: string
  existed: boolean
  id?: string
  prior?: LiveAccessApp
}

/**
 * Deploy Cloudflare Access applications via the API (account-scoped).
 *
 * Identity is the application `name`: list /access/apps, match on the name, then
 * PUT an existing application by id or POST a new one. Account-scoped objects
 * need an account id — bail early with a clear message if none is available.
 */
export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const built = buildCloudflareClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { success: false, message: built.error }
  }
  const { client, domain } = built

  if (!(await client.hasAccount())) {
    return { success: false, message: MISSING_ACCOUNT_MESSAGE }
  }

  const specs = extractAccessAppSpecs(ctx.canvas).filter((s) => s.name && s.domain)
  const rollbackState: AccessAppRollbackEntry[] = []
  const createdIds: string[] = []
  const deployed: string[] = []

  try {
    const existing = await listAccessApps(client)
    const byKey = new Map(
      existing.filter((a) => a.name).map((a) => [accessAppKey(a.name as string), a]),
    )

    for (const spec of specs) {
      const label = spec.name
      const key = accessAppKey(spec.name)
      const live = byKey.get(key)

      if (live && live.id) {
        rollbackState.push({ name: spec.name, label, existed: true, id: live.id, prior: live })
        const res = await client.account('PUT', `/access/apps/${live.id}`, { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to update Access application "${label}": ${cloudflareErrorMessage(res)}`)
      } else {
        const res = await client.account('POST', '/access/apps', { body: buildPayload(spec) })
        if (!res.ok) throw new Error(`Failed to create Access application "${label}": ${cloudflareErrorMessage(res)}`)
        const created = cloudflareResult<LiveAccessApp>(res)
        if (!created?.id) throw new Error(`Access application "${label}" was created but the API returned no id`)
        rollbackState.push({ name: spec.name, label, existed: false, id: created.id })
        createdIds.push(created.id)
      }
      deployed.push(label)
    }

    return {
      success: true,
      message: `Deployed ${deployed.length} Access application(s) for zone "${domain}": ${deployed.join(', ')}`,
      artifacts: { domain, deployedApplications: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  } catch (error) {
    return {
      success: false,
      message: `Access application deployment failed after ${deployed.length} of ${specs.length} application(s): ${
        error instanceof Error ? error.message : 'Unknown error'
      }`,
      artifacts: { domain, deployedApplications: deployed },
      rollbackData: { previousState: rollbackState, createdIds },
    }
  }
}

// --- Helpers ---

/** List all Access applications in the account; throws on a non-OK response. */
export async function listAccessApps(client: CloudflareClient): Promise<LiveAccessApp[]> {
  const res = await client.accountGetAll<LiveAccessApp>('/access/apps')
  if (!res.ok) {
    throw new Error(
      `Failed to list Access applications: ${cloudflareErrorMessage({ status: res.status, ok: false, body: res.body })}`,
    )
  }
  return res.items
}

function buildPayload(spec: AccessAppSpec): Record<string, unknown> {
  const advanced = parseJsonObject(spec.appJson).value ?? {}
  return {
    name: spec.name,
    domain: spec.domain,
    type: spec.type,
    session_duration: spec.sessionDuration,
    ...advanced,
  }
}
