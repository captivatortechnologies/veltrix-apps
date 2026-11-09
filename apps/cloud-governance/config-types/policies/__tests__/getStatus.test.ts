import { test } from 'node:test'
import assert from 'node:assert/strict'
import getStatus from '../getStatus'
import deploy from '../deploy'
import { COMPONENT, createFakeDb, ctxFor, goodPolicyFields, item } from '../../lib/__tests__/fakeDb'

const good = item(goodPolicyFields)

function withPlatform(ctx: any, deployed: boolean) {
  ctx.platform = {
    getLatestDeployment: async () => (deployed ? { id: 'd', completedAt: '2026-01-01T00:00:00Z', startedAt: '2026-01-01T00:00:00Z', healthScore: 100 } : null),
    listComponents: async () => [COMPONENT],
  }
  return ctx
}

test('getStatus is not deployed when no deployment succeeded', async () => {
  const res = await getStatus(withPlatform(ctxFor([good], createFakeDb()), false))
  assert.equal(res.deployed, false)
  assert.deepEqual(res.componentStatuses, [])
})

test('getStatus reports deployed and healthy once the policy is registered and compiled', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  const res = await getStatus(withPlatform(ctxFor([good], db), true))
  assert.equal(res.deployed, true)
  assert.equal(res.componentStatuses[0].deployed, true)
  assert.equal(res.componentStatuses[0].healthy, true)
})

test('getStatus reports not deployed for an account where the policy is not registered', async () => {
  const res = await getStatus(withPlatform(ctxFor([good], createFakeDb()), true))
  assert.equal(res.componentStatuses[0].deployed, false)
  assert.equal(res.deployed, false)
})

test('getStatus marks an account unhealthy when the last run failed', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  db.tables.runs.push({ id: 'r', customer_id: '00000000-0000-4000-8000-000000000001', policy_id: db.tables.policies[0].id, status: 'failed', counts: {} })
  const res = await getStatus(withPlatform(ctxFor([good], db), true))
  assert.equal(res.componentStatuses[0].healthy, false)
})
