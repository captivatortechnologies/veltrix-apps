import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import getStatus from '../getStatus'
import { clampEnforcement } from '../_shared'
import policyDeploy from '../../policies/deploy'
import { COMPONENT, createFakeDb, ctxFor, goodPolicyFields, item } from '../../lib/__tests__/fakeDb'

const sched = item({ policy: 'stopped-ec2', cron: '0 6 * * 1', enabled: true, enforcement: 'ask' }, 's1')

async function seeded(enforcement = 'auto') {
  const db = createFakeDb()
  await policyDeploy(ctxFor([item({ ...goodPolicyFields, enforcement })], db))
  return db
}

test('clampEnforcement never exceeds the ceiling', () => {
  assert.deepEqual(clampEnforcement('auto', 'ask'), { enforcement: 'ask', clamped: true })
  assert.deepEqual(clampEnforcement('observe', 'auto'), { enforcement: 'observe', clamped: false })
  assert.deepEqual(clampEnforcement('ask', 'ask'), { enforcement: 'ask', clamped: false })
})

test('validate accepts a good schedule', async () => {
  assert.equal((await validate(ctxFor([sched]))).valid, true)
})

test('validate rejects bad cron, enforcement and policy, and duplicate policies', async () => {
  const bad = await validate(ctxFor([item({ policy: 'Bad', cron: '* * *', enabled: true, enforcement: 'yolo' }, 'x')]))
  const codes = bad.errors.map((e) => e.code)
  for (const code of ['NAME_INVALID', 'CRON_INVALID', 'ENFORCEMENT_INVALID']) assert.ok(codes.includes(code), code)
  const dup = await validate(ctxFor([sched, item({ ...sched.fields, cron: '0 7 * * 1' }, 's2')]))
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_ITEM'))
  assert.equal((await validate(ctxFor([]))).errors[0].code, 'EMPTY')
})

test('validate treats a missing enabled flag as enabled', async () => {
  const res = await validate(ctxFor([item({ policy: 'stopped-ec2', cron: '*/5 * * * *', enforcement: 'observe' }, 's')]))
  assert.equal(res.valid, true)
})

test('deploy stores the schedule and normalises the cron', async () => {
  const db = await seeded()
  const res = await deploy(ctxFor([item({ ...sched.fields, cron: '0   6 * *  1' }, 's1')], db))
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.schedules[0].cron, '0 6 * * 1')
  assert.equal(db.tables.schedules[0].enforcement, 'ask')
  assert.doesNotMatch(res.message, /clamped/)
})

test('deploy clamps enforcement to the policy and says so', async () => {
  const db = await seeded('observe')
  const res = await deploy(ctxFor([sched], db))
  assert.equal(res.success, true)
  assert.equal(db.tables.schedules[0].enforcement, 'observe')
  assert.match(res.message, /clamped.*ask lowered to observe/)
  assert.deepEqual((res.artifacts as any).clamped, ['stopped-ec2: ask lowered to observe'])
})

test('deploy refuses a schedule for an unregistered policy and fails without a store', async () => {
  const res = await deploy(ctxFor([sched], createFakeDb()))
  assert.equal(res.success, false)
  assert.match(res.message, /not registered/)
  assert.equal((await deploy(ctxFor([sched]))).success, false)
})

test('rollback deletes a created schedule', async () => {
  const db = await seeded()
  const dep = await deploy(ctxFor([sched], db))
  const res = await rollback({ ...ctxFor([sched], db), rollbackData: dep.rollbackData })
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.schedules.length, 0)
})

test('rollback restores a replaced schedule', async () => {
  const db = await seeded()
  await deploy(ctxFor([sched], db))
  const dep = await deploy(ctxFor([item({ ...sched.fields, cron: '0 9 * * *', enabled: false }, 's1')], db))
  await rollback({ ...ctxFor([sched], db), rollbackData: dep.rollbackData })
  assert.equal(db.tables.schedules[0].cron, '0 6 * * 1')
  assert.equal(db.tables.schedules[0].enabled, true)
})

test('rollback without recorded data fails', async () => {
  assert.equal((await rollback({ ...ctxFor([sched], createFakeDb()), rollbackData: {} })).success, false)
})

test('driftDetect: clean after deploy (clamp-aware), then field drift and a missing schedule', async () => {
  const db = await seeded('observe')
  await deploy(ctxFor([sched], db))
  assert.deepEqual((await driftDetect(ctxFor([sched], db))).diffs, [])
  db.tables.schedules[0].cron = '0 1 * * *'
  db.tables.schedules[0].enabled = false
  db.tables.schedules[0].enforcement = 'auto'
  const fields = (await driftDetect(ctxFor([sched], db))).diffs.map((d) => d.field).sort()
  assert.deepEqual(fields, ['stopped-ec2.cron', 'stopped-ec2.enabled', 'stopped-ec2.enforcement'])
  db.tables.schedules.length = 0
  assert.equal((await driftDetect(ctxFor([sched], db))).diffs[0].severity, 'critical')
})

test('driftDetect is unchecked without a store', async () => {
  assert.equal((await driftDetect(ctxFor([sched]))).checked, false)
})

test('healthCheck passes when healthy and flags overreach, disabled and orphaned schedules', async () => {
  const db = await seeded()
  await deploy(ctxFor([sched], db))
  assert.equal((await healthCheck(ctxFor([sched], db))).score, 100)
  db.tables.schedules[0].enforcement = 'auto'
  db.tables.policies[0].enforcement = 'observe'
  db.tables.schedules[0].enabled = false
  const res = await healthCheck(ctxFor([sched], db))
  assert.equal(res.score, 50)
  db.tables.policies.length = 0
  assert.equal((await healthCheck(ctxFor([sched], db))).checks.find((c) => c.name === 'Policies exist')?.passed, false)
})

test('getStatus reflects stored, enabled schedules', async () => {
  const db = await seeded()
  const ctx = () => ({
    ...ctxFor([sched], db),
    platform: { getLatestDeployment: async () => ({ completedAt: 'x', startedAt: 'x', healthScore: 100 }), listComponents: async () => [COMPONENT] },
  }) as any
  assert.equal((await getStatus(ctx())).componentStatuses[0].deployed, false)
  await deploy(ctxFor([sched], db))
  assert.equal((await getStatus(ctx())).componentStatuses[0].healthy, true)
})
