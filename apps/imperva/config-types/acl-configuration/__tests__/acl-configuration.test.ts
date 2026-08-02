import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PipelineContext } from '@veltrixsecops/app-sdk'
import validate from '../validate'
import {
  classifyAcl,
  toList,
  readAclFields,
  declaredAclValues,
  aclParamsFromValues,
  aclRestoreParams,
  aclRulesFromStatus,
  findAclRule,
  liveAclValues,
  sameSet,
  urlPairs,
} from '../_shared'

/**
 * The deploy/rollback/drift handlers call the Cloud WAF v1 API via fetch, which is
 * impractical to mock here. Tests cover validate.ts and the pure _shared helpers.
 */
function toItems(list: Array<Record<string, unknown>>) {
  return list.map((fields, i) => ({ id: `i${i}`, name: String(fields.aclId ?? i), fields }))
}
function ctxOf(list: Array<Record<string, unknown>>): PipelineContext {
  return { canvas: { items: toItems(list) } } as unknown as PipelineContext
}

const ipAcl = { siteId: '123456', aclId: 'api.acl.blacklisted_ips', ips: ['1.2.3.4', '10.0.0.0/24'] }
const geoAcl = { siteId: '123456', aclId: 'api.acl.blacklisted_countries', countries: ['CN', 'RU'], continents: ['AF'] }
const urlAcl = { siteId: '123456', aclId: 'api.acl.blacklisted_urls', urls: ['/admin', '/wp-login.php'], urlPatterns: ['EQUALS', 'CONTAINS'] }

// --- validate ---------------------------------------------------------------

test('validate accepts an IP, country and URL ACL', async () => {
  for (const good of [ipAcl, geoAcl, urlAcl]) {
    const res = await validate(ctxOf([good]))
    assert.equal(res.valid, true, JSON.stringify(res.errors))
  }
})

test('validate rejects a missing / non-numeric site ID', async () => {
  assert.ok((await validate(ctxOf([{ ...ipAcl, siteId: '' }]))).errors.some((e) => e.code === 'EMPTY_SITE_ID'))
  assert.ok((await validate(ctxOf([{ ...ipAcl, siteId: 'x' }]))).errors.some((e) => e.code === 'INVALID_SITE_ID'))
})

