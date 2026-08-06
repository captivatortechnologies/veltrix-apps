import {
  readFmcSettings,
  resolveFmcCredential,
  fmcErrorMessage,
  coerceBoolean,
  splitList,
  sameSet,
  upsertByName,
  type FmcClient,
  type DeployedObject,
} from '../fmc'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

describe('fmc lib — settings', () => {
  it('applies defaults', () => {
    const s = readFmcSettings({})
    expect(s.domainName).toBeNull()
    expect(s.timeoutMs).toBe(30_000)
    expect(s.autoDeployToDevices).toBe(false)
    expect(s.ignoreDeployWarnings).toBe(true)
  })

  it('reads overrides', () => {
    const s = readFmcSettings({
      domain_name: 'Global/Branch',
      request_timeout_seconds: 15,
      auto_deploy_to_devices: true,
      ignore_deploy_warnings: false,
    })
    expect(s.domainName).toBe('Global/Branch')
    expect(s.timeoutMs).toBe(15_000)
    expect(s.autoDeployToDevices).toBe(true)
    expect(s.ignoreDeployWarnings).toBe(false)
  })

  it('ignores a blank domain_name', () => {
    expect(readFmcSettings({ domain_name: '   ' }).domainName).toBeNull()
  })
})

describe('fmc lib — credential', () => {
  it('requires both username and password', () => {
    expect(resolveFmcCredential(cred({ username: 'admin', password: 'secret' }))).toEqual({
      username: 'admin',
      password: 'secret',
    })
    expect(resolveFmcCredential(cred({ username: 'admin', password: '' }))).toBeNull()
    expect(resolveFmcCredential(cred({ username: '', password: 'secret' }))).toBeNull()
    expect(resolveFmcCredential(null)).toBeNull()
  })
})

describe('fmc lib — error parsing', () => {
  it('extracts a single message description', () => {
    const body = JSON.stringify({ error: { messages: [{ description: 'name is required' }] } })
    expect(fmcErrorMessage({ status: 400, ok: false, body })).toBe('name is required')
  })

  it('prefixes with the field name when present', () => {
    const body = JSON.stringify({ error: { messages: [{ field: 'name', description: 'is required' }] } })
    expect(fmcErrorMessage({ status: 400, ok: false, body })).toBe('name: is required')
  })

  it('joins multiple messages', () => {
    const body = JSON.stringify({ error: { messages: [{ description: 'a' }, { description: 'b' }] } })
    expect(fmcErrorMessage({ status: 400, ok: false, body })).toBe('a; b')
  })

  it('falls back to the raw body or status when unparseable', () => {
    expect(fmcErrorMessage({ status: 500, ok: false, body: 'gateway timeout' })).toBe('gateway timeout')
    expect(fmcErrorMessage({ status: 503, ok: false, body: '' })).toBe('HTTP 503')
  })
})

describe('fmc lib — helpers', () => {
  it('coerces booleans from mixed serializations', () => {
    expect(coerceBoolean('yes', false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean(1, false)).toBe(true)
    expect(coerceBoolean(undefined, true)).toBe(true)
  })

  it('splits comma/newline separated values', () => {
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(['x', ' y '])).toEqual(['x', 'y'])
    expect(splitList(undefined)).toEqual([])
  })

  it('compares sets order- and case-insensitively', () => {
    expect(sameSet(['a', 'B'], ['b', 'A'])).toBe(true)
    expect(sameSet(['a'], ['a', 'b'])).toBe(false)
  })
})

describe('fmc lib — upsertByName', () => {
  function fakeClient(existing: Array<{ id: string; name: string }>): FmcClient {
    const created: Array<{ path: string; body: unknown }> = []
    const updated: Array<{ path: string; id: string; body: unknown }> = []
    return {
      list: async () => ({ ok: true, items: existing, status: 200, body: '' }),
      createObject: async (path: string, body: Record<string, unknown>) => {
        created.push({ path, body })
        return { status: 201, ok: true, body: JSON.stringify({ id: 'new-id', ...body }) }
      },
      updateObject: async (path: string, id: string, body: Record<string, unknown>) => {
        updated.push({ path, id, body })
        return { status: 200, ok: true, body: JSON.stringify({ id, ...body }) }
      },
      // expose the spy arrays for assertions
      __created: created,
      __updated: updated,
    } as unknown as FmcClient & { __created: typeof created; __updated: typeof updated }
  }

  it('creates a new object and records it as not pre-existing', async () => {
    const client = fakeClient([])
    const rollback: DeployedObject[] = []
    const deployed: string[] = []
    await upsertByName(client, '/object/hosts', [{ name: 'host-a', fields: { value: '10.0.0.1' } }], rollback, deployed)

    expect(deployed).toEqual(['host-a'])
    expect(rollback).toEqual([{ name: 'host-a', id: 'new-id', existed: false }])
  })

  it('updates an existing object (matched case-insensitively) and records it as pre-existing', async () => {
    const client = fakeClient([{ id: 'existing-id', name: 'Host-A' }])
    const rollback: DeployedObject[] = []
    const deployed: string[] = []
    await upsertByName(client, '/object/hosts', [{ name: 'host-a', fields: { value: '10.0.0.1' } }], rollback, deployed)

    expect(deployed).toEqual(['host-a'])
    expect(rollback).toEqual([{ name: 'host-a', id: 'existing-id', existed: true }])
  })

  it('throws on the first API error, leaving partial rollback state intact', async () => {
    const client = {
      list: async () => ({ ok: true, items: [], status: 200, body: '' }),
      createObject: async () => ({ status: 400, ok: false, body: JSON.stringify({ error: { messages: [{ description: 'bad' }] } }) }),
    } as unknown as FmcClient

    const rollback: DeployedObject[] = []
    const deployed: string[] = []
    let caught: unknown = null
    try {
      await upsertByName(client, '/object/hosts', [{ name: 'host-a', fields: {} }], rollback, deployed)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeTruthy()
    expect((caught as Error).message).toMatch(/bad/)
    expect(deployed).toEqual([])
  })
})
