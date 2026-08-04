import { test } from 'node:test'
import assert from 'node:assert/strict'
import validate from '../validate'
import {
  buildDirectoryBody,
  directoryIdentity,
  findDirectory,
  findWorkgroupByName,
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
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.domainName ?? i), fields }))
}

function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const good = { workgroupName: 'Corp Servers', platformId: 1, domainName: 'corp.example.com', forestName: 'example.com', netBiosName: 'CORP' }

test('validate rejects a missing workgroup name', async () => {
  const res = await validate(ctxOf([{ ...good, workgroupName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_WORKGROUP'))
})

test('validate rejects a missing / non-positive platform id', async () => {
  for (const platformId of ['', 0, -3, 'abc', 1.5]) {
    const res = await validate(ctxOf([{ ...good, platformId }]))
    assert.equal(res.valid, false, `expected platformId ${platformId} to be invalid`)
    assert.ok(res.errors.some((e) => e.code === 'INVALID_PLATFORM_ID'))
  }
})

test('validate rejects a missing domain name', async () => {
  const res = await validate(ctxOf([{ ...good, domainName: '' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY_DOMAIN_NAME'))
})

test('validate rejects an over-long domain / forest / NetBIOS name', async () => {
  const overDomain = await validate(ctxOf([{ ...good, domainName: 'a'.repeat(129) }]))
  assert.ok(overDomain.errors.some((e) => e.code === 'DOMAIN_NAME_TOO_LONG'))

  const overForest = await validate(ctxOf([{ ...good, forestName: 'a'.repeat(65) }]))
  assert.ok(overForest.errors.some((e) => e.code === 'FOREST_NAME_TOO_LONG'))

  const overNetBios = await validate(ctxOf([{ ...good, netBiosName: 'a'.repeat(16) }]))
  assert.ok(overNetBios.errors.some((e) => e.code === 'NETBIOS_NAME_TOO_LONG'))
})

test('validate warns on a duplicate (workgroup, domain) identity', async () => {
  const res = await validate(ctxOf([good, { ...good, forestName: 'other.example.com' }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'DUPLICATE_DIRECTORY'))
})

test('validate treats same domain in a different workgroup as distinct', async () => {
  const res = await validate(ctxOf([good, { ...good, workgroupName: 'Other Workgroup' }]))
  assert.equal(res.valid, true)
  assert.equal(res.warnings.length, 0)
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

test('buildDirectoryBody never carries a bind credential field', () => {
  const body = buildDirectoryBody({ platformId: 1, domainName: 'corp.example.com' }) as unknown as Record<string, unknown>
  assert.equal('Username' in body, false)
  assert.equal('Password' in body, false)
  assert.equal('BindUser' in body, false)
  assert.equal('CredentialID' in body, false)
})

test('buildDirectoryBody omits blank optional fields and keeps the required ones', () => {
  const minimal = buildDirectoryBody({ platformId: 1, domainName: 'corp.example.com' })
  assert.deepEqual(minimal, { PlatformID: 1, DomainName: 'corp.example.com', UseSSL: false })

  const full = buildDirectoryBody({
    platformId: '2',
    domainName: 'corp.example.com',
    forestName: 'example.com',
    netBiosName: 'CORP',
    port: 636,
    useSSL: true,
    timeout: 30,
    description: 'desc',
    contactEmail: 'ops@example.com',
    passwordRuleId: 3,
  })
  assert.deepEqual(full, {
    PlatformID: 2,
    DomainName: 'corp.example.com',
    ForestName: 'example.com',
    NetBiosName: 'CORP',
    Port: 636,
    UseSSL: true,
    Timeout: 30,
    Description: 'desc',
    ContactEmail: 'ops@example.com',
    PasswordRuleID: 3,
  })
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

test('findDirectory matches on the (workgroup, domain) pair, case-insensitively', () => {
  const live = [
    { DirectoryID: 10, WorkgroupID: 5, DomainName: 'corp.example.com' },
    { DirectoryID: 11, WorkgroupID: 6, DomainName: 'corp.example.com' },
  ]
  assert.equal(findDirectory(live, 5, 'CORP.EXAMPLE.COM')?.DirectoryID, 10)
  assert.equal(findDirectory(live, 6, 'corp.example.com')?.DirectoryID, 11)
  assert.equal(findDirectory(live, 7, 'corp.example.com'), null)
})

test('directoryIdentity is stable across casing', () => {
  assert.equal(directoryIdentity(5, 'Corp.Example.com'), directoryIdentity(5, 'corp.example.com'))
  assert.notEqual(directoryIdentity(5, 'corp.example.com'), directoryIdentity(6, 'corp.example.com'))
})

test('projectFromFields / projectFromLive agree on a matching directory', () => {
  const fields = { forestName: 'example.com', netBiosName: 'CORP', port: 636, useSSL: true, timeout: 30, description: 'd', contactEmail: 'ops@example.com', passwordRuleId: 3 }
  const live = { ForestName: 'example.com', NetBiosName: 'CORP', Port: 636, UseSSL: true, Timeout: 30, Description: 'd', ContactEmail: 'ops@example.com', PasswordRuleID: 3 }
  assert.deepEqual(projectFromFields(fields), projectFromLive(live))
})
