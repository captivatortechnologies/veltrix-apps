// Unit tests for plannedStagingPlacements — which staging placements a target's
// role(s) call for. Pure (no network); the security/path checks live server-side.
import test from 'node:test'
import assert from 'node:assert/strict'
import { plannedStagingPlacements, resolveShclusterTargetUri } from '../deploy'

const FIELDS = {
  targetTypes: ['cluster-manager', 'deployer'],
  cmInstallDirs: ['etc/manager-apps', 'etc/apps'],
  deployerInstallDirs: ['etc/shcluster/apps'],
  dsInstallDirs: ['etc/deployment-apps'],
}

test('returns the staging dirs for roles the component has AND the app targets', () => {
  const out = plannedStagingPlacements(['cluster-manager'], FIELDS.targetTypes, FIELDS)
  assert.deepEqual(out, [{ role: 'cluster-manager', label: 'Cluster Manager', bundle: 'applyClusterBundle', dirs: ['etc/manager-apps'] }])
})

test('excludes etc/apps (REST handles it)', () => {
  const out = plannedStagingPlacements(['cluster-manager'], ['cluster-manager'], { cmInstallDirs: ['etc/apps'] })
  assert.deepEqual(out, [])
})

test('skips a role the component does not have', () => {
  assert.deepEqual(plannedStagingPlacements(['indexer'], FIELDS.targetTypes, FIELDS), [])
})

test('skips a role not in targetTypes even if the component has it', () => {
  const out = plannedStagingPlacements(['deployment-server'], ['cluster-manager'], { dsInstallDirs: ['etc/deployment-apps'] })
  assert.deepEqual(out, [])
})

test('maps each role to its bundle intent', () => {
  const cm = plannedStagingPlacements(['cluster-manager'], [], { cmInstallDirs: ['etc/manager-apps'] })
  const ds = plannedStagingPlacements(['deployment-server'], [], { dsInstallDirs: ['etc/deployment-apps'] })
  const dp = plannedStagingPlacements(['deployer'], [], { deployerInstallDirs: ['etc/shcluster/apps'] })
  assert.equal(cm[0].bundle, 'applyClusterBundle')
  assert.equal(ds[0].bundle, 'reloadDeployServer')
  assert.equal(dp[0].bundle, 'applyShclusterBundle')
})

test('indexer places into etc/peer-apps with no bundle push', () => {
  const ix = plannedStagingPlacements(['indexer'], ['indexer'], { indexerInstallDirs: ['etc/peer-apps', 'etc/apps'] })
  assert.deepEqual(ix, [{ role: 'indexer', label: 'Indexer', bundle: null, dirs: ['etc/peer-apps'] }])
})

// --- resolveShclusterTargetUri: the -target for `apply shcluster-bundle` --------
const platformWith = (members: Array<{ id: string; hostname: string; port: string }>) => ({
  listComponents: async () => members,
})

test('resolveShclusterTargetUri targets a search-head member (not the deployer) at its mgmt uri', async () => {
  const platform = platformWith([
    { id: 'deployer-1', hostname: 'splunk-mgr.babong.local', port: '8089' },
    { id: 'sh1', hostname: 'splunk-sh1.babong.local', port: '8089' },
  ])
  assert.equal(await resolveShclusterTargetUri(platform, 'deployer-1'), 'https://splunk-sh1.babong.local:8089')
})

test('resolveShclusterTargetUri defaults the member port to 8089', async () => {
  assert.equal(
    await resolveShclusterTargetUri(platformWith([{ id: 'sh1', hostname: 'sh1.local', port: '' }]), 'deployer-1'),
    'https://sh1.local:8089',
  )
})

test('resolveShclusterTargetUri falls back to the only member even if it is the deployer', async () => {
  assert.equal(
    await resolveShclusterTargetUri(platformWith([{ id: 'd1', hostname: 'shdeployer.local', port: '8089' }]), 'd1'),
    'https://shdeployer.local:8089',
  )
})

test('resolveShclusterTargetUri throws a clear error when no search-head is registered', async () => {
  await assert.rejects(
    () => resolveShclusterTargetUri(platformWith([]), 'deployer-1'),
    /search head cluster MEMBER/,
  )
})
