import driftDetect from '../driftDetect'
import {
  FORBIDDEN,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const FILE_DEVICE = { path: 'file', type: 'file', filePath: '/var/log/vault-audit.log' }

function ctx(
  devices: Array<Record<string, unknown>> = [FILE_DEVICE],
  o: { token?: string | null } = {},
) {
  return makeDriftContext(
    makeCanvas(
      devices.map((fields, i) => ({ name: `Device ${i + 1}`, fields })),
      'audit-devices',
    ),
    o,
  )
}

function listing(devices: Record<string, unknown>) {
  return { status: 200, body: { data: devices } }
}

describe('Vault Audit Devices Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx([FILE_DEVICE], { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live device matches', async () => {
    const fetchStub = recordFetch([
      listing({ 'file/': { type: 'file', options: { file_path: '/var/log/vault-audit.log' } } }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/audit`)
      expect(fetchStub.calls[0].method).toBe('GET')
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores Vault defaults this config does not manage', async () => {
    const fetchStub = recordFetch([
      listing({
        'file/': {
          type: 'file',
          description: 'edited out of band',
          options: {
            file_path: '/var/log/vault-audit.log',
            mode: '0600',
            format: 'json',
            hmac_accessor: 'true',
          },
        },
      }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a device that has been disabled out of band', async () => {
    const fetchStub = recordFetch([listing({})])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('file')
      expect(result.diffs[0].expected).toBe('exists')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a swapped backend type as critical drift', async () => {
    const fetchStub = recordFetch([
      listing({ 'file/': { type: 'socket', options: { file_path: '/var/log/vault-audit.log' } } }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('file.type')
      expect(result.diffs[0].expected).toBe('file')
      expect(result.diffs[0].actual).toBe('socket')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a redirected log target by naming the option that changed', async () => {
    const fetchStub = recordFetch([
      listing({ 'file/': { type: 'file', options: { file_path: '/tmp/elsewhere.log' } } }),
    ])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('file.options.file_path')
      expect(result.diffs[0].expected).toBe('/var/log/vault-audit.log')
      expect(result.diffs[0].actual).toBe('/tmp/elsewhere.log')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('reports a missing managed option as "not set" rather than blank', async () => {
    const fetchStub = recordFetch([listing({ 'file/': { type: 'file', options: {} } })])
    try {
      const result = await driftDetect(ctx())

      expect(result.diffs[0].actual).toBe('not set')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff per device rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(
        ctx([FILE_DEVICE, { path: 'syslog', type: 'syslog', syslogTag: 'vault' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(2)
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(String(result.diffs[0].actual)).toMatch(/permission denied/)
      expect(result.diffs[1].field).toBe('syslog')
      // One list call covers every device.
      expect(fetchStub.calls).toHaveLength(1)
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('checks every declared device from the single listing', async () => {
    const fetchStub = recordFetch([
      listing({
        'file/': { type: 'file', options: { file_path: '/var/log/vault-audit.log' } },
        'syslog/': { type: 'syslog', options: { tag: 'wrong' } },
      }),
    ])
    try {
      const result = await driftDetect(
        ctx([FILE_DEVICE, { path: 'syslog', type: 'syslog', syslogTag: 'vault' }]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('syslog.options.tag')
      expect(fetchStub.calls).toHaveLength(1)
    } finally {
      fetchStub.restore()
    }
  })
})
