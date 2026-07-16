import {
  readPanoramaSettings,
  resolvePanoramaApiKey,
  resolveLocation,
  locationLabel,
  parseEntries,
  extractXmlTag,
  panoramaErrorMessage,
  panoramaXmlErrorMessage,
  coerceBoolean,
  memberList,
  splitList,
  sameSet,
} from '../panorama'
import type { CredentialRef } from '@veltrixsecops/app-sdk'

function cred(overrides: Partial<CredentialRef>): CredentialRef {
  return { id: 'c1', name: 'test', username: '', password: '', apiToken: null, certificate: null, ...overrides }
}

describe('panorama lib — settings', () => {
  it('applies defaults', () => {
    const s = readPanoramaSettings({})
    expect(s.restApiVersion).toBe('v11.0')
    expect(s.deviceGroup).toBe('shared')
    expect(s.autoCommit).toBe(false)
    expect(s.verifyTls).toBe(true)
    expect(s.timeoutMs).toBe(30_000)
  })

  it('reads overrides and validates the version format', () => {
    const s = readPanoramaSettings({ device_group: 'DG-Edge', rest_api_version: 'v10.2', auto_commit: true, verify_tls: false, request_timeout_seconds: 10 })
    expect(s.deviceGroup).toBe('DG-Edge')
    expect(s.restApiVersion).toBe('v10.2')
    expect(s.autoCommit).toBe(true)
    expect(s.verifyTls).toBe(false)
    expect(s.timeoutMs).toBe(10_000)
  })

  it('ignores a malformed rest_api_version', () => {
    expect(readPanoramaSettings({ rest_api_version: '11.0' }).restApiVersion).toBe('v11.0')
    expect(readPanoramaSettings({ rest_api_version: 'latest' }).restApiVersion).toBe('v11.0')
  })
})

describe('panorama lib — credential', () => {
  it('prefers apiToken, falls back to password, else null', () => {
    expect(resolvePanoramaApiKey(cred({ apiToken: 'KEY123' }))).toBe('KEY123')
    expect(resolvePanoramaApiKey(cred({ password: 'PW123' }))).toBe('PW123')
    expect(resolvePanoramaApiKey(cred({ apiToken: '  ' }))).toBeNull()
    expect(resolvePanoramaApiKey(null)).toBeNull()
  })
})

describe('panorama lib — location', () => {
  it('maps shared to the shared location', () => {
    const loc = resolveLocation(readPanoramaSettings({ device_group: 'shared' }))
    expect(loc).toEqual({ location: 'shared', deviceGroup: null })
    expect(locationLabel(loc)).toBe('shared')
  })

  it('maps a named device group to location=device-group', () => {
    const loc = resolveLocation(readPanoramaSettings({ device_group: 'DG-Edge' }))
    expect(loc).toEqual({ location: 'device-group', deviceGroup: 'DG-Edge' })
    expect(locationLabel(loc)).toBe('device-group "DG-Edge"')
  })
})

describe('panorama lib — parsing', () => {
  it('parses a REST collection with an array of entries', () => {
    const body = JSON.stringify({ result: { entry: [{ '@name': 'a' }, { '@name': 'b' }] } })
    const parsed = parseEntries(body)
    expect(parsed.error).toBeNull()
    expect(parsed.value).toHaveLength(2)
  })

  it('normalizes a single-entry collection to an array', () => {
    const body = JSON.stringify({ result: { entry: { '@name': 'solo' } } })
    expect(parseEntries(body).value).toEqual([{ '@name': 'solo' }])
  })

  it('returns an empty array for a collection with no entries', () => {
    expect(parseEntries(JSON.stringify({ result: {} })).value).toEqual([])
  })

  it('reports invalid JSON without throwing', () => {
    expect(parseEntries('{not json').error).toBeTruthy()
    expect(parseEntries('{not json').value).toBeNull()
  })

  it('extracts an XML tag body and a status attribute', () => {
    const commit = '<response status="success" code="19"><result><job>42</job></result></response>'
    expect(extractXmlTag(commit, 'job')).toBe('42')
    expect(extractXmlTag(commit, 'response', true)).toBe('success')
    // A job-status poll nests <result>OK</result> inside <job>; scope to the job block.
    const job = '<response status="success"><result><job><id>42</id><status>FIN</status><result>OK</result></job></result></response>'
    const jobBlock = extractXmlTag(job, 'job') as string
    expect(extractXmlTag(jobBlock, 'status')).toBe('FIN')
    expect(extractXmlTag(jobBlock, 'result')).toBe('OK')
  })

  it('extracts a REST error message from JSON and XML', () => {
    expect(panoramaErrorMessage({ status: 400, ok: false, body: JSON.stringify({ message: 'bad thing' }) })).toBe('bad thing')
    expect(panoramaErrorMessage({ status: 400, ok: false, body: JSON.stringify({ result: { msg: { line: ['x', 'y'] } } }) })).toBe('x; y')
    expect(panoramaXmlErrorMessage({ status: 400, ok: false, body: '<response status="error"><msg><line>nope</line></msg></response>' })).toBe('nope')
  })
})

describe('panorama lib — helpers', () => {
  it('coerces booleans from mixed serializations', () => {
    expect(coerceBoolean('yes', false)).toBe(true)
    expect(coerceBoolean('false', true)).toBe(false)
    expect(coerceBoolean(1, false)).toBe(true)
    expect(coerceBoolean(undefined, true)).toBe(true)
  })

  it('wraps member lists and splits values', () => {
    expect(memberList(['a', 'b'])).toEqual({ member: ['a', 'b'] })
    expect(memberList([])).toBeUndefined()
    expect(splitList('a, b\nc')).toEqual(['a', 'b', 'c'])
    expect(splitList(['x', ' y '])).toEqual(['x', 'y'])
  })

  it('compares sets order-insensitively', () => {
    expect(sameSet(['a', 'b'], ['b', 'a'])).toBe(true)
    expect(sameSet(['a'], ['a', 'b'])).toBe(false)
  })
})
