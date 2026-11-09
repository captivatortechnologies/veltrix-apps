import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cancelRun, handleRunnerEvent, reconcile, requestRun } from '../runLifecycle'
import { RUN_ACTION, RUN_CANCEL_REQUESTED, RUN_MATCH, RUN_REQUESTED, RUN_STATUS, type RunActionPayload, type RunStatus, type RunStatusPayload } from '../runner/contract'

const CUSTOMER = '00000000-0000-4000-8000-000000000001'
const COMPONENT = '00000000-0000-4000-8000-0000000000c1'
const POLICY_ID = '00000000-0000-4000-8000-0000000000a1'
const ACCOUNT_ID = '00000000-0000-4000-8000-0000000000b1'

class StateDb {
  policy: any = {
    id: POLICY_ID, customer_id: CUSTOMER, canvas_id: null, name: 'stopped-ec2', version: 1, action_class: 'reversible', enforcement: 'auto',
    compiled_yaml: 'policies: []', model: { name: 'stopped-ec2', provider: 'aws', resource: 'ec2', maxResources: 25, ownerTagKeys: ['Owner'] },
    created_at: new Date(), updated_at: new Date(),
  }
  account: any = null
  runs: any[] = []
  matches: any[] = []
  actions: any[] = []
  stale = false
  async transaction(work: any) {
    const snapshot = JSON.stringify({ account: this.account, runs: this.runs, matches: this.matches, actions: this.actions })
    try { return await work(this) } catch (error) { Object.assign(this, JSON.parse(snapshot)); throw error }
  }
  private run(id: string) { return this.runs.find(r => r.id === id) }
  async $queryRawUnsafe(sql: string, ...p: any[]): Promise<any[]> {
    if (sql.startsWith('SELECT * FROM cgov_policy WHERE id')) return this.policy && p[0] === this.policy.id && p[1] === CUSTOMER ? [{ ...this.policy }] : []
    if (sql.includes('FROM cgov_policy_account WHERE customer_id')) return this.account ? [{ ...this.account }] : []
    if (sql.startsWith('INSERT INTO cgov_policy_account')) {
      this.account = { id: ACCOUNT_ID, customer_id: p[0], policy_id: p[1], component_id: p[2], account_ref: p[3], regions: p[4], active_run_id: null, applied_at: null, created_at: new Date() }
      return [{ ...this.account }]
    }
    if (sql.startsWith('INSERT INTO cgov_run ')) {
      const run = { id: p[0], customer_id: p[1], policy_id: p[2], policy_account_id: p[3], component_id: p[4], kind: p[5], enforcement: p[6], action_class: p[7],
        status: 'queued', evaluation: null, counts: {}, message: null, requested_by: p[8], command_payload: JSON.parse(p[9]), dispatched_at: null,
        created_at: new Date(), started_at: null, finished_at: null }
      this.runs.push(run)
      return [{ ...run }]
    }
    if (sql.startsWith('SELECT id, command_payload FROM cgov_run')) {
      const run = this.run(p[0])
      return run && ['queued', 'running'].includes(run.status) ? [{ id: run.id, command_payload: run.command_payload }] : []
    }
    if (sql.startsWith('SELECT * FROM cgov_run WHERE id')) { const run = this.run(p[0]); return run ? [{ ...run }] : [] }
    if (sql.startsWith('SELECT a.* FROM cgov_policy_account a')) return this.run(p[0]) && this.account ? [{ ...this.account }] : []
    if (sql.startsWith('SELECT id FROM cgov_run')) {
      return this.runs.filter(r => r.command_payload && !r.started_at && (r.status === 'queued' || (r.status === 'running' && this.stale))).map(r => ({ id: r.id }))
    }
    return []
  }
  async $executeRawUnsafe(sql: string, ...p: any[]): Promise<number> {
    if (sql.startsWith('UPDATE cgov_policy_account SET active_run_id = $2')) this.account.active_run_id = p[1]
    else if (sql.startsWith('UPDATE cgov_policy_account SET active_run_id = NULL')) {
      this.account.active_run_id = null
      if (p[1] === true) this.account.applied_at = 'now'
    } else if (sql.startsWith('UPDATE cgov_run SET dispatched_at')) {
      const run = this.run(p[0]); run.dispatched_at = 'now'; if (run.status === 'queued') run.status = 'running'
    } else if (sql.startsWith('UPDATE cgov_run SET status')) {
      const run = this.run(p[0])
      Object.assign(run, { status: p[2], evaluation: p[3] ?? run.evaluation, message: p[4] ?? run.message, counts: p[5] ? JSON.parse(p[5]) : run.counts })
      if (p[2] === 'running') run.started_at = run.started_at ?? 'now'
      if (p[7]) run.finished_at = 'now'
    } else if (sql.startsWith('INSERT INTO cgov_run_match')) {
      let added = 0
      for (const m of JSON.parse(p[2])) {
        if (this.matches.some(x => x.run_id === p[1] && x.resource_id === m.resource_id)) continue
        this.matches.push({ run_id: p[1], ...m }); added++
      }
      return added
    } else if (sql.startsWith('INSERT INTO cgov_run_action')) {
      const existing = this.actions.find(a => a.run_id === p[1] && a.resource_id === p[2] && a.action === p[3])
      if (existing) Object.assign(existing, { outcome: p[4], message: p[5] })
      else this.actions.push({ run_id: p[1], resource_id: p[2], action: p[3], outcome: p[4], message: p[5] })
    }
    return 1
  }
}

