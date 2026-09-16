import deploy, { type AuditDeviceRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  NO_CONTENT,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const FILE_DEVICE = {
  path: 'file',
  type: 'file',
  description: 'Primary audit log',
  filePath: '/var/log/vault-audit.log',
}

const EMPTY_LIST = { status: 200, body: { data: {} } }

function listing(devices: Record<string, unknown>) {
  return { status: 200, body: { data: devices } }
}

function canvasWith(devices: Array<Record<string, unknown>>) {
  return makeCanvas(
    devices.map((fields, i) => ({ name: `Device ${i + 1}`, fields })),
    'audit-devices',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): AuditDeviceRollbackEntry[] {
  return (result.rollbackData as { previousState?: AuditDeviceRollbackEntry[] })?.previousState ?? []
}

function createdPaths(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdPaths?: string[] })?.createdPaths ?? []
}

describe('Vault Audit Devices Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE]), { token: null }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault token/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('refuses without a Vault address instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([EMPTY_LIST, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      for (const call of fetchStub.calls) {
        expect(call.headers['X-Vault-Token']).toBe(VAULT_TOKEN)
      }
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('enables a device that is not mounted yet and records it as created', async () => {
    const fetchStub = recordFetch([EMPTY_LIST, NO_CONTENT])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [list, enable] = fetchStub.calls
      expect(list.method).toBe('GET')
      expect(list.url).toBe(`${VAULT_BASE}/sys/audit`)
      expect(enable.method).toBe('PUT')
      expect(enable.url).toBe(`${VAULT_BASE}/sys/audit/file`)
      // Only /sys/namespaces speaks merge-patch; an audit enable is plain JSON.
      expect(enable.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(enable.body)).toEqual({
        type: 'file',
        options: { file_path: '/var/log/vault-audit.log' },
        description: 'Primary audit log',
      })

      expect(rollbackEntries(result)).toEqual([{ path: 'file', existed: false }])
      expect(createdPaths(result)).toEqual(['file'])
      expect((result.artifacts as { reenabledDevices: string[] }).reenabledDevices).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('sends only the options that belong to the declared backend type', async () => {
    const fetchStub = recordFetch([EMPTY_LIST, NO_CONTENT])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            {
              path: 'socket',
              type: 'socket',
              socketAddress: '10.0.0.5:9090',
              socketType: 'tcp',
              filePath: '/var/log/stray.log',
            },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body).options).toEqual({
        address: '10.0.0.5:9090',
        socket_type: 'tcp',
      })
    } finally {
      fetchStub.restore()
    }
  })

  it('leaves an already-matching device mounted — auditing is never interrupted', async () => {
    const fetchStub = recordFetch([
      listing({
        'file/': {
          type: 'file',
          description: 'Primary audit log',
          // Vault fills in defaults this config neither sends nor owns.
          options: { file_path: '/var/log/vault-audit.log', mode: '0600', format: 'json' },
        },
      }),
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect((result.artifacts as { deployedDevices: string[] }).deployedDevices).toEqual(['file'])
      // Nothing changed, so there is nothing to roll back.
      expect(rollbackEntries(result)).toEqual([])
      expect(createdPaths(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reads the legacy top-level device map when the response has no data envelope', async () => {
    const fetchStub = recordFetch([
      {
        status: 200,
        body: { 'file/': { type: 'file', options: { file_path: '/var/log/vault-audit.log' } } },
      },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('updates a changed device by disabling then re-enabling, in that order', async () => {
    const fetchStub = recordFetch([
      listing({
        'file/': { type: 'file', description: 'old', options: { file_path: '/old.log' } },
      }),
      NO_CONTENT,
      NO_CONTENT,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(3)
      expect(fetchStub.calls[1].method).toBe('DELETE')
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/audit/file`)
      expect(fetchStub.calls[2].method).toBe('PUT')
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/sys/audit/file`)

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].prior).toEqual({
        type: 'file',
        description: 'old',
        options: { file_path: '/old.log' },
      })
      // An update is not a create — rollback must restore, not delete.
      expect(createdPaths(result)).toEqual([])
      expect((result.artifacts as { reenabledDevices: string[] }).reenabledDevices).toEqual(['file'])
      expect(result.message).toMatch(/brief window with/)
    } finally {
      fetchStub.restore()
    }
  })

  it('records the prior config when the re-enable fails, so the blinded path is rollbackable', async () => {
    const fetchStub = recordFetch([
      listing({
        'file/': { type: 'file', description: 'old', options: { file_path: '/old.log' } },
      }),
      NO_CONTENT,
      FORBIDDEN,
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/could NOT be re-enabled/)
      expect(result.message).toMatch(/permission denied/)

      // The device is disabled RIGHT NOW — dropping this entry would leave the
      // security log permanently off with no record of what used to be there.
      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].prior).toEqual({
        type: 'file',
        description: 'old',
        options: { file_path: '/old.log' },
      })
      expect((result.artifacts as { reenabledDevices: string[] }).reenabledDevices).toEqual([])
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('claims nothing for rollback when the enable itself is rejected', async () => {
    const fetchStub = recordFetch([EMPTY_LIST, FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to enable audit device "file"/)
      expect(result.message).toMatch(/permission denied/)
      // Nothing was mounted, so rollback must not try to disable anything.
      expect(rollbackEntries(result)).toEqual([])
      expect(createdPaths(result)).toEqual([])
      expect((result.artifacts as { deployedDevices: string[] }).deployedDevices).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the device list cannot be read', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([FILE_DEVICE])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list audit devices/)
      expect((result.artifacts as { deployedDevices: string[] }).deployedDevices).toEqual([])
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('carries partial rollback state when a later device fails', async () => {
    const fetchStub = recordFetch([EMPTY_LIST, NO_CONTENT, FORBIDDEN])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { path: 'first', type: 'file', filePath: '/first.log' },
            { path: 'second', type: 'file', filePath: '/second.log' },
          ]),
        ),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 device/)
      // The first device really was enabled — rollback must know about it.
      expect((result.artifacts as { deployedDevices: string[] }).deployedDevices).toEqual(['first'])
      expect(rollbackEntries(result)).toEqual([{ path: 'first', existed: false }])
      expect(createdPaths(result)).toEqual(['first'])
    } finally {
      fetchStub.restore()
    }
  })

  it('matches a live device through the trailing slash Vault stores', async () => {
    const fetchStub = recordFetch([
      listing({ 'file/': { type: 'file', options: { file_path: '/var/log/vault-audit.log' } } }),
    ])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ ...FILE_DEVICE, path: '/file/' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections with no path or no type', async () => {
    const fetchStub = recordFetch([EMPTY_LIST])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ path: '', type: 'file' }, { path: 'file' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(1)
      expect((result.artifacts as { deployedDevices: string[] }).deployedDevices).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })
})
