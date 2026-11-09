import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import getStatus from '../getStatus'
import options from '../options'
import policyDeploy from '../../policies/deploy'
import { COMPONENT, CUSTOMER, createFakeDb, ctxFor, goodPolicyFields, item } from '../../lib/__tests__/fakeDb'

const pack = item({ name: 'cost-hygiene', description: 'd', policies: ['stopped-ec2', 'idle-ebs'] })

async function seeded() {
  const db = createFakeDb()
  const members = [item(goodPolicyFields), item({ ...goodPolicyFields, name: 'idle-ebs', resource: 'ebs' })]
  const res = await policyDeploy(ctxFor(members, db))
  assert.equal(res.success, true, res.message)
  db.tables.accounts.length = 0
  return db
}

test('validate accepts a pack and rejects shape errors and duplicates', async () => {
  assert.equal((await validate(ctxFor([pack]))).valid, true)
  const bad = await validate(ctxFor([
    item({ name: 'BAD', policies: [] }, 'a'),
    item({ name: 'dup', policies: ['x', 'x'] }, 'b'),
    item({ name: 'dup', policies: ['x'] }, 'c'),
  ]))
  assert.equal(bad.valid, false)
  assert.ok(bad.errors.some((e) => e.code === 'NAME_INVALID'))
  assert.ok(bad.errors.some((e) => e.code === 'PACK_POLICIES_INVALID'))
  assert.ok(bad.errors.some((e) => e.code === 'PACK_POLICY_DUPLICATE'))
  assert.ok(bad.errors.some((e) => e.code === 'DUPLICATE_ITEM'))
})

test('validate rejects an empty canvas', async () => {
  assert.equal((await validate(ctxFor([]))).errors[0].code, 'EMPTY')
})

test('deploy registers every member for the account and returns the compiled pack document', async () => {
  const db = await seeded()
  const res = await deploy(ctxFor([pack], db))
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.accounts.length, 2)
  assert.ok(db.tables.accounts.every((a) => a.component_id === COMPONENT.id))
  const yaml = (res.artifacts as any).compiledYaml['cost-hygiene']
  assert.match(yaml, /name: "stopped-ec2"/)
  assert.match(yaml, /name: "idle-ebs"/)
  assert.equal(db.tables.policies.length, 2)
})

test('deploy fails when a member policy does not exist and registers nothing', async () => {
  const db = await seeded()
  const res = await deploy(ctxFor([item({ name: 'p', policies: ['stopped-ec2', 'ghost'] })], db))
  assert.equal(res.success, false)
  assert.match(res.message, /ghost/)
  assert.equal(db.tables.accounts.length, 0)
})

test('deploy preserves regions already set on a member link', async () => {
  const db = await seeded()
  await policyDeploy(ctxFor([item({ ...goodPolicyFields, regions: ['eu-west-1'] })], db))
  await deploy(ctxFor([item({ name: 'p', policies: ['stopped-ec2'] })], db))
  assert.deepEqual(db.tables.accounts.find((a) => a.policy_id === db.tables.policies[0].id)?.regions, ['eu-west-1'])
})

test('deploy fails without the store', async () => {
  assert.equal((await deploy(ctxFor([pack]))).success, false)
})

test('rollback unregisters only the links the deploy added', async () => {
  const db = await seeded()
  await policyDeploy(ctxFor([item(goodPolicyFields)], db))
  const dep = await deploy(ctxFor([pack], db))
  assert.equal(db.tables.accounts.length, 2)
  const res = await rollback({ ...ctxFor([pack], db), rollbackData: dep.rollbackData })
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.accounts.length, 1)
  assert.equal(db.tables.accounts[0].policy_id, db.tables.policies.find((p) => p.name === 'stopped-ec2')?.id)
})

test('rollback without recorded data fails', async () => {
  assert.equal((await rollback({ ...ctxFor([pack], createFakeDb()), rollbackData: undefined })).success, false)
})

test('driftDetect: clean after deploy, drifting when a member is unregistered or removed', async () => {
  const db = await seeded()
  await deploy(ctxFor([pack], db))
  assert.deepEqual((await driftDetect(ctxFor([pack], db))).diffs, [])
  db.tables.accounts.length = 0
  const unregistered = await driftDetect(ctxFor([pack], db))
  assert.equal(unregistered.hasDrift, true)
  assert.ok(unregistered.diffs.every((d) => d.severity === 'critical'))
  db.tables.policies.length = 0
  assert.ok((await driftDetect(ctxFor([pack], db))).diffs.some((d) => d.field === 'cost-hygiene.stopped-ec2'))
})

test('driftDetect is unchecked without a store', async () => {
  assert.equal((await driftDetect(ctxFor([pack]))).checked, false)
})

test('healthCheck scores members across the pack', async () => {
  const db = await seeded()
  await deploy(ctxFor([pack], db))
  assert.equal((await healthCheck(ctxFor([pack], db))).score, 100)
  db.tables.policies[0].compiled_yaml = null
  const res = await healthCheck(ctxFor([pack], db))
  assert.equal(res.score, 75)
  assert.match(res.checks.find((c) => !c.passed)?.message ?? '', /cost-hygiene\/stopped-ec2/)
})

test('getStatus follows member registration', async () => {
  const db = await seeded()
  const ctx = (deployed: boolean) => ({
    ...ctxFor([pack], db),
    platform: {
      getLatestDeployment: async () => (deployed ? { completedAt: 'x', startedAt: 'x', healthScore: 100 } : null),
      listComponents: async () => [COMPONENT],
    },
  })
  assert.equal((await getStatus(ctx(true) as any)).componentStatuses[0].deployed, false)
  await deploy(ctxFor([pack], db))
  assert.equal((await getStatus(ctx(true) as any)).componentStatuses[0].healthy, true)
})

test('options lists tenant policies filtered by query, and is empty without a store', async () => {
  const db = await seeded()
  const base = { appId: 'cloud-governance', customerId: CUSTOMER, configTypeId: 'policy-packs', source: 'policies', component: null, credential: null, settings: {} }
  const all = await options({ ...base, db } as any)
  assert.deepEqual(all.map((o) => o.value), ['idle-ebs', 'stopped-ec2'])
  assert.equal(all[0].description, 'ebs - auto')
  assert.deepEqual((await options({ ...base, db, query: 'ec2' } as any)).map((o) => o.value), ['stopped-ec2'])
  assert.deepEqual(await options(base as any), [])
})
