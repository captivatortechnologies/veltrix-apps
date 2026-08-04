import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  accountIdentity,
  buildAccountBody,
  findManagedAccount,
  findManagedSystemByName,
  listFrom,
  projectFromFields,
  projectFromLive,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (identity, list-unwrap, body-build, projection),
 * which are network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.accountName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { systemName: 'web-01', accountName: 'svc-app', domainName: 'corp.example.com', description: 'App service account' }

test('validate rejects a missing system name', async () => {
  const res = await validate(ctxOf([{ ...good, systemName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SYSTEM_NAME'))
})

test('validate rejects a missing account name', async () => {
  const res = await validate(ctxOf([{ ...good, accountName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_ACCOUNT_NAME'))
})

test('validate rejects an over-long account name', async () => {
  const res = await validate(ctxOf([{ ...good, accountName: 'a'.repeat(246) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'ACCOUNT_NAME_TOO_LONG'))
})

test('validate rejects an unknown change frequency type', async () => {
  const res = await validate(ctxOf([{ ...good, changeFrequencyType: 'never' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CHANGE_FREQUENCY'))
})

test('validate requires change frequency days when frequency is xdays', async () => {
  const res = await validate(ctxOf([{ ...good, changeFrequencyType: 'xdays' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'MISSING_CHANGE_FREQUENCY_DAYS'))
})

test('validate accepts xdays with a positive day count', async () => {
  const res = await validate(ctxOf([{ ...good, changeFrequencyType: 'xdays', changeFrequencyDays: 30 }]))
  assert.equal(res.valid, true)
})

test('validate rejects a malformed change time', async () => {
  const res = await validate(ctxOf([{ ...good, changeTime: '25:99' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_CHANGE_TIME'))
})

test('validate accepts a well-formed change time', async () => {
  const res = await validate(ctxOf([{ ...good, changeTime: '23:30' }]))
  assert.equal(res.valid, true)
})

test('validate warns on a duplicate (system, account, domain) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, description: 'copy' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_ACCOUNT'))
})

test('validate treats same account on a different system as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, systemName: 'db-01' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildAccountBody always sets AutoManagementFlag true and never carries a secret field', () => {
  const body = buildAccountBody({ accountName: 'svc-app' }) as unknown as Record<string, unknown>
  assert.equal(body.AutoManagementFlag, true)
  assert.equal('Password' in body, false)
  assert.equal('PrivateKey' in body, false)
  assert.equal('Passphrase' in body, false)
})

test('buildAccountBody omits blank optional fields and keeps the required ones', () => {
  const full = buildAccountBody({
    accountName: 'svc-app',
    domainName: 'corp.example.com',
    description: 'desc',
    passwordRuleId: 2,
    releaseDuration: 60,
    maxReleaseDuration: 480,
    isaReleaseDuration: 15,
    checkPasswordFlag: true,
    changeFrequencyType: 'xdays',
    changeFrequencyDays: 30,
    changeTime: '23:30',
  })
  assert.deepEqual(full, {
    AccountName: 'svc-app',
    AutoManagementFlag: true,
    DomainName: 'corp.example.com',
    Description: 'desc',
    PasswordRuleID: 2,
    ReleaseDuration: 60,
    MaxReleaseDuration: 480,
    ISAReleaseDuration: 15,
    CheckPasswordFlag: true,
    ChangeFrequencyType: 'xdays',
    ChangeFrequencyDays: 30,
    ChangeTime: '23:30',
  })
})

test('listFrom unwraps arrays and paginated containers', () => {
  assert.equal(listFrom<{ a: number }>([{ a: 1 }]).length, 1)
  assert.equal(listFrom<{ a: number }>({ Data: [{ a: 1 }, { a: 2 }] }).length, 2)
  assert.equal(listFrom<unknown>(null).length, 0)
})

test('findManagedSystemByName matches case-insensitively', () => {
  const live = [{ ManagedSystemID: 5, SystemName: 'web-01' }]
  assert.equal(findManagedSystemByName(live, 'WEB-01')?.ManagedSystemID, 5)
  assert.equal(findManagedSystemByName(live, 'nope'), null)
})

test('findManagedAccount matches on the (account, domain) pair, case-insensitively', () => {
  const live = [
    { ManagedAccountID: 10, AccountName: 'svc-app', DomainName: 'corp.example.com' },
    { ManagedAccountID: 11, AccountName: 'root', DomainName: '' },
  ]
  assert.equal(findManagedAccount(live, 'SVC-APP', 'CORP.EXAMPLE.COM')?.ManagedAccountID, 10)
  assert.equal(findManagedAccount(live, 'root', '')?.ManagedAccountID, 11)
  assert.equal(findManagedAccount(live, 'svc-app', ''), null)
})

test('accountIdentity is stable across casing', () => {
  assert.equal(accountIdentity('Svc', 'Corp'), accountIdentity('svc', 'corp'))
  assert.notEqual(accountIdentity('svc', ''), accountIdentity('svc', 'corp'))
})

test('projectFromFields / projectFromLive agree on a matching account', () => {
  const fields = { description: 'd', passwordRuleId: 2, releaseDuration: 60, maxReleaseDuration: 480, isaReleaseDuration: 15, checkPasswordFlag: true }
  const live = { Description: 'd', PasswordRuleID: 2, ReleaseDuration: 60, MaxReleaseDuration: 480, ISAReleaseDuration: 15, CheckPasswordFlag: true }
  assert.deepEqual(projectFromFields(fields), projectFromLive(live))
})
