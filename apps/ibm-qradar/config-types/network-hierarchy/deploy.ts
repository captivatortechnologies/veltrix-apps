import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  buildQRadarClient,
  parseJson,
  qradarErrorMessage,
  readQRadarSettings,
  resolveQRadarCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type QRadarClient,
} from '../../lib/qradar'
import { extractNetworkEntrySpecs, networkKey, type LiveNetwork, type NetworkEntrySpec } from './validate'

const PATH = '/config/network_hierarchy/staged_networks'

export interface OwnedEntry {
  key: string
  /** existed = the object was already present (operator-owned) before this app first wrote it. */
  existed: boolean
}

export interface RollbackData {
  /** app-declared object keys with their existed flag, for cross-deploy reconcile. */
  entries: OwnedEntry[]
  /** full snapshot of the staged list before this deploy, for singleton rollback. */
  priorList: LiveNetwork[]
}

/**
 * The staged hierarchy. Returns null when it could NOT be read.
 *
 * This is not a list that can default to empty: the deploy below computes what
 * to preserve from it and then PUTs a whole-list REPLACE, so an empty list means
 * "delete every network the operator maintains by hand". QRadar routes events by
 * this hierarchy. A single 500 on this GET used to erase it — and record the
 * empty list as the rollback snapshot in the same run, destroying the only way
 * back.
 */
export async function listStagedNetworks(client: QRadarClient): Promise<LiveNetwork[] | null> {
  const res = await client.request('GET', PATH, { range: 'items=0-9999' })
  if (!res.ok) return null
  const parsed = parseJson<LiveNetwork[]>(res.body)
  return Array.isArray(parsed) ? parsed : null
}

function liveKey(n: LiveNetwork): string {
  return networkKey(n.group ?? '', n.name ?? '')
}

function toBody(spec: NetworkEntrySpec): LiveNetwork {
  const body: LiveNetwork = { group: spec.group, name: spec.name, cidr: spec.cidr, description: spec.description }
  if (spec.domainId !== undefined) body.domain_id = spec.domainId
  if (spec.countryCode) body.country_code = spec.countryCode
  return body
}

async function loadPrior(ctx: DeployContext): Promise<RollbackData> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as RollbackData | undefined
    return { entries: Array.isArray(data?.entries) ? data!.entries : [], priorList: Array.isArray(data?.priorList) ? data!.priorList : [] }
  } catch {
    return { entries: [], priorList: [] }
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readQRadarSettings(ctx.settings)
  const cred = resolveQRadarCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildQRadarClient(cred, settings)

  const specs = extractNetworkEntrySpecs(ctx.canvas).filter((s) => s.group && s.name && s.cidr)
  const prior = await loadPrior(ctx)
  const priorOwnedKeys = new Set(prior.entries.filter((e) => !e.existed).map((e) => e.key))

  const current = await listStagedNetworks(client)
  if (current === null) {
    return {
      success: false,
      message:
        'Could not read the staged network hierarchy, so it was not replaced. ' +
        'This deploy sends a whole-list replace, and writing one built from an ' +
        'unreadable console would delete every network not declared here.',
      rollbackData: { entries: prior.entries, priorList: prior.priorList },
    }
  }
  const currentByKey = new Map(current.map((n) => [liveKey(n), n]))
  const desiredKeys = new Set(specs.map((s) => networkKey(s.group, s.name)))

  // Preserve every current object that is neither app-created nor being (re)declared.
  const preserved = current.filter((n) => {
    const k = liveKey(n)
    return !priorOwnedKeys.has(k) && !desiredKeys.has(k)
  })
  const desiredBodies = specs.map(toBody)
  const newList = [...preserved, ...desiredBodies]

  const entries: OwnedEntry[] = specs.map((s) => {
    const k = networkKey(s.group, s.name)
    return { key: k, existed: currentByKey.has(k) && !priorOwnedKeys.has(k) }
  })

  const resp = await client.request('PUT', PATH, { body: newList })
  if (!resp.ok) {
    return { success: false, message: `Network hierarchy replace failed: ${qradarErrorMessage(resp)}`, rollbackData: { entries: prior.entries, priorList: prior.priorList } }
  }

  const dep = await client.deployStagedConfig('INCREMENTAL')
  const rollbackData: RollbackData = { entries, priorList: current }
  if (!dep.ok) {
    return { success: false, message: `Network hierarchy staged but deploy failed: ${dep.message}`, rollbackData }
  }

  return { success: true, message: `Deployed ${specs.length} network object(s) (${preserved.length} preserved)`, rollbackData }
}
