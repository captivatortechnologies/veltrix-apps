import { mergeManaged } from '../../lib/managedResources'
import type { RollbackContext, RollbackResult } from '@veltrixsecops/app-sdk'
import {
  buildGraphClient,
  graphErrorMessage,
  parseJson,
  readGraphSettings,
  resolveGraphCredential,
  MISSING_CREDENTIAL_MESSAGE,
} from '../../lib/graph'
import type { RollbackEntry } from './deploy'

const BASE = '/policies/authenticationMethodsPolicy/authenticationMethodConfigurations'

export default async function rollback(ctx: RollbackContext): Promise<RollbackResult> {
  const settings = readGraphSettings(ctx.settings)
  const cred = resolveGraphCredential(ctx.credential, settings, ctx.identity)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildGraphClient(cred, settings)

  const data = ctx.rollbackData as { entries?: RollbackEntry[] } | undefined
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const failures: string[] = []
  let restored = 0

  for (const e of entries) {
    if (e.prior) {
      let prior=e.prior
      if(Object.keys(prior).some(k=>!['@odata.type','state'].includes(k))){
        const current=await client.get(`${BASE}/${e.method}`)
        const live=parseJson<Record<string,unknown>>(current.body)
        if(!current.ok||!live){failures.push(`restore ${e.method}: current method settings unavailable`);continue}
        prior=mergeManaged(live,prior)
      }
      const resp = await client.patch(`${BASE}/${e.method}`, prior)
      if (!resp.ok) failures.push(`restore ${e.method}: ${graphErrorMessage(resp)}`)
      else restored++
    }
  }

  if (failures.length) {
    return { success: false, message: `Rollback had errors: ${failures.join('; ')}` }
  }
  return { success: true, message: `Rolled back authentication methods (${restored} restored)` }
}
