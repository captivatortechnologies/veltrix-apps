import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveTool, listInventory, addInventoryItem, updateInventoryItem, removeInventoryItem } from '../inventory'
import { listCredentials, createCredential, updateCredential, removeCredential } from '../credentials'
import { listEnvironments } from '../environments'
import { listConnectivityProviders } from '../connectivity'

afterEach(() => vi.unstubAllGlobals())

describe('bundled SDK pages in the scoped app runtime', () => {
  it('loads and saves Connections through typed host capabilities', async () => {
    const blockedFetch = vi.fn(() => { throw new Error('Blocked platform route') })
    const sdk = Object.fromEntries([
      'resolveTool', 'listInventory', 'addInventoryItem', 'updateInventoryItem', 'removeInventoryItem',
      'listCredentials', 'createCredential', 'updateCredential', 'removeCredential',
      'listEnvironments', 'listConnectivityProviders',
    ].map(name => [name, vi.fn().mockResolvedValue({ result: name })]))
    vi.stubGlobal('__VELTRIX_APP_RUNTIME__', { authFetch: blockedFetch, sdk })
    const input = { name: 'Splunk', username: 'admin', password: '', toolId: 'tool-1' }
    const inventory = { hostname: 'splunk.local', toolId: 'tool-1' }
    for (const [name, call, args] of [
      ['resolveTool', () => resolveTool('Splunk Enterprise'), ['Splunk Enterprise']],
      ['listInventory', () => listInventory(), []],
      ['addInventoryItem', () => addInventoryItem(inventory), [inventory]],
      ['updateInventoryItem', () => updateInventoryItem('host-1', inventory), ['host-1', inventory]],
      ['removeInventoryItem', () => removeInventoryItem('host-1'), ['host-1']],
      ['listCredentials', () => listCredentials('tool-1'), ['tool-1']],
      ['createCredential', () => createCredential(input), [input]],
      ['updateCredential', () => updateCredential('cred-1', input), ['cred-1', input]],
      ['removeCredential', () => removeCredential('cred-1'), ['cred-1']],
      ['listEnvironments', () => listEnvironments(), []],
      ['listConnectivityProviders', () => listConnectivityProviders(), []],
    ] as const) {
      expect(await call()).toEqual({ result: name })
      expect(sdk[name]).toHaveBeenCalledWith(...args)
    }
    expect(blockedFetch).not.toHaveBeenCalled()
  })

  it('does not recurse when a standalone host reexports the SDK helper', async () => {
    vi.stubGlobal('__VELTRIX_APP_RUNTIME__', {
      sdk: { resolveTool },
      authFetch: vi.fn().mockResolvedValue({ ok: true, json: async () => [{ id: 't', name: 'Splunk' }] }),
    })
    expect(await resolveTool('Splunk')).toEqual({ id: 't', name: 'Splunk' })
  })
})
