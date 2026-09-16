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

const ACCESSOR = 'auth_userpass_1a2b3c4d'
const ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000001'
const OTHER_ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000002'
const KEY = `entity/${ACCESSOR}/alice`

const DECLARED = { kind: 'entity', name: 'alice', canonicalId: ENTITY_ID, mountAccessor: ACCESSOR }

const listOf = (keys: string[]) => ({ status: 200, body: { data: { keys } } })
const aliasAt = (data: Record<string, unknown>) => ({ status: 200, body: { data } })

function ctx(fields: Record<string, unknown>, o: { token?: string | null } = {}) {
  return makeDriftContext(makeCanvas([{ name: 'Alias 1', fields }], 'identity-aliases'), o)
}

describe('Vault Identity Aliases Drift Detect Handler', () => {
  it('reports no drift without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx(DECLARED, { token: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports no drift when the alias still binds the same entity', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt({ id: 'al-1', name: 'alice', canonical_id: ENTITY_ID, mount_accessor: ACCESSOR }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/entity-alias/id?list=true`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-1`)
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an alias that no longer exists as critical drift', async () => {
    const fetchStub = recordFetch([NOT_FOUND])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe(KEY)
      expect(result.diffs[0].expected).toBe('exists')
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('flags an alias re-pointed at another entity as a warning', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt({ id: 'al-1', name: 'alice', canonical_id: OTHER_ENTITY_ID, mount_accessor: ACCESSOR }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe(`${KEY}.canonicalId`)
      expect(result.diffs[0].expected).toBe(ENTITY_ID)
      expect(result.diffs[0].actual).toBe(OTHER_ENTITY_ID)
      expect(result.diffs[0].severity).toBe('warning')
    } finally {
      fetchStub.restore()
    }
  })

  it('renders an unbound alias as "not set" rather than an empty string', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt({ id: 'al-1', name: 'alice', canonical_id: '', mount_accessor: ACCESSOR }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actual).toBe('not set')
    } finally {
      fetchStub.restore()
    }
  })

  it('treats the same name on another mount accessor as a missing alias, not a changed one', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt({ id: 'al-1', name: 'alice', canonical_id: ENTITY_ID, mount_accessor: 'auth_oidc_99999999' }),
    ])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].actual).toBe('missing')
      expect(result.diffs[0].severity).toBe('critical')
    } finally {
      fetchStub.restore()
    }
  })

  it('does not diff custom_metadata — only the entity binding is managed', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt({
        id: 'al-1',
        name: 'alice',
        canonical_id: ENTITY_ID,
        mount_accessor: ACCESSOR,
        custom_metadata: { team: 'someone-else' },
      }),
    ])
    try {
      const result = await driftDetect(ctx({ ...DECLARED, customMetadataJson: '{"team":"platform"}' }))

      expect(result.hasDrift).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('records an unreachable diff rather than throwing when Vault errors', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await driftDetect(ctx(DECLARED))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe(KEY)
      expect(result.diffs[0].expected).toBe('reachable')
      expect(String(result.diffs[0].actual)).toMatch(/unreachable/)
      expect(result.diffs[0].severity).toBe('critical')
      assertNoTokenLeak(result.diffs)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps checking the remaining aliases after one errors', async () => {
    const canvas = makeCanvas(
      [
        { name: 'Alias 1', fields: DECLARED },
        { name: 'Alias 2', fields: { ...DECLARED, name: 'bob' } },
      ],
      'identity-aliases',
    )
    const fetchStub = recordFetch([
      FORBIDDEN,
      listOf(['al-2']),
      aliasAt({ id: 'al-2', name: 'bob', canonical_id: ENTITY_ID, mount_accessor: ACCESSOR }),
    ])
    try {
      const result = await driftDetect(makeDriftContext(canvas))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(fetchStub.calls).toHaveLength(3)
    } finally {
      fetchStub.restore()
    }
  })

  it('ignores sections missing any part of the alias binding', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await driftDetect(ctx({ ...DECLARED, mountAccessor: '' }))

      expect(result.hasDrift).toBe(false)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
