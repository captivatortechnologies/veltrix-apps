import {
  parseConfigLogEntries,
  pickActorFromEvents,
  entryReferencesObject,
  buildConfigLogQuery,
  resolveDriftActor,
  attachDriftActor,
  veltrixActorLogins,
  type ConfigLogEntry,
  type ConfigLogClient,
  type DriftActor,
} from '../panoramaAudit'

// A realistic config-log poll body: three rows for the object "web-1" — a
// Veltrix-service `set`, a human `edit`, and a human `commit` (activation only).
const LOG_BODY = `<response status="success"><result>
  <job><id>7</id><status>FIN</status></job>
  <log><logs count="3" progress="100">
    <entry logid="1"><admin>veltrix-svc</admin><cmd>set</cmd><time_generated>2026/07/21 09:00:00</time_generated><path>address/entry[@name='web-1']/ip-netmask</path><full-path>config/devices/entry/device-group/entry[@name='DG']/address/entry[@name='web-1']/ip-netmask</full-path><result>Succeeded</result></entry>
    <entry logid="2"><admin>alice</admin><cmd>edit</cmd><time_generated>2026/07/21 10:30:00</time_generated><path>address/entry[@name='web-1']/ip-netmask</path><full-path>config/devices/entry/device-group/entry[@name='DG']/address/entry[@name='web-1']/ip-netmask</full-path><result>Succeeded</result></entry>
    <entry logid="3"><admin>bob</admin><cmd>commit</cmd><time_generated>2026/07/21 11:00:00</time_generated><path>address/entry[@name='web-1']</path><full-path>config/devices/entry/device-group/entry[@name='DG']/address/entry[@name='web-1']</full-path><result>Succeeded</result></entry>
  </logs></log>
</result></response>`

function fakeClient(body: string, ok = true): ConfigLogClient {
  return { fetchConfigLog: async () => ({ ok, body }) }
}

function throwingClient(): ConfigLogClient {
  return {
    fetchConfigLog: async () => {
      throw new Error('network down')
    },
  }
}

function entry(overrides: Partial<ConfigLogEntry>): ConfigLogEntry {
  return { admin: 'alice', cmd: 'set', timeGenerated: '2026/07/21 10:00:00', result: 'Succeeded', ...overrides }
}

describe('panoramaAudit — parseConfigLogEntries', () => {
  it('parses each <entry> row and its fields', () => {
    const rows = parseConfigLogEntries(LOG_BODY)
    expect(rows).toHaveLength(3)
    expect(rows[0].admin).toBe('veltrix-svc')
    expect(rows[0].cmd).toBe('set')
    expect(rows[0].timeGenerated).toBe('2026/07/21 09:00:00')
    expect(rows[0].result).toBe('Succeeded')
    expect(rows[1].admin).toBe('alice')
    // path and full-path are distinct tags — do not conflate them.
    expect(rows[1].path).toBe("address/entry[@name='web-1']/ip-netmask")
    expect(rows[1].fullPath).toContain("device-group/entry[@name='DG']")
  })

  it('returns an empty array for empty or non-log XML', () => {
    expect(parseConfigLogEntries('')).toEqual([])
    expect(parseConfigLogEntries('<response status="success"><result/></response>')).toEqual([])
  })
})

describe('panoramaAudit — pickActorFromEvents', () => {
  it('returns undefined for an empty list', () => {
    expect(pickActorFromEvents([])).toBeUndefined()
  })

  it('prefers an edit over an activation-only commit', () => {
    const rows: ConfigLogEntry[] = [
      entry({ admin: 'bob', cmd: 'commit', timeGenerated: '2026/07/21 11:00:00' }),
      entry({ admin: 'alice', cmd: 'edit', timeGenerated: '2026/07/21 10:30:00' }),
    ]
    const actor = pickActorFromEvents(rows)
    expect(actor?.name).toBe('alice')
    expect(actor?.eventType).toBe('edit')
    expect(actor?.at).toBe('2026/07/21 10:30:00')
    expect(actor?.source).toBe('panorama-audit')
  })

  it('excludes the Veltrix admin so the manual change wins', () => {
    const rows = parseConfigLogEntries(LOG_BODY)
    // Without exclusion the newest change is the veltrix-svc set-vs-alice edit;
    // excluding veltrix-svc must still resolve alice (the human editor).
    const actor = pickActorFromEvents(rows, ['veltrix-svc'])
    expect(actor?.name).toBe('alice')
    expect(actor?.eventType).toBe('edit')
  })

  it('falls back to the most recent row when no cmd is an edit', () => {
    const rows: ConfigLogEntry[] = [
      entry({ admin: 'bob', cmd: 'commit', timeGenerated: '2026/07/21 09:00:00' }),
      entry({ admin: 'carol', cmd: 'validate', timeGenerated: '2026/07/21 12:00:00' }),
    ]
    expect(pickActorFromEvents(rows)?.name).toBe('carol')
  })

  it('skips rows with no admin or a non-succeeded result', () => {
    const rows: ConfigLogEntry[] = [
      entry({ admin: '', cmd: 'set', timeGenerated: '2026/07/21 13:00:00' }),
      entry({ admin: 'dave', cmd: 'set', result: 'Failed', timeGenerated: '2026/07/21 12:00:00' }),
      entry({ admin: 'erin', cmd: 'set', timeGenerated: '2026/07/21 10:00:00' }),
    ]
    expect(pickActorFromEvents(rows)?.name).toBe('erin')
  })

  it('returns undefined when every row is excluded', () => {
    const rows: ConfigLogEntry[] = [entry({ admin: 'veltrix-svc' })]
    expect(pickActorFromEvents(rows, ['veltrix-svc'])).toBeUndefined()
  })
})

