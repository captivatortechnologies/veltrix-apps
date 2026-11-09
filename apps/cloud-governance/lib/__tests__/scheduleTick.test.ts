import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runDueSchedules, scheduledRunFor } from '../schedule/tick'
import type { RequestRunInput } from '../runLifecycle'

const CUSTOMER = '00000000-0000-4000-8000-000000000001'
const NOW = new Date('2026-11-09T06:00:30Z')
const POLICY = { id: 'p1', customer_id: CUSTOMER, name: 'stopped-ec2', enforcement: 'auto', action_class: 'reversible', version: 1, model: {}, compiled_yaml: 'y', created_at: NOW, updated_at: NOW }

class ScheduleDb {
  schedules: any[] = []
  policies: any[] = [POLICY]
  accounts: any[] = [{ id: 'a1', customer_id: CUSTOMER, policy_id: 'p1', component_id: 'c1', regions: [], created_at: NOW }, { id: 'a2', customer_id: CUSTOMER, policy_id: 'p1', component_id: 'c2', regions: [], created_at: NOW }]
  statements: Array<{ sql: string; params: any[] }> = []
  async $queryRawUnsafe(sql: string, ...p: any[]): Promise<any[]> {
    if (sql.startsWith('SELECT * FROM cgov_schedule')) return this.schedules.filter(s => s.customer_id === p[0] && (!p[1] || s.enabled)).map(s => ({ ...s }))
    if (sql.startsWith('SELECT * FROM cgov_policy WHERE customer_id')) return this.policies.filter(x => x.name === p[1])
    if (sql.startsWith('SELECT * FROM cgov_policy_account')) return this.accounts.filter(a => a.policy_id === p[1])
    throw new Error(`unhandled ${sql}`)
  }
  async $executeRawUnsafe(sql: string, ...p: any[]): Promise<number> {
    this.statements.push({ sql, params: p })
    const row = this.schedules.find(s => s.id === p[0])
    if (!row) return 0
    if (sql.includes('next_run_at IS NULL')) {
      if (row.next_run_at) return 0
      row.next_run_at = p[2]; return 1
    }
    if (sql.includes('next_run_at <= $3')) {
      if (!row.enabled || !row.next_run_at || Date.parse(row.next_run_at) > Date.parse(p[2])) return 0
      row.last_run_at = p[2]; row.next_run_at = p[3]; return 1
    }
    throw new Error(`unhandled ${sql}`)
  }
}

const schedule = (extra: object = {}) => ({ id: 's1', customer_id: CUSTOMER, canvas_id: null, policy_name: 'stopped-ec2', cron: '0 6 * * *', enabled: true, enforcement: 'auto', last_run_at: null, next_run_at: '2026-11-09T06:00:00.000Z', created_at: NOW, updated_at: NOW, ...extra })

function harness(rows: any[]) {
  const db = new ScheduleDb(); db.schedules = rows
  const requests: RequestRunInput[] = []
  const ctx: any = { db, appId: 'cloud-governance', events: { publish: async () => {} } }
  const request = async (_ctx: any, _customer: string, input: RequestRunInput) => { requests.push(input); return { run: { id: 'r' } as any, dispatchPending: false } }
  return { db, ctx, requests, request }
}

test('scheduledRunFor maps enforcement to Phase 0 run kinds', () => {
  assert.deepEqual(scheduledRunFor('auto'), { kind: 'enforce', enforcement: 'auto' })
  assert.equal(scheduledRunFor('ask').kind, 'preview'); assert.match(scheduledRunFor('ask').note ?? '', /approval gate/)
  assert.deepEqual(scheduledRunFor('observe'), { kind: 'preview' }); assert.deepEqual(scheduledRunFor('notify'), { kind: 'preview' })
})

test('a due schedule is claimed once, fires one run per account and is rescheduled', async () => {
  const t = harness([schedule()])
  const report = await runDueSchedules(t.ctx, CUSTOMER, NOW, t.request)
  assert.deepEqual({ fired: report.fired, requested: report.requested, armed: report.armed }, { fired: 1, requested: 2, armed: 0 })
  assert.deepEqual(t.requests.map(r => [r.componentId, r.kind, r.enforcement, r.requestedBy]), [['c1', 'enforce', 'auto', 'schedule:stopped-ec2'], ['c2', 'enforce', 'auto', 'schedule:stopped-ec2']])
  assert.equal(t.db.schedules[0].next_run_at, '2026-11-10T06:00:00.000Z'); assert.equal(t.db.schedules[0].last_run_at, NOW.toISOString())
  const again = await runDueSchedules(t.ctx, CUSTOMER, NOW, t.request)
  assert.equal(again.fired, 0); assert.equal(t.requests.length, 2)
})

test('an unarmed schedule is armed on its first tick and not fired', async () => {
  const t = harness([schedule({ next_run_at: null })])
  const report = await runDueSchedules(t.ctx, CUSTOMER, NOW, t.request)
  assert.deepEqual([report.armed, report.fired, t.requests.length], [1, 0, 0])
  assert.equal(t.db.schedules[0].next_run_at, '2026-11-10T06:00:00.000Z')
})

test('schedules that are not yet due, disabled, or ask-level behave as documented', async () => {
  const t = harness([
    schedule({ id: 's1', next_run_at: '2026-11-09T07:00:00.000Z' }),
    schedule({ id: 's2', policy_name: 'other', enabled: false }),
    schedule({ id: 's3', enforcement: 'ask' }),
  ])
  const report = await runDueSchedules(t.ctx, CUSTOMER, NOW, t.request)
  assert.equal(report.fired, 1)
  assert.deepEqual(t.requests.map(r => r.kind), ['preview', 'preview'])
  assert.ok(report.skipped.some(s => /approval gate/.test(s)))
})

test('a schedule whose policy vanished or whose requests fail is reported, not thrown', async () => {
  const t = harness([schedule({ id: 's1', policy_name: 'gone' }), schedule({ id: 's2' })])
  const failing = async () => { throw Object.assign(new Error('A run is already in progress'), { statusCode: 409 }) }
  const report = await runDueSchedules(t.ctx, CUSTOMER, NOW, failing)
  assert.equal(report.fired, 2); assert.equal(report.requested, 0)
  assert.ok(report.skipped.some(s => /no longer registered/.test(s)))
  assert.equal(report.skipped.filter(s => /already in progress/.test(s)).length, 2)
  assert.equal(t.db.schedules[1].next_run_at, '2026-11-10T06:00:00.000Z')
})
