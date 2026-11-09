import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import getStatus from '../getStatus'
import policyDeploy from '../../policies/deploy'
import { COMPONENT, CUSTOMER, createFakeDb, ctxFor, goodPolicyFields, item } from '../../lib/__tests__/fakeDb'

const exc = item({ policy: 'stopped-ec2', resourceId: 'i-0abc', reason: 'legacy host', approver: 'sec@example.com', expiresAt: '2999-01-01' }, 'e1')

async function seeded() {
  const db = createFakeDb()
  await policyDeploy(ctxFor([item(goodPolicyFields)], db))
  return db
}

test('validate accepts a good exception', async () => {
  const res = await validate(ctxFor([exc]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate reports each missing or malformed field', async () => {
  const res = await validate(ctxFor([item({ policy: 'Bad', resourceId: '', reason: '', approver: '', expiresAt: 'tomorrow' }, 'x')]))
  const codes = res.errors.map((e) => e.code)
  for (const code of ['NAME_INVALID', 'RESOURCE_ID_INVALID', 'REASON_REQUIRED', 'APPROVER_REQUIRED', 'EXPIRES_AT_INVALID']) {
    assert.ok(codes.includes(code), code)
  }
})

test('validate warns on an already expired exception and rejects duplicates of (policy, resource)', async () => {
  const expired = await validate(ctxFor([item({ ...exc.fields, expiresAt: '2000-01-01' }, 'e')]))
  assert.equal(expired.valid, true)
  assert.equal(expired.warnings[0].code, 'EXCEPTION_EXPIRED')
  const dup = await validate(ctxFor([exc, item({ ...exc.fields }, 'e2')]))
  assert.ok(dup.errors.some((e) => e.code === 'DUPLICATE_ITEM'))
})

test('deploy stores the exception and recompiles the policy so the filter reaches its YAML', async () => {
  const db = await seeded()
  assert.doesNotMatch(db.tables.policies[0].compiled_yaml, /i-0abc/)
  const res = await deploy(ctxFor([exc], db))
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.exceptions[0].customer_id, CUSTOMER)
  assert.equal(db.tables.exceptions[0].resource_id, 'i-0abc')
  assert.match(db.tables.policies[0].compiled_yaml, /i-0abc/)
  assert.deepEqual((res.artifacts as any).recompiled, ['stopped-ec2'])
})

test('deploy is idempotent per (policy, resource) and keeps one row', async () => {
  const db = await seeded()
  await deploy(ctxFor([exc], db))
  await deploy(ctxFor([item({ ...exc.fields, reason: 'new reason' }, 'e1')], db))
  assert.equal(db.tables.exceptions.length, 1)
  assert.equal(db.tables.exceptions[0].reason, 'new reason')
})

test('deploy for a policy that is not registered yet warns but succeeds', async () => {
  const db = createFakeDb()
  const res = await deploy(ctxFor([exc], db))
  assert.equal(res.success, true)
  assert.match(((res.artifacts as any).warnings as string[])[0], /not registered yet/)
})

test('deploy fails on an invalid exception and without the store', async () => {
  assert.equal((await deploy(ctxFor([item({ policy: 'x' }, 'bad')], createFakeDb()))).success, false)
  assert.equal((await deploy(ctxFor([exc]))).success, false)
})

test('rollback deletes a created exception and recompiles the policy without it', async () => {
  const db = await seeded()
  const dep = await deploy(ctxFor([exc], db))
  const res = await rollback({ ...ctxFor([exc], db), rollbackData: dep.rollbackData })
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.exceptions.length, 0)
  assert.doesNotMatch(db.tables.policies[0].compiled_yaml, /i-0abc/)
})

test('rollback restores a replaced exception', async () => {
  const db = await seeded()
  await deploy(ctxFor([exc], db))
  const dep = await deploy(ctxFor([item({ ...exc.fields, reason: 'changed' }, 'e1')], db))
  await rollback({ ...ctxFor([exc], db), rollbackData: dep.rollbackData })
  assert.equal(db.tables.exceptions[0].reason, 'legacy host')
})

test('rollback without recorded data fails', async () => {
  assert.equal((await rollback({ ...ctxFor([exc], createFakeDb()), rollbackData: 'nope' })).success, false)
})

test('driftDetect: clean after deploy, then per-field drift and a missing exception', async () => {
  const db = await seeded()
  await deploy(ctxFor([exc], db))
  assert.deepEqual((await driftDetect(ctxFor([exc], db))).diffs, [])
  db.tables.exceptions[0].approver = 'someone-else'
  db.tables.exceptions[0].expires_at = '2998-01-01'
  const fields = (await driftDetect(ctxFor([exc], db))).diffs.map((d) => d.field)
  assert.deepEqual(fields.sort(), ['stopped-ec2/i-0abc.approver', 'stopped-ec2/i-0abc.expiresAt'])
  db.tables.exceptions.length = 0
  assert.equal((await driftDetect(ctxFor([exc], db))).diffs[0].severity, 'critical')
})

test('driftDetect is unchecked without a store', async () => {
  assert.equal((await driftDetect(ctxFor([exc]))).checked, false)
})

test('healthCheck counts expired exceptions', async () => {
  const db = await seeded()
  await deploy(ctxFor([exc], db))
  assert.equal((await healthCheck(ctxFor([exc], db))).score, 100)
  db.tables.exceptions[0].expires_at = '2000-01-01'
  const res = await healthCheck(ctxFor([exc], db))
  assert.equal(res.healthy, false)
  assert.match(res.checks.find((c) => c.name === 'No expired exceptions')?.message ?? '', /1 expired/)
})

test('getStatus is tenant-wide: deployed once stored, unhealthy when expired', async () => {
  const db = await seeded()
  const ctx = () => ({
    ...ctxFor([exc], db),
    platform: { getLatestDeployment: async () => ({ completedAt: 'x', startedAt: 'x', healthScore: 100 }), listComponents: async () => [COMPONENT] },
  }) as any
  assert.equal((await getStatus(ctx())).componentStatuses[0].deployed, false)
  await deploy(ctxFor([exc], db))
  assert.equal((await getStatus(ctx())).componentStatuses[0].healthy, true)
  db.tables.exceptions[0].expires_at = '2000-01-01'
  assert.equal((await getStatus(ctx())).componentStatuses[0].healthy, false)
})
