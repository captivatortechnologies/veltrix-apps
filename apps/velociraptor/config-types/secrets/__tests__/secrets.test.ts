import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  readSecrets,
  findSecret,
  parseSecretPairs,
  diffValues,
  secretAddVQL,
  secretModifyVQL,
  SECRETS_VQL,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  const items = list.map((fields, i) => ({ id: `i${i}`, name: String(fields.name ?? i), fields }))
  return { canvas: { items } } as unknown as PipelineContext
}

const good = {
  name: 'smtp-relay',
  type: 'smtp',
  secretData: 'username: svc-mail\npassword: hunter2',
  grantedUsers: 'analyst@example.com',
  grantedOrgs: '',
  visibleToAllOrgs: false,
}

// --- validate -----------------------------------------------------------------

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('validate requires a name', async () => {
  const res = await validate(ctxOf([{ ...good, name: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_NAME'))
})

test('validate requires a type', async () => {
  const res = await validate(ctxOf([{ ...good, type: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_TYPE'))
})

test('validate requires secret content', async () => {
  const res = await validate(ctxOf([{ ...good, secretData: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SECRET_DATA'))
})

test('validate rejects content with no parseable key: value line', async () => {
  const res = await validate(ctxOf([{ ...good, secretData: 'just some text' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_SECRET_DATA'))
})

test('validate warns when a secret has no grants and is not visible to all orgs', async () => {
  const res = await validate(ctxOf([{ ...good, grantedUsers: '', grantedOrgs: '', visibleToAllOrgs: false }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'NO_GRANTS'))
})

test('validate does not warn when visible to all orgs even with no explicit grants', async () => {
  const res = await validate(ctxOf([{ ...good, grantedUsers: '', grantedOrgs: '', visibleToAllOrgs: true }]))
  assert.equal(res.warnings.some((w) => w.code === 'NO_GRANTS'), false)
})

test('validate warns on a duplicate name (case-insensitive)', async () => {
  const res = await validate(ctxOf([good, { ...good, name: 'SMTP-Relay' }]))
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_NAME'))
})

test('validate accepts a good secret', async () => {
  const res = await validate(ctxOf([good]))
  assert.equal(res.valid, true)
  assert.equal(res.errors.length, 0)
})

// --- parsing --------------------------------------------------------------------

test('parseSecretPairs reads "key: value" and "key=value" lines', () => {
  assert.deepEqual(parseSecretPairs('a: 1\nb=2\n\nc:  3  '), { a: '1', b: '2', c: '3' })
})

test('parseSecretPairs skips blank lines and lines without a separator', () => {
  assert.deepEqual(parseSecretPairs('no separator here\n\nkey: value'), { key: 'value' })
})

test('diffValues returns values in "a" that are not in "b"', () => {
  assert.deepEqual(diffValues(['a', 'b'], ['b']), ['a'])
  assert.deepEqual(diffValues([], ['a']), [])
})

// --- reading ----------------------------------------------------------------

test('readSecrets maps name/type/users/orgs, tolerant of casing', () => {
  const secrets = readSecrets([
    { name: 'a', type: 'generic', users: ['x'], orgs: ['org1'], visible_to_all_orgs: false },
    { Name: 'b', Type: 'smtp' },
    { name: '' },
  ])
  assert.equal(secrets.length, 2)
  assert.deepEqual(secrets[0], { name: 'a', type: 'generic', users: ['x'], orgs: ['org1'], visibleToAllOrgs: false })
  assert.deepEqual(secrets[1], { name: 'b', type: 'smtp', users: null, orgs: null, visibleToAllOrgs: null })
})

test('findSecret matches by case-insensitive name', () => {
  const live = readSecrets([{ name: 'SMTP-Relay', type: 'smtp' }])
  assert.equal(findSecret(live, 'smtp-relay')?.name, 'SMTP-Relay')
  assert.equal(findSecret(live, 'missing'), null)
})

// --- VQL builders -----------------------------------------------------------

test('secretAddVQL wraps the secret dict in parse_json', () => {
  const vql = secretAddVQL('smtp-relay', 'smtp', { username: 'svc-mail' })
  assert.match(vql, /secret_add\(name='smtp-relay', type='smtp', secret=parse_json\(data='/)
})

test('secretModifyVQL includes only the provided grant operations', () => {
  const vql = secretModifyVQL('smtp-relay', 'smtp', { addUsers: ['a'], removeOrgs: ['org1'] })
  assert.match(vql, /add_users=\['a'\]/)
  assert.match(vql, /remove_orgs=\['org1'\]/)
  assert.ok(!/remove_users=/.test(vql))
  assert.ok(!/add_orgs=/.test(vql))
})

test('secretModifyVQL renders delete and visibility as bare TRUE/FALSE', () => {
  assert.match(secretModifyVQL('a', 'generic', { delete: true }), /delete=TRUE/)
  assert.match(secretModifyVQL('a', 'generic', { visibleToAllOrgs: false }), /visible_to_all_orgs=FALSE/)
})

test('SECRETS_VQL reads every secret', () => {
  assert.match(SECRETS_VQL, /FROM secrets\(\)/)
})
