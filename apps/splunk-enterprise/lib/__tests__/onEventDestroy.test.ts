import { test } from 'node:test'
import assert from 'node:assert/strict'
import onEvent from '../../hooks/onEvent'
import { deleteRecord, requestOperation } from '../byolLifecycle'

class StateDb {
  infra: any = { id: 'i1', name: 'BYOL001', customer_id: 'c1', status: 'destroying', active_deployment_id: 'r1',
    deployment_type: 'distributed', environment_type: 'prod', hosting_type: 'Amazon Web Services', region: 'us-east-1',
    indexer_count: 3, search_head_count: 3, cloud_provider_id: 'provider', network_mode: 'dedicated', dns_mode: 'managed',
    control_plane_layout: 'dedicated', heavy_forwarder_count: 1, applied_configuration: { plan: [] } }
  run: any = { id: 'r1', infrastructure_id: 'i1', action: 'destroy', status: 'running', started_at: new Date(), command_payload: { plan: [] } }
  resources: any[] = [{ id: 'res', infrastructure_id: 'i1', status: 'ready', external_ref: 'i-cloud', plan_key: 'data/indexer-1' }]
  deleted = false
  writes = 0
  async transaction(work: any) {
    const snapshot = JSON.stringify({ infra: this.infra, run: this.run, resources: this.resources, writes: this.writes })
    try { return await work(this) } catch (error) { Object.assign(this, JSON.parse(snapshot)); throw error }
  }
  async $queryRawUnsafe(sql: string, ...params: any[]): Promise<any[]> {
    if (sql.startsWith('UPDATE splunk_byol_infrastructure SET status')) {
      this.infra.status = params[1]; this.writes++; return [{ ...this.infra }]
    }
    if (sql.startsWith('INSERT INTO splunk_byol_deployment')) {
      this.run = { id: 'r2', infrastructure_id: 'i1', action: params[1], status: 'running', started_at: new Date() }; return [{ ...this.run }]
    }
    if (sql.includes('FROM splunk_byol_infrastructure')) return this.deleted || (params[1] && params[1] !== 'c1') ? [] : [{ ...this.infra }]
    if (sql.includes('FROM splunk_byol_deployment_step')) return []
    if (sql.includes('FROM splunk_byol_deployment')) return this.run ? [{ ...this.run }] : []
    if (sql.includes('FROM splunk_byol_resource')) return this.resources.map(r => ({ ...r }))
    return []
  }
  async $executeRawUnsafe(sql: string, ...params: any[]): Promise<number> {
    this.writes++
    if (sql.startsWith('UPDATE splunk_byol_deployment SET command_payload')) this.run.command_payload = JSON.parse(params[1])
    if (sql.startsWith('UPDATE splunk_byol_deployment SET status')) this.run.status = params[1]
    if (sql.startsWith('UPDATE splunk_byol_infrastructure SET active_deployment_id = $2')) { this.infra.active_deployment_id = params[1]; this.infra.applied_configuration = JSON.parse(params[2]) }
    if (sql.startsWith('UPDATE splunk_byol_infrastructure SET active_deployment_id = NULL')) {
      this.infra.active_deployment_id = null
      if (sql.includes('applied_configuration = NULL')) this.infra.applied_configuration = null
    }
    if (sql.startsWith('UPDATE splunk_byol_resource SET status = $2')) this.resources.forEach(r => { r.status = params[1]; if (params[1] === 'not_started') r.external_ref = null })
    if (sql.startsWith('DELETE FROM splunk_byol_infrastructure')) this.deleted = true
    return 1
  }
}

function context(db = new StateDb()) {
  let releases = 0, publications = 0
  const ctx: any = { db, customerId: 'c1', appId: 'splunk-enterprise', events: { publish: async () => { publications++ } },
    provisioning: { assertAllowed: async () => {}, lookupNetwork: async () => null, reserveNetwork: async () => { throw new Error('unexpected reservation') },
      releaseNetwork: async () => { releases++ } } }
  return { db, ctx, releases: () => releases, publications: () => publications }
}
const status = (value: string, deploymentId = 'r1') => ({ topic: 'deployment.status', payload: { infrastructureId: 'i1', deploymentId, action: 'destroy', status: value } })