function context(db = new StateDb()) {
  const published: Array<{ topic: string; payload: any }> = []
  const ctx: any = { db, appId: 'cloud-governance', customerId: CUSTOMER, events: { publish: async (topic: string, payload: any) => { published.push({ topic, payload }) } } }
  return { db, ctx, published }
}

const request = (ctx: any, extra: object = {}) => requestRun(ctx, CUSTOMER, { policyId: POLICY_ID, componentId: COMPONENT, kind: 'enforce', requestedBy: null, ...extra })
const status = (runId: string, value: RunStatus, extra: object = {}): RunStatusPayload => ({ runId, policyId: POLICY_ID, status: value, ...extra })

test('request creates a run with a persisted payload, sets the active id and dispatches', async () => {
  const t = context(); const { run, dispatchPending } = await request(t.ctx)
  assert.equal(dispatchPending, false); assert.equal(run.status, 'running')
  assert.equal(t.db.account.active_run_id, run.id); assert.equal(t.db.runs[0].command_payload.maxResources, 25); assert.deepEqual(t.db.runs[0].command_payload.ownerTagKeys, ['Owner'])
  assert.equal(t.db.runs[0].command_payload.compiledYaml, 'policies: []')
  assert.equal(t.published[0].topic, RUN_REQUESTED); assert.equal(t.published[0].payload.runId, run.id)
})
test('an overlapping request is rejected without publishing', async () => {
  const t = context(); await request(t.ctx)
  await assert.rejects(() => request(t.ctx), /already in progress/)
  assert.equal(t.published.length, 1); assert.equal(t.db.runs.length, 1)
})
test('a policy without compiled yaml cannot run', async () => {
  const t = context(); t.db.policy.compiled_yaml = null
  await assert.rejects(() => request(t.ctx), (e: any) => e.statusCode === 400 && /compiled/.test(e.message))
  assert.equal(t.db.runs.length, 0); assert.equal(t.published.length, 0)
})
test('preview forces observe even on an observe-only policy', async () => {
  const t = context(); t.db.policy.enforcement = 'observe'
  await request(t.ctx, { kind: 'preview', enforcement: 'auto' })
  assert.equal(t.db.runs[0].enforcement, 'observe'); assert.equal(t.db.runs[0].command_payload.kind, 'preview')
})
test('enforce is rejected on an observe-only policy and above the policy level', async () => {
  const t = context(); t.db.policy.enforcement = 'observe'
  await assert.rejects(() => request(t.ctx), (e: any) => e.statusCode === 400)
  t.db.policy.enforcement = 'notify'
  await assert.rejects(() => request(t.ctx, { enforcement: 'auto' }), (e: any) => e.statusCode === 400)
  assert.equal(t.db.runs.length, 0)
})
test('enforce is refused with 409 for ask policies and irreversible actions, but a preview still runs', async () => {
  const t = context(); t.db.policy.enforcement = 'ask'
  await assert.rejects(() => request(t.ctx), (e: any) => e.statusCode === 409 && /approval gate/.test(e.message))
  t.db.policy.enforcement = 'auto'; t.db.policy.action_class = 'irreversible'
  await assert.rejects(() => request(t.ctx), (e: any) => e.statusCode === 409 && /Irreversible/.test(e.message))
  assert.equal(t.db.runs.length, 0)
  await request(t.ctx, { kind: 'preview' }); assert.equal(t.db.runs.length, 1)
})
test('auto enforcement is allowed for snapshot-delete actions', async () => {
  const t = context(); t.db.policy.action_class = 'snapshot-delete'
  await request(t.ctx); assert.equal(t.db.runs[0].enforcement, 'auto')
})
test('unknown policy is a 404', async () => {
  const t = context()
  await assert.rejects(() => requestRun(t.ctx, CUSTOMER, { policyId: 'other', componentId: COMPONENT, kind: 'preview' }), (e: any) => e.statusCode === 404)
})
test('broker failure leaves the run queued and reconcile dispatches it later', async () => {
  const t = context(); t.ctx.events.publish = async () => { throw new Error('broker offline') }
  const { run, dispatchPending } = await request(t.ctx)
  assert.equal(dispatchPending, true); assert.equal(run.status, 'queued'); assert.equal(t.db.account.active_run_id, run.id)
  await assert.rejects(() => request(t.ctx), /already in progress/)
  t.ctx.events.publish = async (topic: string, payload: any) => { t.published.push({ topic, payload }) }
  assert.equal(await reconcile(t.ctx, CUSTOMER), 1)
  assert.equal(t.db.runs[0].status, 'running'); assert.equal(t.published[0].payload.runId, run.id)
})
test('reconcile re-dispatches a stale running run that never started', async () => {
  const t = context(); const { run } = await request(t.ctx); t.published.length = 0
  assert.equal(await reconcile(t.ctx, CUSTOMER), 0)
  t.db.stale = true
  assert.equal(await reconcile(t.ctx, CUSTOMER), 1); assert.equal(t.published[0].payload.runId, run.id)
})
test('a late event from an older run changes nothing', async () => {
  const t = context(); await request(t.ctx)
  await handleRunnerEvent(t.ctx, RUN_STATUS, status('old-run', 'succeeded'))
  await handleRunnerEvent(t.ctx, RUN_MATCH, { runId: 'old-run', policyId: POLICY_ID, resources: [{ resourceId: 'i-1', resourceType: 'ec2', region: 'us-east-1' }] })
  assert.equal(t.db.runs[0].status, 'running'); assert.equal(t.db.matches.length, 0)
  assert.equal(t.db.account.active_run_id, t.db.runs[0].id)
})
test('matches and actions are recorded idempotently', async () => {
  const t = context(); const { run } = await request(t.ctx)
  const match = { runId: run.id, policyId: POLICY_ID, resources: [{ resourceId: 'i-1', resourceType: 'ec2', region: 'us-east-1' }, { resourceId: 'i-2', resourceType: 'ec2', region: 'us-east-1' }] }
  await handleRunnerEvent(t.ctx, RUN_MATCH, match); await handleRunnerEvent(t.ctx, RUN_MATCH, match)
  assert.equal(t.db.matches.length, 2)
  const action: RunActionPayload = { runId: run.id, policyId: POLICY_ID, resourceId: 'i-1', action: 'stop', outcome: 'failed', message: 'denied', at: new Date().toISOString() }
  await handleRunnerEvent(t.ctx, RUN_ACTION, action)
  await handleRunnerEvent(t.ctx, RUN_ACTION, { ...action, outcome: 'applied', message: null })
  assert.equal(t.db.actions.length, 1); assert.equal(t.db.actions[0].outcome, 'applied')
})
test('running marks started, terminal clears the active id and a second terminal is ignored', async () => {
  const t = context(); const { run } = await request(t.ctx)
  await handleRunnerEvent(t.ctx, RUN_STATUS, status(run.id, 'running'))
  assert.equal(t.db.runs[0].started_at, 'now'); assert.equal(t.db.account.active_run_id, run.id)
  await handleRunnerEvent(t.ctx, RUN_STATUS, status(run.id, 'succeeded', { evaluation: 'evaluated', counts: { matched: 2 }, message: 'done' }))
  assert.equal(t.db.runs[0].status, 'succeeded'); assert.deepEqual(t.db.runs[0].counts, { matched: 2 })
  assert.equal(t.db.account.active_run_id, null); assert.equal(t.db.account.applied_at, 'now')
  await handleRunnerEvent(t.ctx, RUN_STATUS, status(run.id, 'failed', { message: 'late' }))
  assert.equal(t.db.runs[0].status, 'succeeded'); assert.equal(t.db.runs[0].message, 'done')
  await request(t.ctx)
  assert.equal(t.db.runs.length, 2)
})
test('a failed run does not set applied_at and frees the account', async () => {
  const t = context(); const { run } = await request(t.ctx)
  await handleRunnerEvent(t.ctx, RUN_STATUS, status(run.id, 'failed', { evaluation: 'not-visible' }))
  assert.equal(t.db.account.active_run_id, null); assert.equal(t.db.account.applied_at, null); assert.equal(t.db.runs[0].evaluation, 'not-visible')
})
test('cancel publishes a request and only the runner confirmation cancels', async () => {
  const t = context(); const { run } = await request(t.ctx); t.published.length = 0
  await cancelRun(t.ctx, CUSTOMER, run.id)
  assert.equal(t.published[0].topic, RUN_CANCEL_REQUESTED); assert.equal(t.published[0].payload.runId, run.id)
  assert.equal(t.db.runs[0].status, 'running'); assert.equal(t.db.account.active_run_id, run.id)
  await handleRunnerEvent(t.ctx, RUN_STATUS, status(run.id, 'cancelled'))
  assert.equal(t.db.runs[0].status, 'cancelled'); assert.equal(t.db.account.active_run_id, null)
  await assert.rejects(() => cancelRun(t.ctx, CUSTOMER, run.id), /already finished/)
})
test('a run never dispatched is cancelled locally so the account is not stuck', async () => {
  const t = context(); t.ctx.events.publish = async () => { throw new Error('broker offline') }
  const { run } = await request(t.ctx)
  t.ctx.events.publish = async (topic: string, payload: any) => { t.published.push({ topic, payload }) }
  const cancelled = await cancelRun(t.ctx, CUSTOMER, run.id)
  assert.equal(cancelled.status, 'cancelled'); assert.equal(t.db.account.active_run_id, null); assert.equal(t.published.length, 0)
})
