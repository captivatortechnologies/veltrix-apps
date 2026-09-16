import driftDetect from '../driftDetect'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  assertNoTokenLeak,
  makeCanvas,
  makeDriftContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const METADATA = '{"team":"platform"}'

function ctx(
  namespaces: Array<Record<string, unknown>> = [{ path: 'team-a', customMetadataJson: METADATA }],
  o: { token?: string | null } = {},
) {
  return makeDriftContext(
    makeCanvas(
      namespaces.map((fields, i) => ({ name: `Namespace ${i + 1}`, fields })),
      'namespaces',
    ),
    o,
  )
}

function live(customMetadata?: Record<string, string>) {
  return { status: 200, body: { data: { path: 'team-a/', custom_metadata: customMetadata } } }
}

describe('Vault Namespaces Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(
        ctx([{ path: 'team-a', customMetadataJson: METADATA }], { token: null }),
      )

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the live metadata matches', async () => {
    const fetchStub = recordFetch([live({ team: 'platform' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls[0].method).toBe('GET')
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/sys/namespaces/team-a`)
    } finally {
      fetchStub.restore()
    }
  })

  it('treats malformed authored metadata as no metadata rather than drift', async () => {
    const fetchStub = recordFetch([live()])
    try {
      const result = await driftDetect(ctx([{ path: 'team-a', customMetadataJson: 'not json' }]))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a namespace deleted out of band as critical', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('team-a')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('names the metadata key whose value changed', async () => {
    const fetchStub = recordFetch([live({ team: 'someone-else' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('team-a.customMetadata.team')
      expect(result.diffs[0].expected).toBe('platform')
      expect(result.diffs[0].actual).toBe('someone-else')
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a metadata key added out of band', async () => {
    const fetchStub = recordFetch([live({ team: 'platform', backdoor: 'yes' })])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('team-a.customMetadata.backdoor')
      expect(result.diffs[0].expected).toBe('not set')
      expect(result.diffs[0].actual).toBe('yes')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags a declared metadata key that is missing live', async () => {
    const fetchStub = recordFetch([live()])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('team-a.customMetadata.team')
      expect(result.diffs[0].actual).toBe('not set')
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx())

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('team-a')
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining namespaces after one errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN, { status: 200, body: { data: { path: 'team-b/' } } }])
    try {
      const result = await driftDetect(
        ctx([
          { path: 'team-a', customMetadataJson: METADATA },
          { path: 'team-b' },
        ]),
      )

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(2)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/sys/namespaces/team-b`)
    } finally {
      fetchStub.restore()
    }
  })
})
