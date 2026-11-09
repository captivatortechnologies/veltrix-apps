import type { AppRouteContext, AppEventPublisher, PlatformDatabaseClient } from '@veltrixsecops/app-sdk'
import * as store from './db'
import { buildByolResourcePlan, DEPLOYMENT_STEPS } from './byolTopology'
import { deriveProviderCode } from './byolNetwork'
import { buildByolTags } from './byolTags'

/** What a lifecycle operation needs from either a route or an event context. */
export type LifecycleContext = Pick<AppRouteContext, 'db' | 'events' | 'appId' | 'provisioning'>

export const lifecycleError = (message: string, statusCode = 409) => Object.assign(new Error(message), { statusCode })

export async function atomic<T>(db: PlatformDatabaseClient, work: (db: PlatformDatabaseClient) => Promise<T>): Promise<T> {
  if (!db.transaction) throw lifecycleError('Upgrade the platform before provisioning infrastructure.', 503)
  return db.transaction(work)
}

export async function lockInfrastructure(db: PlatformDatabaseClient, id: string, customerId: string) {
  const rows = await db.$queryRawUnsafe<any[]>(
    'SELECT * FROM splunk_byol_infrastructure WHERE id = $1::uuid AND customer_id = $2::uuid FOR UPDATE', id, customerId)
  return rows[0] ?? null
}

export function assertIdle(row: any): void {
  if (row.active_deployment_id || ['provisioning', 'destroying'].includes(row.status)) {
    throw lifecycleError('An operation is already in progress. Follow its Activity before trying again.')
  }
}

export async function dispatchCommand(db: PlatformDatabaseClient, events: AppEventPublisher, runId: string): Promise<void> {
  const rows = await db.$queryRawUnsafe<any[]>(
    "SELECT id, action, command_payload FROM splunk_byol_deployment WHERE id = $1::uuid AND status = 'running'", runId)
  const row = rows[0]
  if (!row?.command_payload) return
  await events.publish(`infrastructure.${row.action}.requested`, row.command_payload)
  await db.$executeRawUnsafe('UPDATE splunk_byol_deployment SET dispatched_at = now() WHERE id = $1::uuid', runId)
}

export async function requestOperation(ctx: LifecycleContext, customerId: string, id: string, action: 'deploy' | 'destroy', userId?: string | null, adminEmail?: string | null) {
  const result = await atomic(ctx.db, async (db) => {
    const row = await lockInfrastructure(db, id, customerId)
    if (!row) throw lifecycleError('BYOL infrastructure not found', 404)
    assertIdle(row)
    const infra = await store.getByol(db, id, customerId)
    if (!infra) throw lifecycleError('BYOL infrastructure not found', 404)
    if (!ctx.provisioning) throw lifecycleError('Platform provisioning services are unavailable.', 503)
    const provider = deriveProviderCode(infra)
    if (!provider || !infra.region) throw lifecycleError('Select a supported cloud provider and region before provisioning.', 400)
    if (action === 'deploy') {
      if (infra.networkMode === 'byoc' && !infra.cloudAccountConnectionId) throw lifecycleError('Select a verified cloud account for BYOC.', 400)
      if (infra.networkMode !== 'byoc' && infra.cloudAccountConnectionId) throw lifecycleError('A customer cloud account requires BYOC network mode.', 400)
      await ctx.provisioning.assertAllowed({ provider, cloudAccountConnectionId: infra.cloudAccountConnectionId })
    }
    const plan = buildByolResourcePlan({ ...infra, hostingType: infra.hosting_type, isCloud: Boolean(infra.cloudProviderId),
      indexerRegions: infra.indexerRegions.map(r => r.region), searchHeadRegions: infra.searchHeadRegions.map(r => r.region) })
    const tags = buildByolTags({ customerId, infrastructureId: id, appId: ctx.appId, name: infra.name, environmentType: infra.environmentType })
    let network = await ctx.provisioning.lookupNetwork(id)
    if (action === 'deploy' && infra.networkMode === 'shared' && !network) {
      network = await ctx.provisioning.reserveNetwork({ infrastructureId: id, provider, region: infra.region })
    }
    const previous = row.applied_configuration
    // Teardown must render the original provider/account/configuration, never a new subnet preview.
    const base = action === 'destroy' && previous ? previous : {
      infrastructureId: id, infrastructure: infra, customerId, provider, region: infra.region, plan,
      networkMode: infra.networkMode, dnsMode: infra.dnsMode, cloudAccountConnectionId: infra.cloudAccountConnectionId,
      tags, ...(network ? { network } : {}), adminEmail,
    }
    if (action === 'deploy' && infra.versionId) {
      const version = await store.getReadableVersion(db, infra.versionId, customerId)
      if (!version?.downloadUrl) throw lifecycleError('The selected Splunk version has no installer download.', 400)
      base.splunkDownloadUrl = version.downloadUrl
    }
    const steps = action === 'deploy' ? DEPLOYMENT_STEPS : [
      { key: 'plan', title: 'Teardown planned' }, { key: 'teardown', title: 'Removing cloud resources' }, { key: 'done', title: 'Resources destroyed' },
    ]
    const deployment = await store.createDeployment(db, id, action, steps, userId)
    const payload = { ...base, deploymentId: deployment.id, action }
    if (action === 'deploy') await store.seedResources(db, id, customerId, plan)
    await db.$executeRawUnsafe('UPDATE splunk_byol_deployment SET command_payload = $2::jsonb WHERE id = $1::uuid', deployment.id, JSON.stringify(payload))
    await db.$executeRawUnsafe(
      'UPDATE splunk_byol_infrastructure SET active_deployment_id = $2::uuid, applied_configuration = $3::jsonb WHERE id = $1::uuid',
      id, deployment.id, JSON.stringify(action === 'deploy' ? base : previous ?? base))
    const infrastructure = await store.setByolStatus(db, id, action === 'deploy' ? 'provisioning' : 'destroying')
    return { infrastructure, deployment, resources: await store.listResources(db, id) }
  })
  let dispatchPending = false
  try { await dispatchCommand(ctx.db, ctx.events, result.deployment.id) }
  catch (error) {
    dispatchPending = true
    console.error('[splunk-enterprise] Provisioning command persisted; dispatch will retry', { infrastructureId: id, deploymentId: result.deployment.id, action, error: error instanceof Error ? error.message : String(error) })
  }
  return { ...result, dispatchPending }
}

export async function deleteRecord(ctx: LifecycleContext, customerId: string, id: string) {
  return atomic(ctx.db, async db => {
    const row = await lockInfrastructure(db, id, customerId)
    if (!row) return // DELETE is idempotent.
    assertIdle(row)
    const run = await store.getLatestDeployment(db, id)
    const resources = await store.listResources(db, id)
    const tornDown = row.status === 'deprovisioned' && run?.action === 'destroy' && run.status === 'succeeded'
    const neverDeployed = row.status === 'not_started' && !run && !row.applied_configuration
    if (!(tornDown || neverDeployed) || resources.some(r => r.externalRef || r.status !== 'not_started')) {
      throw lifecycleError('Destroy infrastructure successfully before deleting its record. Failed operations may still have cloud resources.')
    }
    if (!ctx.provisioning) throw lifecycleError('Platform provisioning services are unavailable.', 503)
    if (await ctx.provisioning.lookupNetwork(id)) throw lifecycleError('Network cleanup is pending. Refresh and retry deletion after cleanup completes.')
    await store.deleteByol(db, id)
  })
}
