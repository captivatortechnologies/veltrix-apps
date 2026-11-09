import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import validate from '../validate'
import deploy from '../deploy'
import rollback from '../rollback'
import driftDetect from '../driftDetect'
import healthCheck from '../healthCheck'
import { AWS_RESOURCES } from '../../../lib/model'
import { CUSTOMER, COMPONENT, createFakeDb, ctxFor, goodPolicyFields, item } from '../../lib/__tests__/fakeDb'

const good = item(goodPolicyFields)

test('canvas resource options are exactly the allow-listed AWS resources', () => {
  const yaml = readFileSync(join(process.cwd(), 'apps', 'cloud-governance', 'config-types', 'policies', 'canvas.yaml'), 'utf8')
  const block = yaml.split('key: "resource"')[1].split('key: "enforcement"')[0]
  const values = [...block.matchAll(/value: "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(values, [...AWS_RESOURCES])
})

test('validate accepts a good policy', async () => {
  const res = await validate(ctxFor([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

test('validate rejects an empty canvas', async () => {
  const res = await validate(ctxFor([]))
  assert.equal(res.valid, false)
  assert.equal(res.errors[0].code, 'EMPTY')
})

test('validate reports invalid JSON in filters and actions with the item path', async () => {
  const res = await validate(ctxFor([item({ ...goodPolicyFields, filters: '{not json', actions: '{"a":1}' })]))
  assert.equal(res.valid, false)
  const codes = res.errors.map((e) => `${e.field}:${e.code}`)
  assert.ok(codes.includes('items[0].filters:JSON_INVALID'))
  assert.ok(codes.includes('items[0].actions:JSON_NOT_ARRAY'))
})

test('validate rejects a bad name, a disallowed resource and an unknown enforcement', async () => {
  const res = await validate(ctxFor([
    item({ ...goodPolicyFields, name: 'Bad Name' }, 'a'),
    item({ ...goodPolicyFields, name: 'ok-one', resource: 'not-a-resource' }, 'b'),
    item({ ...goodPolicyFields, name: 'ok-two', enforcement: 'yolo' }, 'c'),
  ]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field === 'items[0].name' && e.code === 'NAME_INVALID'))
  assert.ok(res.errors.some((e) => e.field === 'items[1].resource'))
  assert.ok(res.errors.some((e) => e.field === 'items[2].enforcement' && e.code === 'ENFORCEMENT_INVALID'))
})

test('validate surfaces compiler deny-list refusals', async () => {
  const res = await validate(ctxFor([item({ ...goodPolicyFields, filters: '[{"type":"value","key":"a","value_from":{"url":"http://x"}}]' })]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.field.startsWith('items[0].filters')))
})

test('validate rejects bad caps and region overrides, and duplicate names', async () => {
  const res = await validate(ctxFor([
    item({ ...goodPolicyFields, maxResources: '0', regions: ['mars-1'] }, 'a'),
    item({ ...goodPolicyFields }, 'b'),
    item({ ...goodPolicyFields }, 'c'),
  ]))
  assert.ok(res.errors.some((e) => e.code === 'CAP_INVALID'))
  assert.ok(res.errors.some((e) => e.code === 'REGION_INVALID'))
  assert.ok(res.errors.some((e) => e.code === 'DUPLICATE_ITEM'))
})

test('validate coerces numbers, tags and keyvalue fields into the model', async () => {
  const res = await validate(ctxFor([item({
    ...goodPolicyFields, maxResources: '50', gracePeriodDays: 3, ownerTagKeys: ['Owner'],
    tags: [{ key: 'team', value: 'sec' }], regions: ['us-east-1'],
  })]))
  assert.equal(res.valid, true)
})

test('deploy fails clearly without the governance store', async () => {
  const res = await deploy(ctxFor([good]))
  assert.equal(res.success, false)
  assert.match(res.message, /ctx\.db/)
})

test('deploy compiles, stores and registers the policy for the account, never touching runs', async () => {
  const db = createFakeDb()
  const res = await deploy(ctxFor([item({ ...goodPolicyFields, regions: ['eu-west-1'] })], db))
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.policies.length, 1)
  const stored = db.tables.policies[0]
  assert.equal(stored.customer_id, CUSTOMER)
  assert.match(stored.compiled_yaml, /name: "stopped-ec2"/)
  assert.equal(stored.action_class, 'reversible')
  assert.deepEqual(db.tables.accounts[0].regions, ['eu-west-1'])
  assert.equal(db.tables.accounts[0].account_ref, COMPONENT.hostname)
  assert.equal(db.tables.accounts[0].component_id, COMPONENT.id)
  assert.ok(!db.calls.some((c) => c.includes('INSERT INTO cgov_run')))
  const data = res.rollbackData as any
  assert.equal(data.policies[0].existed, false)
  assert.equal(data.policies[0].policyId, stored.id)
})

test('deploy compiles the tenant active exceptions into the policy, and ignores expired ones', async () => {
  const db = createFakeDb()
  db.tables.exceptions.push(
    { id: 'e1', customer_id: CUSTOMER, policy_name: 'stopped-ec2', resource_id: 'i-live', reason: 'r', approver: 'a', expires_at: '2999-01-01', created_at: '' },
    { id: 'e2', customer_id: CUSTOMER, policy_name: 'stopped-ec2', resource_id: 'i-dead', reason: 'r', approver: 'a', expires_at: '2000-01-01', created_at: '' },
  )
  const res = await deploy(ctxFor([good], db))
  assert.equal(res.success, true)
  assert.match(db.tables.policies[0].compiled_yaml, /i-live/)
  assert.doesNotMatch(db.tables.policies[0].compiled_yaml, /i-dead/)
})

test('deploy stores a valid-but-uncompilable policy with null YAML and reports failure', async () => {
  const db = createFakeDb()
  const bad = item({ ...goodPolicyFields, filters: '[{"type":"value","key":"a","value_from":{"url":"http://x"}}]' })
  const res = await deploy(ctxFor([bad], db))
  assert.equal(res.success, false)
  assert.equal(db.tables.policies[0].compiled_yaml, null)
  assert.equal(db.tables.policies[0].action_class, 'none')
})

test('deploy refuses a structurally invalid policy without storing it', async () => {
  const db = createFakeDb()
  const res = await deploy(ctxFor([item({ ...goodPolicyFields, name: 'BAD NAME' })], db))
  assert.equal(res.success, false)
  assert.equal(db.tables.policies.length, 0)
})

test('rollback deletes a policy the deploy created', async () => {
  const db = createFakeDb()
  const dep = await deploy(ctxFor([good], db))
  const res = await rollback({ ...ctxFor([good], db), rollbackData: dep.rollbackData })
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.policies.length, 0)
  assert.equal(db.tables.accounts.length, 0)
})

test('rollback restores the previous model and YAML of a policy that already existed', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  const before = { ...db.tables.policies[0] }
  const dep = await deploy(ctxFor([item({ ...goodPolicyFields, enforcement: 'observe', actions: '[]' })], db))
  assert.equal(db.tables.policies[0].enforcement, 'observe')
  const res = await rollback({ ...ctxFor([good], db), rollbackData: dep.rollbackData })
  assert.equal(res.success, true, res.message)
  assert.equal(db.tables.policies[0].enforcement, 'auto')
  assert.equal(db.tables.policies[0].compiled_yaml, before.compiled_yaml)
  assert.equal(db.tables.accounts.length, 1)
})

test('rollback without recorded data fails', async () => {
  const res = await rollback({ ...ctxFor([good], createFakeDb()), rollbackData: null })
  assert.equal(res.success, false)
})

test('driftDetect is unchecked without a store', async () => {
  const res = await driftDetect(ctxFor([good]))
  assert.equal(res.checked, false)
  assert.equal(res.hasDrift, false)
})

test('driftDetect reports no drift right after deploy', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  const res = await driftDetect(ctxFor([good], db))
  assert.equal(res.checked, true)
  assert.deepEqual(res.diffs, [])
})

test('driftDetect flags a missing policy as critical', async () => {
  const res = await driftDetect(ctxFor([good], createFakeDb()))
  assert.equal(res.hasDrift, true)
  assert.equal(res.diffs[0].severity, 'critical')
})

test('driftDetect flags a stored model, stale YAML and region change against the canvas', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  db.tables.policies[0].model = { ...db.tables.policies[0].model, enforcement: 'observe' }
  db.tables.policies[0].compiled_yaml = 'stale'
  db.tables.accounts[0].regions = ['ap-south-1']
  const res = await driftDetect(ctxFor([good], db))
  const fields = res.diffs.map((d) => d.field)
  assert.ok(fields.includes('stopped-ec2.enforcement'))
  assert.ok(fields.includes('stopped-ec2.compiledYaml'))
  assert.ok(fields.includes('stopped-ec2.regions'))
})

test('driftDetect flags a missing account registration', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  db.tables.accounts.length = 0
  const res = await driftDetect(ctxFor([good], db))
  assert.ok(res.diffs.some((d) => d.field === 'stopped-ec2.account' && d.severity === 'critical'))
})

test('healthCheck scores a healthy deployment 100', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  const res = await healthCheck(ctxFor([good], db))
  assert.equal(res.healthy, true)
  assert.equal(res.score, 100)
})

test('healthCheck penalises uncompiled policies and failed last runs', async () => {
  const db = createFakeDb()
  await deploy(ctxFor([good], db))
  db.tables.policies[0].compiled_yaml = null
  db.tables.runs.push({ id: 'r', customer_id: CUSTOMER, policy_id: db.tables.policies[0].id, status: 'failed', counts: {} })
  const res = await healthCheck(ctxFor([good], db))
  assert.equal(res.healthy, false)
  assert.equal(res.score, 60)
  assert.equal(res.checks.find((c) => c.name === 'Policies compiled')?.passed, false)
  assert.equal(res.checks.find((c) => c.name === 'Last runs')?.passed, false)
})

test('healthCheck without a store reports score 0', async () => {
  const res = await healthCheck(ctxFor([good]))
  assert.equal(res.healthy, false)
  assert.equal(res.score, 0)
})
