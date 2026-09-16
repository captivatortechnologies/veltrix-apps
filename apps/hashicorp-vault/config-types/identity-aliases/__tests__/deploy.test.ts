import deploy, { type IdentityAliasRollbackEntry } from '../deploy'
import {
  FORBIDDEN,
  NOT_FOUND,
  VAULT_BASE,
  VAULT_TOKEN,
  assertNoTokenLeak,
  makeCanvas,
  makeDeployContext,
  recordFetch,
} from '../../../lib/__tests__/vaultTestHarness'

const ACCESSOR = 'auth_userpass_1a2b3c4d'
const ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000001'
const OTHER_ENTITY_ID = '8d4b0f0e-1a2b-4c3d-9e8f-000000000002'

const ALIAS = {
  kind: 'entity',
  name: 'alice',
  canonicalId: ENTITY_ID,
  mountAccessor: ACCESSOR,
}

function canvasWith(aliases: Array<Record<string, unknown>>) {
  return makeCanvas(
    aliases.map((fields, i) => ({ name: `Alias ${i + 1}`, fields })),
    'identity-aliases',
  )
}

function rollbackEntries(result: { rollbackData?: unknown }): IdentityAliasRollbackEntry[] {
  return (result.rollbackData as { previousState?: IdentityAliasRollbackEntry[] })?.previousState ?? []
}

function createdIds(result: { rollbackData?: unknown }): string[] {
  return (result.rollbackData as { createdIds?: string[] })?.createdIds ?? []
}

const listOf = (keys: string[]) => ({ status: 200, body: { data: { keys } } })
const aliasAt = (id: string, name: string, canonicalId: string, accessor = ACCESSOR) => ({
  status: 200,
  body: { data: { id, name, canonical_id: canonicalId, mount_accessor: accessor } },
})