test('destroy progress is not a completed teardown', async () => {
  const t = context(); await onEvent({ ...t.ctx, ...status('updating') })
  assert.equal(t.db.infra.status, 'destroying'); assert.equal(t.db.run.status, 'running'); assert.equal(t.releases(), 0)
})
test('confirmed destroy clears resource refs, completes the run, and releases the network', async () => {
  const t = context(); await onEvent({ ...t.ctx, ...status('completed') })
  assert.equal(t.db.infra.status, 'deprovisioned'); assert.equal(t.db.run.status, 'succeeded')
  assert.equal(t.db.resources[0].status, 'not_started'); assert.equal(t.db.resources[0].external_ref, null)
  assert.equal(t.db.infra.active_deployment_id, null); assert.equal(t.releases(), 1)
  await onEvent({ ...t.ctx, ...status('completed') }); assert.equal(t.releases(), 1)
})
test('late status from an older run does not change the current operation', async () => {
  const t = context(); await onEvent({ ...t.ctx, ...status('completed', 'old-run') })
  assert.equal(t.db.writes, 0); assert.equal(t.releases(), 0)
})
test('failed teardown retains cloud references and the subnet reservation', async () => {
  const t = context(); await onEvent({ ...t.ctx, ...status('failed') })
  assert.equal(t.db.infra.status, 'error'); assert.equal(t.db.run.status, 'failed')
  assert.equal(t.db.resources[0].external_ref, 'i-cloud'); assert.equal(t.releases(), 0)
  await assert.rejects(() => deleteRecord(t.ctx, 'c1', 'i1'), /Destroy infrastructure successfully/)
})
test('network cleanup failure leaves the completed run recoverable and blocks deletion', async () => {
  const t = context(); t.ctx.provisioning.releaseNetwork = async () => { throw new Error('database offline') }
  await assert.rejects(() => onEvent({ ...t.ctx, ...status('completed') }), /database offline/)
  assert.equal(t.db.infra.active_deployment_id, 'r1')
  await assert.rejects(() => deleteRecord(t.ctx, 'c1', 'i1'), /already in progress/)
  t.ctx.provisioning.releaseNetwork = async () => {}
  await onEvent({ ...t.ctx, ...status('completed') })
  await deleteRecord(t.ctx, 'c1', 'i1'); assert.equal(t.db.deleted, true)
})
test('a running operation cannot be deleted or overlapped by another deploy', async () => {
  const t = context()
  await assert.rejects(() => deleteRecord(t.ctx, 'c1', 'i1'), /already in progress/)
  await assert.rejects(() => requestOperation(t.ctx, 'c1', 'i1', 'deploy'), /already in progress/)
  assert.equal(t.db.deleted, false); assert.equal(t.publications(), 0)
})
test('missing payment fails before a run or cloud request is created', async () => {
  const t = context(); t.db.infra.status = 'not_started'; t.db.infra.active_deployment_id = null
  t.db.infra.applied_configuration = null; t.db.run = null; t.db.resources = []
  t.ctx.provisioning.assertAllowed = async () => { throw Object.assign(new Error('Payment method required'), { statusCode: 402 }) }
  await assert.rejects(() => requestOperation(t.ctx, 'c1', 'i1', 'deploy'), /Payment method required/)
  assert.equal(t.db.run, null); assert.equal(t.publications(), 0); assert.equal(t.db.infra.status, 'not_started')
})
test('broker failure retains an atomic command for later dispatch', async () => {
  const t = context(); t.db.infra.status = 'not_started'; t.db.infra.active_deployment_id = null
  t.db.infra.applied_configuration = null; t.db.run = null; t.db.resources = []
  t.ctx.events.publish = async () => { throw new Error('broker offline') }
  const result = await requestOperation(t.ctx, 'c1', 'i1', 'deploy')
  assert.equal(result.dispatchPending, true); assert.equal(t.db.run.command_payload.deploymentId, 'r2')
  assert.equal(t.db.infra.active_deployment_id, 'r2'); assert.equal(t.db.infra.status, 'provisioning')
  await assert.rejects(() => requestOperation(t.ctx, 'c1', 'i1', 'deploy'), /already in progress/)
})
test('a record cannot be deleted while its network reservation remains live', async () => {
  const t = context(); t.db.infra.status = 'deprovisioned'; t.db.infra.active_deployment_id = null
  t.db.run.status = 'succeeded'; t.db.resources = []
  t.ctx.provisioning.lookupNetwork = async () => ({ allocationId: 'allocation' })
  await assert.rejects(() => deleteRecord(t.ctx, 'c1', 'i1'), /Network cleanup is pending/)
  assert.equal(t.db.deleted, false)
})
