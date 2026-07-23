// Unit tests for plannedStagingPlacements — which staging placements a target's
// role(s) call for. Pure (no network); the security/path checks live server-side.
import test from 'node:test'
import assert from 'node:assert/strict'
import { plannedStagingPlacements } from '../deploy'

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
