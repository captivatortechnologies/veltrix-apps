import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildCreateBody,
  findManagedSystem,
  findWorkgroupByName,
  listFrom,
  systemIdentity,
  toBool,
  toNonNegativeInt,
  toPositiveInt,
} from '../_shared'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

/**
 * These handlers apply over the BeyondInsight REST API via node:https inside
 * beyondtrustApi, which is impractical to mock here. Tests focus on validate.ts
 * and the pure _shared helpers (identity, list-unwrap, create-body), which are
 * network-free.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.systemName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { workgroupName: 'Corp Servers', systemName: 'web-01', platformId: 4, contactEmail: 'ops@example.com' }

test('validate rejects a missing workgroup name', async () => {
  const res = await validate(ctxOf([{ ...good, workgroupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_WORKGROUP'))
})

test('validate rejects a missing system name', async () => {
  const res = await validate(ctxOf([{ ...good, systemName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_SYSTEM_NAME'))
})

test('validate rejects an over-long system name', async () => {
  const res = await validate(ctxOf([{ ...good, systemName: 'a'.repeat(129) }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'SYSTEM_NAME_TOO_LONG'))
})

test('validate rejects a missing / non-positive platform id', async () => {
  for (const platformId of ['', 0, -3, 'abc', 1.5]) {
    const res = await validate(ctxOf([{ ...good, platformId }]))
    assert.equal(res.valid, false, `expected platformId ${platformId} to be invalid`)
    assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM_ID'))
  }
})

test('validate rejects an invalid account name format', async () => {
  const res = await validate(ctxOf([{ ...good, accountNameFormat: 9 }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACCOUNT_NAME_FORMAT'))
})

test('validate accepts each valid account name format', async () => {
  for (const accountNameFormat of [0, 1, 2]) {
    const res = await validate(ctxOf([{ ...good, accountNameFormat }]))
    assert.equal(res.valid, true, `expected format ${accountNameFormat} to be valid`)
  }
})

test('validate warns on a duplicate (workgroup, system name) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, contactEmail: 'other@example.com' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_SYSTEM'))
})

test('validate treats same system name in a different workgroup as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, workgroupName: 'Other Workgroup' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('toPositiveInt / toNonNegativeInt coerce correctly', () => {
  assert.equal(toPositiveInt('4'), 4)
  assert.equal(toPositiveInt(0), null)
  assert.equal(toNonNegativeInt(0), 0)
  assert.equal(toNonNegativeInt(-1), null)
  assert.equal(toNonNegativeInt(''), null)
})

test('toBool coerces canvas checkbox values with a fallback', () => {
  assert.equal(toBool(true, false), true)
  assert.equal(toBool('false', true), false)
  assert.equal(toBool('', true), true)
  assert.equal(toBool(undefined, false), false)
})

test('listFrom unwraps arrays and paginated containers', () => {
  assert.equal(listFrom<{ a: number }>([{ a: 1 }]).length, 1)
  assert.equal(listFrom<{ a: number }>({ Data: [{ a: 1 }, { a: 2 }] }).length, 2)
  assert.equal(listFrom<unknown>(null).length, 0)
})

test('findWorkgroupByName matches case-insensitively', () => {
  const live = [{ WorkgroupID: 5, Name: 'Corp Servers' }]
  assert.equal(findWorkgroupByName(live, 'CORP SERVERS')?.WorkgroupID, 5)
  assert.equal(findWorkgroupByName(live, 'nope'), null)
})

test('findManagedSystem matches on the (workgroup, system name) pair, case-insensitively', () => {
  const live = [
    { ManagedSystemID: 10, WorkgroupID: 5, SystemName: 'web-01' },
    { ManagedSystemID: 11, WorkgroupID: 6, SystemName: 'web-01' },
  ]
  assert.equal(findManagedSystem(live, 5, 'WEB-01')?.ManagedSystemID, 10)
  assert.equal(findManagedSystem(live, 6, 'web-01')?.ManagedSystemID, 11)
  assert.equal(findManagedSystem(live, 7, 'web-01'), null)
})

test('systemIdentity is stable across casing', () => {
  assert.equal(systemIdentity(5, 'Web-01'), systemIdentity(5, 'web-01'))
  assert.notEqual(systemIdentity(5, 'web-01'), systemIdentity(6, 'web-01'))
})

test('buildCreateBody omits blank optional fields and keeps the required ones plus flag defaults', () => {
  const body = buildCreateBody({ platformId: 4, systemName: 'web-01' })
  assert.equal(body.PlatformID, 4)
  assert.equal(body.SystemName, 'web-01')
  assert.equal(body.AutoManagementFlag, true)
  assert.equal(body.CheckPasswordFlag, false)
  assert.equal(body.ContactEmail, undefined)

  const full = buildCreateBody({
    platformId: '5',
    systemName: 'db-01',
    contactEmail: 'ops@example.com',
    description: 'primary db',
    timeout: 30,
    port: 5432,
    accountNameFormat: 1,
    passwordRuleId: 2,
    dssKeyRuleId: 3,
    releaseDuration: 60,
    maxReleaseDuration: 480,
    isaReleaseDuration: 15,
    autoManagementFlag: false,
    checkPasswordFlag: true,
    changePasswordAfterAnyReleaseFlag: true,
    resetPasswordOnMismatchFlag: true,
    functionalAccountId: 9,
  })
  assert.deepEqual(full, {
    PlatformID: 5,
    SystemName: 'db-01',
    ContactEmail: 'ops@example.com',
    Description: 'primary db',
    Timeout: 30,
    Port: 5432,
    AccountNameFormat: 1,
    PasswordRuleID: 2,
    DSSKeyRuleID: 3,
    ReleaseDuration: 60,
    MaxReleaseDuration: 480,
    ISAReleaseDuration: 15,
    AutoManagementFlag: false,
    CheckPasswordFlag: true,
    ChangePasswordAfterAnyReleaseFlag: true,
    ResetPasswordOnMismatchFlag: true,
    FunctionalAccountID: 9,
  })
})