describe('Vault Identity Aliases Deploy Handler', () => {
  it('refuses without a credential instead of calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS]), { token: null }))

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
      const result = await deploy(makeDeployContext(canvasWith([ALIAS]), { hostname: '' }))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Vault address/i)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })

  it('authenticates on its very first request and never leaks the token', async () => {
    const fetchStub = recordFetch([listOf([]), { status: 200, body: { data: { id: 'al-1' } } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

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

  it('creates the alias when the label lookup finds nothing, capturing the minted id', async () => {
    const fetchStub = recordFetch([listOf([]), { status: 200, body: { data: { id: 'al-new' } } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(2)

      const [list, create] = fetchStub.calls
      // A Vault LIST is a GET with ?list=true.
      expect(list.method).toBe('GET')
      expect(list.url).toBe(`${VAULT_BASE}/identity/entity-alias/id?list=true`)
      expect(create.method).toBe('POST')
      expect(create.url).toBe(`${VAULT_BASE}/identity/entity-alias`)
      expect(JSON.parse(create.body)).toEqual({
        name: 'alice',
        canonical_id: ENTITY_ID,
        mount_accessor: ACCESSOR,
      })

      const entries = rollbackEntries(result)
      expect(entries).toHaveLength(1)
      expect(entries[0].existed).toBe(false)
      // Without the server-assigned id, rollback cannot address the alias at all.
      expect(entries[0].aliasId).toBe('al-new')
      expect(createdIds(result)).toEqual(['al-new'])
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a 404 on the LIST as "no aliases yet" and creates', async () => {
    const fetchStub = recordFetch([NOT_FOUND, { status: 200, body: { data: { id: 'al-new' } } }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/entity-alias`)
    } finally {
      fetchStub.restore()
    }
  })

  it('reads each listed alias and updates the one whose (mount_accessor, name) matches', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1', 'al-2']),
      aliasAt('al-1', 'bob', OTHER_ENTITY_ID),
      aliasAt('al-2', 'alice', OTHER_ENTITY_ID),
      { status: 200, body: { data: { id: 'al-2' } } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(4)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-1`)
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-2`)
      // The write is addressed by the server-assigned id, never by name.
      expect(fetchStub.calls[3].method).toBe('POST')
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-2`)
      expect(JSON.parse(fetchStub.calls[3].body)).toEqual({
        name: 'alice',
        canonical_id: ENTITY_ID,
        mount_accessor: ACCESSOR,
      })

      const entries = rollbackEntries(result)
      expect(entries[0].existed).toBe(true)
      expect(entries[0].aliasId).toBe('al-2')
      expect(entries[0].priorCanonicalId).toBe(OTHER_ENTITY_ID)
      expect(createdIds(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('treats a same-name alias on a different mount accessor as a different alias', async () => {
    const fetchStub = recordFetch([
      listOf(['al-1']),
      aliasAt('al-1', 'alice', OTHER_ENTITY_ID, 'auth_oidc_99999999'),
      { status: 200, body: { data: { id: 'al-new' } } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(true)
      // No match on the (mount_accessor, name) pair, so a NEW alias is created.
      expect(fetchStub.calls[2].url).toBe(`${VAULT_BASE}/identity/entity-alias`)
      expect(rollbackEntries(result)[0].existed).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('skips a listed alias that has disappeared between the LIST and the read', async () => {
    const fetchStub = recordFetch([
      listOf(['al-gone', 'al-2']),
      NOT_FOUND,
      aliasAt('al-2', 'alice', OTHER_ENTITY_ID),
      { status: 200, body: { data: { id: 'al-2' } } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(true)
      expect(fetchStub.calls[3].url).toBe(`${VAULT_BASE}/identity/entity-alias/id/al-2`)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure when a created alias comes back without an id', async () => {
    const fetchStub = recordFetch([listOf([]), { status: 204, body: '' }])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/was created but the API returned no id/)
      // Nothing was recorded — an alias with no id cannot be rolled back.
      expect(rollbackEntries(result)).toHaveLength(0)
      expect(createdIds(result)).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('uses the group-alias namespace for kind=group', async () => {
    const fetchStub = recordFetch([listOf([]), { status: 200, body: { data: { id: 'gal-1' } } }])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([{ ...ALIAS, kind: 'group', name: 'engineering' }])),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls[0].url).toBe(`${VAULT_BASE}/identity/group-alias/id?list=true`)
      expect(fetchStub.calls[1].url).toBe(`${VAULT_BASE}/identity/group-alias`)
      expect(result.message).toMatch(/group\/auth_userpass_1a2b3c4d\/engineering/)
    } finally {
      fetchStub.restore()
    }
  })

  it('sends custom_metadata for an entity alias but never for a group alias', async () => {
    const fetchStub = recordFetch([
      listOf([]),
      { status: 200, body: { data: { id: 'al-1' } } },
      listOf([]),
      { status: 200, body: { data: { id: 'gal-1' } } },
    ])
    try {
      await deploy(
        makeDeployContext(
          canvasWith([
            { ...ALIAS, customMetadataJson: '{"team":"platform"}' },
            { ...ALIAS, kind: 'group', name: 'engineering', customMetadataJson: '{"team":"platform"}' },
          ]),
        ),
      )

      expect(JSON.parse(fetchStub.calls[1].body).custom_metadata).toEqual({ team: 'platform' })
      expect(fetchStub.calls[3].body.includes('custom_metadata')).toBe(false)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the referenced entity does not exist', async () => {
    const fetchStub = recordFetch([
      listOf([]),
      { status: 400, body: { errors: ['failed to find entity from given entity ID'] } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to create entity alias "entity\/auth_userpass_1a2b3c4d\/alice"/)
      expect(result.message).toMatch(/failed to find entity from given entity ID/)
      assertNoTokenLeak(result.message, result.artifacts, result.rollbackData)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the mount accessor is not a valid auth mount', async () => {
    const fetchStub = recordFetch([
      listOf([]),
      { status: 400, body: { errors: ['invalid mount accessor "auth_userpass_1a2b3c4d"'] } },
    ])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/invalid mount accessor/)
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when the LIST is rejected', async () => {
    const fetchStub = recordFetch([FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to list entity aliases/)
      expect(result.message).toMatch(/permission denied/)
      expect((result.artifacts as { deployedAliases: string[] }).deployedAliases).toEqual([])
    } finally {
      fetchStub.restore()
    }
  })

  it('reports failure rather than throwing when reading a listed alias errors', async () => {
    const fetchStub = recordFetch([listOf(['al-1']), FORBIDDEN])
    try {
      const result = await deploy(makeDeployContext(canvasWith([ALIAS])))

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/Failed to read entity alias al-1/)
    } finally {
      fetchStub.restore()
    }
  })

  it('keeps the first alias rollbackable when a later one fails', async () => {
    const fetchStub = recordFetch([
      listOf([]),
      { status: 200, body: { data: { id: 'al-1' } } },
      listOf(['al-2']),
      aliasAt('al-2', 'bob', OTHER_ENTITY_ID),
      FORBIDDEN,
    ])
    try {
      const result = await deploy(
        makeDeployContext(canvasWith([ALIAS, { ...ALIAS, name: 'bob' }])),
      )

      expect(result.success).toBe(false)
      expect(result.message).toMatch(/after 1 of 2 alias/)
      expect((result.artifacts as { deployedAliases: string[] }).deployedAliases).toEqual([
        'entity/auth_userpass_1a2b3c4d/alice',
      ])
      // The first alias really was created, and the second's prior id/canonical_id
      // was captured before the failed write.
      expect(rollbackEntries(result)).toHaveLength(2)
      expect(rollbackEntries(result)[0].aliasId).toBe('al-1')
      expect(rollbackEntries(result)[1].existed).toBe(true)
      expect(rollbackEntries(result)[1].priorCanonicalId).toBe(OTHER_ENTITY_ID)
      expect(createdIds(result)).toEqual(['al-1'])
    } finally {
      fetchStub.restore()
    }
  })

  it('skips sections missing any part of the alias binding without calling Vault', async () => {
    const fetchStub = recordFetch([])
    try {
      const result = await deploy(
        makeDeployContext(
          canvasWith([
            { ...ALIAS, canonicalId: '' },
            { ...ALIAS, mountAccessor: '' },
            { ...ALIAS, kind: 'nonsense' },
            { ...ALIAS, name: '' },
          ]),
        ),
      )

      expect(result.success).toBe(true)
      expect(fetchStub.calls).toHaveLength(0)
    } finally {
      fetchStub.restore()
    }
  })
})
