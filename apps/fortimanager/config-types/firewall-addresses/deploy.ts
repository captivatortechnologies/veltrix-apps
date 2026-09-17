import type { DeployContext, DeployResult } from '@veltrixsecops/app-sdk'
import {
  addressUrl,
  buildFmgClient,
  fmgErrorMessage,
  readFmgSettings,
  resolveFmgCredential,
  MISSING_CREDENTIAL_MESSAGE,
  type FmgClient,
} from '../../lib/fortimanager'
import { cidrToIpMask, extractAddressSpecs, type AddressSpec, type LiveAddress } from './validate'

export interface RollbackEntry {
  itemId?: string
  /** name is the mkey — the identity. */
  name: string
  /** Whether the address existed before THIS deploy — update (true) vs create (false). */
  existed: boolean
  /** Prior managed body, captured before an update so rollback can restore it. */
  prior?: Record<string, unknown>
}

export function buildAddressBody(spec: AddressSpec): Record<string, unknown> {
  const body: Record<string, unknown> = { name: spec.name, type: spec.type }
  if (spec.comment) body.comment = spec.comment
  if (spec.type === 'ipmask') body.subnet = cidrToIpMask(spec.subnetCidr)
  else if (spec.type === 'iprange') {
    body['start-ip'] = spec.startIp
    body['end-ip'] = spec.endIp
  } else if (spec.type === 'fqdn') body.fqdn = spec.fqdn
  else if (spec.type === 'geography') body.country = spec.country
  return body
}

export function snapshotLive(live: LiveAddress): Record<string, unknown> {
  const body: Record<string, unknown> = { name: live.name }
  for (const k of ['type', 'subnet', 'start-ip', 'end-ip', 'fqdn', 'country', 'comment'] as const) {
    if (live[k] !== undefined) body[k] = live[k]
  }
  return body
}

async function loadPriorEntries(ctx: DeployContext): Promise<RollbackEntry[]> {
  try {
    const prev = await ctx.platform.getLatestDeployment(ctx.canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { entries?: RollbackEntry[] } | undefined
    return Array.isArray(data?.entries) ? (data!.entries as RollbackEntry[]) : []
  } catch {
    return []
  }
}

export default async function deploy(ctx: DeployContext): Promise<DeployResult> {
  const settings = readFmgSettings(ctx.settings)
  const cred = resolveFmgCredential(ctx.credential, settings)
  if (!cred) return { success: false, message: MISSING_CREDENTIAL_MESSAGE }
  const client = buildFmgClient(cred, settings)
  const url = addressUrl(settings.adom)
  const specs = extractAddressSpecs(ctx.canvas).filter((s) => s.name)
  const failures: string[] = []
  const entries: RollbackEntry[] = []

  if (settings.workspaceMode) {
    const lock = await client.lock(settings.adom)
    if (!lock.ok) {
      await client.logout()
      return { success: false, message: `Failed to lock ADOM "${settings.adom}": ${fmgErrorMessage(lock)}` }
    }
  }

  // Cleared to true only when the work above ran to the end, so the
  // finally below can tell a completed run from an aborted one.
  let completed = false
  try {
    const listed = await client.get(url)
    if (!listed.ok) {
      failures.push(`list: ${fmgErrorMessage(listed)}`)
    } else {
      const live = Array.isArray(listed.data) ? (listed.data as LiveAddress[]) : []
      const liveByName = new Map<string, LiveAddress>()
      for (const a of live) if (a.name) liveByName.set(a.name.toLowerCase(), a)

      const prior = await loadPriorEntries(ctx)

      for (const spec of specs) {
        const liveMatch = liveByName.get(spec.name.toLowerCase()) ?? null
        const resp = await client.set(url, buildAddressBody(spec))
        if (!resp.ok) {
          failures.push(`${spec.name}: ${fmgErrorMessage(resp)}`)
          continue
        }
        entries.push({
          itemId: spec.itemId,
          name: spec.name,
          existed: !!liveMatch,
          prior: liveMatch ? snapshotLive(liveMatch) : undefined,
        })
      }

      // Reconcile: delete addresses THIS app created previously but no longer declares.
      const declaredNames = new Set(specs.map((s) => s.name.toLowerCase()))
      for (const p of prior) {
        if (!p.existed && !declaredNames.has(p.name.toLowerCase())) {
          const resp = await client.delete(url, ['name', '==', p.name])
          if (!resp.ok) failures.push(`delete ${p.name}: ${fmgErrorMessage(resp)}`)
        }
      }
    }

    completed = true
  } finally {
    // Release the ADOM lock even if the work above threw. A workspace-mode
    // ADOM left locked blocks every other FortiManager administrator until
    // someone clears it by hand, and the deploy that caused it reads green.
    //
    // `commit` is false on the throw path: the ADOM then holds partially
    // written changes, and unlocking without committing is what discards them.
    if (settings.workspaceMode) {
      await finishWorkspace(client, settings.adom, failures, {
        commit: completed && failures.length === 0,
      })
    }
    await client.logout()
  }

  if (failures.length) {
    return { success: false, message: `Some addresses failed: ${failures.join('; ')}`, rollbackData: { entries } }
  }
  return { success: true, message: `Deployed ${entries.length} firewall address(es)`, rollbackData: { entries } }
}

/**
 * Commit staged changes (or discard them) and ALWAYS release the ADOM lock.
 *
 * `commit` defaults to "there were no failures", but callers pass it explicitly
 * from their `finally` so an ABORTED run discards rather than commits —
 * unlocking without committing is what throws partially-written changes away.
 *
 * The unlock result is inspected rather than discarded. A lock that did not
 * release leaves a workspace-mode ADOM blocked for every other FortiManager
 * administrator until someone clears it by hand, so it belongs in the result
 * instead of being dropped while the deploy reports success.
 */
export async function finishWorkspace(
  client: FmgClient,
  adom: string,
  failures: string[],
  opts: { commit?: boolean } = {},
): Promise<void> {
  const shouldCommit = opts.commit ?? failures.length === 0
  if (shouldCommit) {
    const commit = await client.commit(adom)
    if (!commit.ok) failures.push(`commit: ${fmgErrorMessage(commit)}`)
  }
  const released = await client.unlock(adom)
  if (!released.ok) {
    failures.push(
      `unlock ${adom}: ${fmgErrorMessage(released)} — the ADOM may still be locked, ` +
        'which blocks every other FortiManager administrator until it is released',
    )
  }
}
