import driftDetect from '../driftDetect'
import {
  AUTH_TOKEN,
  EMPTY_SEARCH,
  NO_ORG_KEY_SETTINGS,
  ORG_KEY,
  cbError,
  driftContext,
  searchPage,
  withFetch,
  type ItemInput,
} from '../../../lib/__tests__/fakeCb'

const CONFIG_TYPE = 'reputation-overrides'
const SEARCH = `/appservices/v6/orgs/${ORG_KEY}/reputations/overrides/_search`

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

function ctx(items: ItemInput[], opts: Record<string, unknown> = {}) {
  return driftContext({ configTypeId: CONFIG_TYPE, items, ...opts })
}

function override(fields: Record<string, unknown>): ItemInput {
  return { name: String(fields.label ?? ''), fields }
}

const DEPLOYED = override({
  label: 'Bad exe',
  overrideList: 'BLACK_LIST',
  overrideType: 'SHA256',
  sha256Hash: HASH,
  filename: 'bad.exe',
  description: 'ban it',
})

const IN_SYNC = {
  id: 'ov-1',
  override_list: 'BLACK_LIST',
  override_type: 'SHA256',
  sha256_hash: HASH,
  filename: 'bad.exe',
  description: 'ban it',
}

function fields(result: { diffs: Array<{ field: string }> }): string[] {
  return result.diffs.map((d) => d.field)
}

describe('carbon-black reputation-overrides driftDetect handler', () => {
  it('reports no drift without a credential instead of calling the vendor', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { credential: null }))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(0)
    })
  })

  it('reports no drift when the Org Key setting is blank', async () => {
    await withFetch([], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED], { settings: NO_ORG_KEY_SETTINGS }))

      expect(result.hasDrift).toBe(false)
      expect(calls).toHaveLength(0)
    })
  })

  it('finds no drift when the live override matches what was deployed', async () => {
    await withFetch([searchPage([IN_SYNC])], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
      expect(calls).toHaveLength(1)
      expect(calls[0].path).toBe(SEARCH)
      expect(calls[0].authToken).toBe(AUTH_TOKEN)
    })
  })

  it('flags a deleted override as critical — the banned binary is running unblocked', async () => {
    await withFetch([EMPTY_SEARCH], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(result.diffs).toHaveLength(1)
      expect(result.diffs[0].field).toBe('Bad exe')
      expect(result.diffs[0].expected).toBe('present')
      expect(result.diffs[0].actual).toBe('absent')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('flags a ban flipped to an allow out of band', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, override_list: 'WHITE_LIST' }])], async (calls) => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(calls).toHaveLength(1)
      const diff = result.diffs.find((d) => d.field === 'Bad exe.override_list')!
      expect(diff.expected).toBe('BLACK_LIST')
      expect(diff.actual).toBe('WHITE_LIST')
      expect(diff.severity).toBe('warning')
    })
  })

  it('flags an edited description', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, description: 'edited' }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(true)
      expect(fields(result)).toContain('Bad exe.description')
      const diff = result.diffs.find((d) => d.field === 'Bad exe.description')!
      expect(diff.expected).toBe('ban it')
      expect(diff.actual).toBe('edited')
    })
  })

  it('flags list and description drift together', async () => {
    await withFetch(
      [searchPage([{ ...IN_SYNC, override_list: 'WHITE_LIST', description: 'edited' }])],
      async () => {
        const result = await driftDetect(ctx([DEPLOYED]))

        expect(result.diffs).toHaveLength(2)
        expect(fields(result)).toContain('Bad exe.override_list')
        expect(fields(result)).toContain('Bad exe.description')
      },
    )
  })

  it('flags an IT_TOOL override whose child-process coverage was turned off', async () => {
    const tool = override({
      label: 'Admin tool',
      overrideList: 'WHITE_LIST',
      overrideType: 'IT_TOOL',
      path: 'C:\\tools\\*.exe',
      includeChildProcesses: true,
    })
    const live = {
      id: 'ov-2',
      override_list: 'WHITE_LIST',
      override_type: 'IT_TOOL',
      path: 'C:\\tools\\*.exe',
      include_child_processes: false,
    }
    await withFetch([searchPage([live])], async () => {
      const result = await driftDetect(ctx([tool]))

      expect(result.hasDrift).toBe(true)
      const diff = result.diffs.find((d) => d.field === 'Admin tool.include_child_processes')!
      expect(diff.expected).toBe(true)
      expect(diff.actual).toBe(false)
    })
  })

  it('treats a CERT override re-issued under a different authority as absent', async () => {
    const cert = override({
      label: 'Vendor cert',
      overrideList: 'WHITE_LIST',
      overrideType: 'CERT',
      signedBy: 'VMware Inc.',
      certificateAuthority: 'DigiCert',
    })
    const live = {
      id: 'ov-3',
      override_list: 'WHITE_LIST',
      override_type: 'CERT',
      signed_by: 'VMware Inc.',
      certificate_authority: 'GlobalSign',
    }
    await withFetch([searchPage([live])], async () => {
      const result = await driftDetect(ctx([cert]))

      // The authority is part of the identity, so this is a different override
      // and the declared one is simply gone.
      expect(result.hasDrift).toBe(true)
      expect(result.diffs[0].field).toBe('Vendor cert')
      expect(result.diffs[0].severity).toBe('critical')
    })
  })

  it('matches the live override however the vendor cases the hash', async () => {
    await withFetch([searchPage([{ ...IN_SYNC, sha256_hash: HASH.toUpperCase() }])], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      expect(result.hasDrift).toBe(false)
    })
  })

  it('reports no drift when the vendor listing fails, rather than inventing absences', async () => {
    await withFetch([cbError('service unavailable', 503)], async () => {
      const result = await driftDetect(ctx([DEPLOYED]))

      // A handler that cannot read live state must not claim everything is gone.
      expect(result.hasDrift).toBe(false)
      expect(result.diffs).toHaveLength(0)
    })
  })
})
