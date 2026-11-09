import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deletePolicyAccountsForComponent, addAction, addMatches, listActiveExceptions, listRuns, upsertPolicy, upsertPolicyAccount, upsertSchedule } from '../db'

const CUSTOMER = '00000000-0000-4000-8000-000000000001'

function recorder(rows: any[] = [{}]) {
  const calls: Array<{ sql: string; params: any[] }> = []
  const db: any = {
    $queryRawUnsafe: async (sql: string, ...params: any[]) => { calls.push({ sql, params }); return rows },
    $executeRawUnsafe: async (sql: string, ...params: any[]) => { calls.push({ sql, params }); return 1 },
  }
  return { db, calls }
}

test('upsertPolicy is tenant scoped, keyed by name and bumps the version', async () => {
  const t = recorder([{ id: 'p', version: 2, model: {} }])
  const model: any = { name: 'stopped-ec2', provider: 'aws', resource: 'ec2', filters: [], actions: [], enforcement: 'observe' }
  const policy = await upsertPolicy(t.db, CUSTOMER, { model, compiledYaml: 'y', actionClass: 'none', enforcement: 'observe' })
  const { sql, params } = t.calls[0]
  assert.match(sql, /ON CONFLICT \(customer_id, name\) DO UPDATE/); assert.match(sql, /version = cgov_policy\.version \+ 1/)
  assert.deepEqual(params.slice(0, 3), [CUSTOMER, null, 'stopped-ec2']); assert.equal(JSON.parse(params[3]).name, 'stopped-ec2')
  assert.equal(policy.version, 2)
})
test('upsertPolicyAccount only inserts for a policy owned by the tenant', async () => {
  const t = recorder([{ id: 'a', regions: ['us-east-1'] }])
  await upsertPolicyAccount(t.db, CUSTOMER, { policyId: 'pid', componentId: 'cid', regions: ['us-east-1'] })
  const { sql, params } = t.calls[0]
  assert.match(sql, /p\.customer_id = \$1::uuid/); assert.match(sql, /ON CONFLICT \(policy_id, component_id\)/)
  assert.deepEqual(params, [CUSTOMER, 'pid', 'cid', null, ['us-east-1']])
  await assert.rejects(() => upsertPolicyAccount(recorder([]).db, CUSTOMER, { policyId: 'x', componentId: 'y' }), (e: any) => e.statusCode === 404)
})
test('addMatches batches one idempotent insert and skips empty input', async () => {
  const t = recorder()
  assert.equal(await addMatches(t.db, CUSTOMER, 'run', []), 0); assert.equal(t.calls.length, 0)
  await addMatches(t.db, CUSTOMER, 'run', [{ resourceId: 'i-1', resourceType: 'ec2', region: 'us-east-1', tags: { Owner: 'a' } }])
  assert.match(t.calls[0].sql, /ON CONFLICT \(run_id, resource_id\) DO NOTHING/)
  assert.deepEqual(JSON.parse(t.calls[0].params[2])[0], { resource_id: 'i-1', resource_type: 'ec2', arn: null, region: 'us-east-1', name: null, tags: { Owner: 'a' }, owner: null })
})
test('addAction upserts the outcome and keeps prior state when none is resent', async () => {
  const t = recorder()
  await addAction(t.db, CUSTOMER, { runId: 'run', policyId: 'p', resourceId: 'i-1', action: 'stop', outcome: 'applied', at: '2026-01-01T00:00:00Z' })
  assert.match(t.calls[0].sql, /ON CONFLICT \(run_id, resource_id, action\) DO UPDATE SET\s+outcome = EXCLUDED\.outcome/)
  assert.match(t.calls[0].sql, /COALESCE\(EXCLUDED\.prior_state/)
  assert.deepEqual(t.calls[0].params.slice(0, 6), [CUSTOMER, 'run', 'i-1', 'stop', 'applied', null])
})
test('listRuns clamps the limit and passes the optional policy filter', async () => {
  const t = recorder([])
  await listRuns(t.db, CUSTOMER, { policyId: 'p', limit: 10_000 })
  await listRuns(t.db, CUSTOMER)
  assert.deepEqual(t.calls[0].params, [CUSTOMER, 'p', 500]); assert.deepEqual(t.calls[1].params, [CUSTOMER, null, 50])
})
test('listActiveExceptions filters by expiry against the supplied clock', async () => {
  const t = recorder([])
  await listActiveExceptions(t.db, CUSTOMER, 'stopped-ec2', new Date('2026-06-01T00:00:00Z'))
  assert.match(t.calls[0].sql, /expires_at > \$3::timestamptz/)
  assert.deepEqual(t.calls[0].params, [CUSTOMER, 'stopped-ec2', '2026-06-01T00:00:00.000Z'])
})
test('upsertSchedule is keyed per tenant policy', async () => {
  const t = recorder([{ id: 's', enabled: true }])
  await upsertSchedule(t.db, CUSTOMER, { policyName: 'p', cron: '0 * * * *', enabled: true, enforcement: 'observe' })
  assert.match(t.calls[0].sql, /ON CONFLICT \(customer_id, policy_name\) DO UPDATE/)
  assert.deepEqual(t.calls[0].params.slice(0, 6), [CUSTOMER, null, 'p', '0 * * * *', true, 'observe'])
})
test('deletePolicyAccountsForComponent refuses while a run is active, otherwise deletes', async () => {
  await assert.rejects(() => deletePolicyAccountsForComponent(recorder([{ id: 'a' }]).db, CUSTOMER, 'cid'), (e: any) => e.statusCode === 409)
  const t = recorder([])
  assert.equal(await deletePolicyAccountsForComponent(t.db, CUSTOMER, 'cid'), 1)
  assert.match(t.calls[1].sql, /DELETE FROM cgov_policy_account WHERE customer_id = \$1::uuid AND component_id = \$2::uuid/)
})
