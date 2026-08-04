import type { DriftContext, DriftResult, DriftDiff } from '@veltrixsecops/app-sdk'
import { buildOrcaClient, type OrcaClient } from '../../lib/orcaApi'
import { priorServerId, readPriorRollback } from '../../lib/reconcile'
import { accountFromReadEnvelope, type OrcaTrustedCloudAccount } from './_shared'

/**
 * Drift for trusted cloud accounts: for each declared item, recover the
 * numeric account id this canvas assigned, GET the live account and compare
 * the managed fields (description, cloud provider, cloud account id) against
 * what we declare. Best-effort — an item with no known id, or an account that
 * can't be read, is skipped. Read-only:
 * GET /api/organization/trusted_accounts?id={id}.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  const diffs: DriftDiff[] = []

  const built = buildOrcaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) return { hasDrift: false, diffs }
  const { client } = built

  const previousData = await readPriorRollback<OrcaTrustedCloudAccount>(ctx)

  for (const item of items) {
    const itemId = item.id ?? ''
    const name = String(item.fields.accountName ?? '').trim()
    const knownId = priorServerId(previousData.previous, itemId, name)
    if (!knownId) continue

    const live = await readTrustedAccount(client, knownId)
    if (!live) continue

    compare(diffs, name, 'description', String(item.fields.description ?? '').trim(), String(live.description ?? '').trim())
    compare(diffs, name, 'cloudProvider', String(item.fields.cloudProvider ?? '').trim(), String(live.cloud_provider ?? '').trim())
    compare(diffs, name, 'cloudAccountId', String(item.fields.cloudAccountId ?? '').trim(), String(live.cloud_provider_id ?? '').trim())
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function compare(diffs: DriftDiff[], label: string, field: string, expected: unknown, actual: unknown): void {
  if (expected !== actual) {
    diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
  }
}

async function readTrustedAccount(client: OrcaClient, id: string): Promise<OrcaTrustedCloudAccount | null> {
  const res = await client.request<unknown>('GET', `/api/organization/trusted_accounts?id=${encodeURIComponent(id)}`)
  if (res.error) return null
  return accountFromReadEnvelope(res.data)
}
