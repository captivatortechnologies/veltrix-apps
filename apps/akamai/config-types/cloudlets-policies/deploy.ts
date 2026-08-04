import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import { buildAkamaiClient, parseJson, type AkamaiClient } from '../../lib/akamaiApi'
import {
  contentFromResponse,
  findPolicy,
  latestVersion,
  policiesPath,
  policyPath,
  policyVersionPath,
  policyVersionsPath,
  readPolicyFields,
  sameMatchRules,
  type CloudletPolicy,
  type CloudletPolicyVersion,
} from './_shared'

/**
 * Deploy Akamai Cloudlets shared policies over the Cloudlets API v3
 * (EdgeGrid-signed), reconciled by NAME:
 *   list:            GET  /cloudlets/v3/policies                        → find by name
 *   update policy:   PUT  /cloudlets/v3/policies/{id}                    { groupId, description }
 *   create policy:   POST /cloudlets/v3/policies                        { cloudletType, groupId, name, description, policyType: "SHARED" }
 *   create version:  POST /cloudlets/v3/policies/{id}/versions           { description, matchRules }
 *
 * A policy version is immutable once activated, so rather than tracking
 * draft-vs-immutable state, deploy always creates a NEW version when the
 * latest version's matchRules/description differ from what's declared —
 * simple and side-effect-safe (see _shared.ts). `rollbackData.previous`
 * records, per policy, whether it existed, its prior groupId/description, and
 * the version number we created (if any) — so rollback can restore the prior
 * policy body and remove the version it created, or delete the whole policy.
 */

interface PriorEntry {
  name: string
  policyId: number | null
  existed: boolean
  priorGroupId: number | null
  priorDescription: string | null
  createdVersion: number | null
}

async function listAllPolicies(client: AkamaiClient): Promise<CloudletPolicy[]> {
  const res = await client.request('GET', policiesPath, { query: { size: 1000 } })
  if (!res.ok) throw new Error(`GET ${policiesPath} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return contentFromResponse<CloudletPolicy>(parseJson<unknown>(res.body))
}

async function listAllVersions(client: AkamaiClient, policyId: number): Promise<CloudletPolicyVersion[]> {
  const res = await client.request('GET', policyVersionsPath(policyId), { query: { size: 1000 } })
  if (!res.ok) throw new Error(`GET ${policyVersionsPath(policyId)} → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
  return contentFromResponse<CloudletPolicyVersion>(parseJson<unknown>(res.body))
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []

  const built = buildAkamaiClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { success: false, message: built.error }
  const { client } = built

  const previous: PriorEntry[] = []
  const applied: string[] = []

  try {
    const live = await listAllPolicies(client)

    for (const item of items) {
      const fields = readPolicyFields(item.fields)
      if (!fields.name) continue

      const match = findPolicy(live, fields.name)

      if (match?.id) {
        const policyId = match.id
        let createdVersion: number | null = null

        if (match.groupId !== fields.groupId || (match.description ?? '') !== fields.description) {
          const res = await client.request('PUT', policyPath(policyId), {
            body: { groupId: fields.groupId, description: fields.description || undefined },
          })
          if (!res.ok) throw new Error(`PUT policy "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
        }

        const versions = await listAllVersions(client, policyId)
        const latest = latestVersion(versions)
        let currentMatchRules: unknown[] = []
        let currentDescription = ''
        if (latest?.version != null) {
          const vRes = await client.request('GET', policyVersionPath(policyId, latest.version))
          if (vRes.ok) {
            const full = parseJson<CloudletPolicyVersion>(vRes.body)
            currentMatchRules = Array.isArray(full?.matchRules) ? full!.matchRules! : []
            currentDescription = full?.description ?? ''
          }
        }

        if (!latest || !sameMatchRules(currentMatchRules, fields.matchRules) || currentDescription !== fields.versionDescription) {
          const res = await client.request('POST', policyVersionsPath(policyId), {
            body: { description: fields.versionDescription || undefined, matchRules: fields.matchRules },
          })
          if (!res.ok) throw new Error(`POST version for "${fields.name}" → HTTP ${res.status}: ${res.body.slice(0, 300)}`)
          const created = parseJson<CloudletPolicyVersion>(res.body)
          createdVersion = created?.version ?? null
        }

        previous.push({
          name: fields.name,
          policyId,
          existed: true,
          priorGroupId: match.groupId ?? null,
          priorDescription: match.description ?? null,
          createdVersion,
        })
      } else {
        const createRes = await client.request('POST', policiesPath, {
          body: { cloudletType: fields.cloudletType, groupId: fields.groupId, name: fields.name, description: fields.description || undefined, policyType: 'SHARED' },
        })
        if (!createRes.ok) throw new Error(`POST policy "${fields.name}" → HTTP ${createRes.status}: ${createRes.body.slice(0, 300)}`)
        const created = parseJson<CloudletPolicy>(createRes.body)
        const policyId = created?.id ?? null
        let createdVersion: number | null = null

        if (policyId != null) {
          const vRes = await client.request('POST', policyVersionsPath(policyId), {
            body: { description: fields.versionDescription || undefined, matchRules: fields.matchRules },
          })
          if (!vRes.ok) throw new Error(`POST version for "${fields.name}" → HTTP ${vRes.status}: ${vRes.body.slice(0, 300)}`)
          const createdV = parseJson<CloudletPolicyVersion>(vRes.body)
          createdVersion = createdV?.version ?? null
          live.push(created!)
        }

        previous.push({ name: fields.name, policyId, existed: false, priorGroupId: null, priorDescription: null, createdVersion })
      }

      applied.push(fields.name)
    }

    return {
      success: true,
      message: `Applied ${applied.length} Cloudlets polic${applied.length === 1 ? 'y' : 'ies'}: ${applied.join(', ') || '(none)'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  } catch (error) {
    return {
      success: false,
      message: `Cloudlets policy deploy failed after ${applied.length} of ${items.length}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      artifacts: { applied },
      rollbackData: { previous },
    }
  }
}