describe('panoramaAudit — entryReferencesObject', () => {
  it('matches the object name at a token boundary', () => {
    const rows = parseConfigLogEntries(LOG_BODY)
    expect(entryReferencesObject(rows[0], 'web-1')).toBe(true)
  })

  it('does not mistake a short name for a longer one', () => {
    const row = entry({ path: "address/entry[@name='web-server']/ip-netmask", fullPath: '' })
    expect(entryReferencesObject(row, 'web')).toBe(false)
    expect(entryReferencesObject(row, 'web-server')).toBe(true)
  })

  it('returns false when the row has no path', () => {
    expect(entryReferencesObject(entry({ path: '', fullPath: '' }), 'web-1')).toBe(false)
  })
})

describe('panoramaAudit — buildConfigLogQuery', () => {
  it('builds a path-contains filter for a plain name', () => {
    expect(buildConfigLogQuery('web-1')).toBe("(path contains 'web-1')")
  })

  it('returns null for an empty name or a name with a quote', () => {
    expect(buildConfigLogQuery('')).toBeNull()
    expect(buildConfigLogQuery("o'brien")).toBeNull()
  })
})

describe('panoramaAudit — resolveDriftActor', () => {
  it('resolves the last human change correlated to the object', async () => {
    const actor = await resolveDriftActor(fakeClient(LOG_BODY), {
      objectName: 'web-1',
      excludeActorLogins: ['veltrix-svc'],
    })
    expect(actor?.name).toBe('alice')
    expect(actor?.eventType).toBe('edit')
  })

  it('returns undefined when the log call is not ok', async () => {
    const actor = await resolveDriftActor(fakeClient('', false), { objectName: 'web-1' })
    expect(actor).toBeUndefined()
  })

  it('returns undefined when no row correlates to the object', async () => {
    const actor = await resolveDriftActor(fakeClient(LOG_BODY), { objectName: 'db-9' })
    expect(actor).toBeUndefined()
  })

  it('returns undefined for a name that cannot be safely queried', async () => {
    const actor = await resolveDriftActor(fakeClient(LOG_BODY), { objectName: "o'brien" })
    expect(actor).toBeUndefined()
  })

  it('never throws — a failing client yields undefined', async () => {
    const actor = await resolveDriftActor(throwingClient(), { objectName: 'web-1' })
    expect(actor).toBeUndefined()
  })
})

describe('panoramaAudit — attachDriftActor', () => {
  it('sets the resolved actor on every diff for the object', async () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [
      { field: 'web-1.ip-netmask' },
      { field: 'web-1.description' },
    ]
    await attachDriftActor(fakeClient(LOG_BODY), diffs, {
      objectName: 'web-1',
      excludeActorLogins: ['veltrix-svc'],
    })
    expect(diffs[0].actor?.name).toBe('alice')
    expect(diffs[1].actor?.name).toBe('alice')
  })

  it('is a no-op when there are no diffs', async () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = []
    await attachDriftActor(fakeClient(LOG_BODY), diffs, { objectName: 'web-1' })
    expect(diffs).toHaveLength(0)
  })

  it('leaves diffs unattributed when no actor is resolved', async () => {
    const diffs: Array<{ field: string; actor?: DriftActor }> = [{ field: 'web-1.ip-netmask' }]
    await attachDriftActor(fakeClient('', false), diffs, { objectName: 'web-1' })
    expect(diffs[0].actor).toBeUndefined()
  })
})

describe('panoramaAudit — veltrixActorLogins', () => {
  it('returns the credential username when present', () => {
    expect(veltrixActorLogins({ username: 'panorama-admin' })).toEqual(['panorama-admin'])
  })

  it('returns an empty list for a blank or missing username', () => {
    expect(veltrixActorLogins({ username: '  ' })).toEqual([])
    expect(veltrixActorLogins(null)).toEqual([])
    expect(veltrixActorLogins(undefined)).toEqual([])
  })
})
