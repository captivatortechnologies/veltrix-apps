import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import {
  extractAuthMethodSpecs,
  METHOD_ODATA_TYPES,
  type AuthMethodSpec,
  type LiveAuthMethodConfig,
} from './validate'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

export interface RollbackEntry {
  itemId?: string
  /** The method id — also the Graph resource id. */
  method: string
  existed: boolean
  prior?: Record<string, unknown>
}

/** PATCH body: the required @odata.type discriminator plus the managed state. */
export function buildBody(spec: AuthMethodSpec): Record<string, unknown> {
  return { '@odata.type': METHOD_ODATA_TYPES[spec.method], state: spec.state }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const specs = extractAuthMethodSpecs(ctx.canvas).filter((s) => s.method in METHOD_ODATA_TYPES)

  const entries: RollbackEntry[] = []
  const failures: string[] = []

  for (const spec of specs) {
    // Method configurations are fixed singletons — read current state for
    // rollback, then PATCH the managed state. No create/delete.
    const getResp = await client.get(`${BASE}/${spec.method}?$select=id,state`)
    const live = getResp.ok ? parseJson<LiveAuthMethodConfig>(getResp.body) : null
    const priorState = live?.state ?? 'disabled'

    const resp = await client.patch(`${BASE}/${spec.method}`, buildBody(spec))
    if (!resp.ok) {
      failures.push(`${spec.method}: ${graphErrorMessage(resp)}`)
      continue
    }
    entries.push({
      itemId: spec.itemId,
      method: spec.method,
      existed: true,
      prior: { '@odata.type': METHOD_ODATA_TYPES[spec.method], state: priorState },
    })
  }

  if (failures.length) {
    return {
      success: false,
      message: `Some authentication methods failed: ${failures.join('; ')}`,
      rollbackData: { entries },
    }
  }
  return {
    success: true,
    message: `Updated ${entries.length} authentication method(s)`,
    rollbackData: { entries },
  }
}