test('validate rejects an unknown ACL type', async () => {
  const res = await validate(ctxOf([{ ...ipAcl, aclId: 'api.acl.unknown' }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_ACL_ID'))
})

test('validate warns when an IP list is empty (clears the ACL)', async () => {
  const res = await validate(ctxOf([{ ...ipAcl, ips: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_IPS'))
})

test('validate warns when a country blacklist is empty', async () => {
  const res = await validate(ctxOf([{ ...geoAcl, countries: [], continents: [] }]))
  assert.equal(res.valid, true)
  assert.ok(res.warnings.some((w) => w.code === 'EMPTY_GEO'))
})

test('validate requires urls + patterns of equal length for a URL blacklist', async () => {
  assert.ok((await validate(ctxOf([{ ...urlAcl, urls: [] }]))).errors.some((e) => e.code === 'EMPTY_URLS'))
  assert.ok((await validate(ctxOf([{ ...urlAcl, urlPatterns: [] }]))).errors.some((e) => e.code === 'EMPTY_URL_PATTERNS'))
  assert.ok((await validate(ctxOf([{ ...urlAcl, urlPatterns: ['EQUALS'] }]))).errors.some((e) => e.code === 'URL_PATTERN_MISMATCH'))
})

test('validate rejects an unsupported URL pattern', async () => {
  const res = await validate(ctxOf([{ ...urlAcl, urlPatterns: ['EQUALS', 'REGEX'] }]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'INVALID_URL_PATTERN'))
})

test('validate accepts every URL pattern', async () => {
  for (const p of ['CONTAINS', 'EQUALS', 'PREFIX', 'SUFFIX', 'NOT_EQUALS', 'NOT_CONTAIN', 'NOT_PREFIX', 'NOT_SUFFIX']) {
    const res = await validate(ctxOf([{ siteId: '1', aclId: 'api.acl.blacklisted_urls', urls: ['/x'], urlPatterns: [p] }]))
    assert.equal(res.valid, true, `${p}: ${JSON.stringify(res.errors)}`)
  }
})

test('validate warns on a duplicate (site, ACL type) and allows the same ACL on another site', async () => {
  assert.ok((await validate(ctxOf([ipAcl, { ...ipAcl }]))).warnings.some((w) => w.code === 'DUPLICATE_ACL'))
  assert.ok(!(await validate(ctxOf([ipAcl, { ...ipAcl, siteId: '999' }]))).warnings.some((w) => w.code === 'DUPLICATE_ACL'))
})

test('validate errors when there are no items', async () => {
  const res = await validate(ctxOf([]))
  assert.equal(res.valid, false)
  assert.ok(res.errors.some((e) => e.code === 'EMPTY'))
})

// --- _shared helpers --------------------------------------------------------

test('classifyAcl maps ACL ids to their value family', () => {
  assert.equal(classifyAcl('api.acl.blacklisted_ips'), 'ips')
  assert.equal(classifyAcl('api.acl.whitelisted_ips'), 'ips')
  assert.equal(classifyAcl('api.acl.blacklisted_countries'), 'geo')
  assert.equal(classifyAcl('api.acl.blacklisted_urls'), 'urls')
  assert.equal(classifyAcl('api.acl.nope'), null)
})

test('toList accepts arrays and comma/newline strings, dropping blanks', () => {
  assert.deepEqual(toList(['a', ' b ', '']), ['a', 'b'])
  assert.deepEqual(toList('a, b\nc,'), ['a', 'b', 'c'])
  assert.deepEqual(toList(undefined), [])
})

test('aclParamsFromValues mirrors the provider — ips/urls always sent, geo omits empty', () => {
  assert.deepEqual(aclParamsFromValues('ips', declaredAclValues(readAclFields(ipAcl))), { ips: '1.2.3.4,10.0.0.0/24' })
  assert.deepEqual(aclParamsFromValues('urls', declaredAclValues(readAclFields(urlAcl))), { urls: '/admin,/wp-login.php', url_patterns: 'EQUALS,CONTAINS' })
  assert.deepEqual(aclParamsFromValues('geo', declaredAclValues(readAclFields(geoAcl))), { countries: 'CN,RU', continents: 'AF' })
  assert.deepEqual(aclParamsFromValues('geo', declaredAclValues(readAclFields({ ...geoAcl, countries: [], continents: [] }))), {})
})

test('aclRestoreParams always sends geo params so an empty prior clears the list', () => {
  assert.deepEqual(aclRestoreParams('geo', declaredAclValues(readAclFields({ ...geoAcl, countries: [], continents: [] }))), { countries: '', continents: '' })
  assert.deepEqual(aclRestoreParams('ips', declaredAclValues(readAclFields({ ...ipAcl, ips: [] }))), { ips: '' })
})

test('aclRulesFromStatus + findAclRule + liveAclValues read the status envelope', () => {
  const status = {
    res: 0,
    security: {
      acls: {
        rules: [
          { id: 'api.acl.blacklisted_ips', ips: ['9.9.9.9'] },
          { id: 'api.acl.blacklisted_countries', geo: { countries: ['US'], continents: ['NA'] } },
          { id: 'api.acl.blacklisted_urls', urls: [{ value: '/a', pattern: 'EQUALS' }] },
        ],
      },
    },
  }
  const rules = aclRulesFromStatus(status)
  assert.equal(rules.length, 3)
  assert.deepEqual(liveAclValues(findAclRule(rules, 'api.acl.blacklisted_ips')!).ips, ['9.9.9.9'])
  const geo = liveAclValues(findAclRule(rules, 'api.acl.blacklisted_countries')!)
  assert.deepEqual(geo.countries, ['US'])
  assert.deepEqual(geo.continents, ['NA'])
  const urls = liveAclValues(findAclRule(rules, 'api.acl.blacklisted_urls')!)
  assert.deepEqual(urls.urls, ['/a'])
  assert.deepEqual(urls.urlPatterns, ['EQUALS'])
  assert.equal(findAclRule(rules, 'api.acl.missing'), null)
  assert.deepEqual(aclRulesFromStatus({ res: 0 }), [])
  assert.deepEqual(aclRulesFromStatus(null), [])
})

test('sameSet is order-insensitive and urlPairs zips value|pattern', () => {
  assert.equal(sameSet(['a', 'b'], ['b', 'a']), true)
  assert.equal(sameSet(['a'], ['a', 'b']), false)
  assert.deepEqual(urlPairs(declaredAclValues(readAclFields(urlAcl))), ['/admin|EQUALS', '/wp-login.php|CONTAINS'])
})
