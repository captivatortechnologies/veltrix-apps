// =============================================================================
// Unit tests for the PURE Splunk inventory derivation (inventory.ts).
//
// Run with the Node built-in test runner via the repo's ts-node ESM loader:
//   node --loader ts-node/esm --test src/services/splunk/__tests__/inventory.test.ts
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInventoryModel,
  deriveInventory,
  naturalCompare,
  normalizePlan,
  toInventoryYaml,
} from '../inventory.js';
import { RawPlanItem, TofuOutputs } from '../types.js';

/** Build a tofu-output object with private IPs (+ optional fqdns) per plan_key. */
function tofu(ips: Record<string, string>, fqdns?: Record<string, string>): TofuOutputs {
  const out: TofuOutputs = { instance_private_ips: { value: ips } };
  if (fqdns) out.node_fqdns = { value: fqdns };
  return out;
}

/** A full distributed plan: 1 CM, 3 indexers, 3 SHC members, 1 deployer, 1 HF. */
function distributedPlan(): RawPlanItem[] {
  return [
    { planKey: 'control-plane/cluster-manager-1', tier: 'control-plane', kind: 'cluster-manager' },
    { planKey: 'search/sh-deployer-1', tier: 'search', kind: 'sh-deployer' },
    { planKey: 'data/indexer-1', tier: 'data', kind: 'indexer' },
    { planKey: 'data/indexer-2', tier: 'data', kind: 'indexer' },
    { planKey: 'data/indexer-3', tier: 'data', kind: 'indexer' },
    { planKey: 'search/search-head-1', tier: 'search', kind: 'search-head' },
    { planKey: 'search/search-head-2', tier: 'search', kind: 'search-head' },
    { planKey: 'search/search-head-3', tier: 'search', kind: 'search-head' },
    { planKey: 'ingest/heavy-forwarder-1', tier: 'ingest', kind: 'heavy-forwarder' },
  ];
}

function distributedIps(): Record<string, string> {
  return {
    'control-plane/cluster-manager-1': '10.0.0.10',
    'search/sh-deployer-1': '10.0.0.11',
    'data/indexer-1': '10.0.0.21',
    'data/indexer-2': '10.0.0.22',
    'data/indexer-3': '10.0.0.23',
    'search/search-head-1': '10.0.0.31',
    'search/search-head-2': '10.0.0.32',
    'search/search-head-3': '10.0.0.33',
    'ingest/heavy-forwarder-1': '10.0.0.41',
  };
}

test('naturalCompare orders indexer-2 before indexer-10 (numeric-aware)', () => {
  const sorted = ['idx-10', 'idx-2', 'idx-1'].sort(naturalCompare);
  assert.deepEqual(sorted, ['idx-1', 'idx-2', 'idx-10']);
});

test('normalizePlan accepts camelCase, snake_case, and a {plan:[...]} wrapper', () => {
  const camel = normalizePlan([{ planKey: 'a/b', kind: 'indexer' }]);
  const snake = normalizePlan([{ plan_key: 'a/b', kind: 'indexer' } as RawPlanItem]);
  const wrapped = normalizePlan({ plan: [{ plan_key: 'a/b', kind: 'indexer' }] });
  assert.equal(camel[0].planKey, 'a/b');
  assert.equal(snake[0].planKey, 'a/b');
  assert.equal(wrapped[0].planKey, 'a/b');
});

test('group assignment: each kind lands in its splunk-ansible group', () => {
  const m = buildInventoryModel(distributedPlan(), tofu(distributedIps()), { dnsDomain: 'ex.internal' });
  assert.deepEqual(m.groups.cluster_manager, ['mgmt1']);
  assert.deepEqual(m.groups.cluster_indexer, ['idx1', 'idx2', 'idx3']);
  assert.deepEqual(m.groups.cluster_search_head, ['sh1', 'sh2', 'sh3']);
  assert.deepEqual(m.groups.search_head_deployer, ['depl1']);
  assert.deepEqual(m.groups.heavy_forwarder, ['hf1']);
  // SPLUNK_ROLE per host.
  const idx1 = m.hosts.find((h) => h.alias === 'idx1')!;
  assert.equal(idx1.splunkRole, 'splunk_indexer');
  assert.equal(idx1.ansibleHost, '10.0.0.21');
});

test('ordinal + FQDN derivation: node_fqdns wins, else <prefix><ordinal>.<domain>', () => {
  const fqdns = { 'data/indexer-1': 'idx-a.corp.example' }; // module override for one node
  const m = buildInventoryModel(distributedPlan(), tofu(distributedIps(), fqdns), {
    dnsDomain: 'ex.internal',
  });
  const idx1 = m.hosts.find((h) => h.alias === 'idx1')!;
  const idx2 = m.hosts.find((h) => h.alias === 'idx2')!;
  const mgmt = m.hosts.find((h) => h.alias === 'mgmt1')!;
  assert.equal(idx1.fqdn, 'idx-a.corp.example'); // node_fqdns authoritative
  assert.equal(idx2.fqdn, 'idx2.ex.internal'); // derived fallback
  assert.equal(mgmt.fqdn, 'mgmt1.ex.internal'); // cluster-manager => mgmt prefix
});

test('single captain: exactly one SHC member (lowest ordinal) is the bootstrap captain', () => {
  const m = buildInventoryModel(distributedPlan(), tofu(distributedIps()), { dnsDomain: 'ex.internal' });
  const captains = m.hosts.filter((h) => h.bootstrapCaptain);
  assert.equal(captains.length, 1);
  assert.equal(captains[0].alias, 'sh1');
  assert.equal(m.vars.shcEnabled, true);
  assert.equal(m.health.expectedShcMemberCount, 3);
  assert.equal(m.health.shcCaptainCandidates[0], captains[0].fqdn);
});

test('<3 SHC members => standalone SH not SHC: no captain, shcEnabled=false, warns', () => {
  const plan: RawPlanItem[] = [
    { planKey: 'control-plane/cluster-manager-1', kind: 'cluster-manager' },
    { planKey: 'data/indexer-1', kind: 'indexer' },
    { planKey: 'data/indexer-2', kind: 'indexer' },
    { planKey: 'data/indexer-3', kind: 'indexer' },
    { planKey: 'search/search-head-1', kind: 'search-head' },
    { planKey: 'search/search-head-2', kind: 'search-head' }, // only 2 SHs
  ];
  const ips = {
    'control-plane/cluster-manager-1': '10.0.0.10',
    'data/indexer-1': '10.0.0.21',
    'data/indexer-2': '10.0.0.22',
    'data/indexer-3': '10.0.0.23',
    'search/search-head-1': '10.0.0.31',
    'search/search-head-2': '10.0.0.32',
  };
  const m = buildInventoryModel(plan, tofu(ips), { dnsDomain: 'ex.internal' });
  assert.equal(m.vars.shcEnabled, false);
  assert.equal(m.hosts.filter((h) => h.bootstrapCaptain).length, 0);
  assert.equal(m.health.expectedShcMemberCount, 0);
  assert.ok(m.warnings.some((w) => /NOT forming a search-head cluster/.test(w)));
});

test('<3 indexers still clusters but warns about unmet RF/SF', () => {
  const plan: RawPlanItem[] = [
    { planKey: 'control-plane/cluster-manager-1', kind: 'cluster-manager' },
    { planKey: 'data/indexer-1', kind: 'indexer' },
    { planKey: 'data/indexer-2', kind: 'indexer' },
  ];
  const ips = {
    'control-plane/cluster-manager-1': '10.0.0.10',
    'data/indexer-1': '10.0.0.21',
    'data/indexer-2': '10.0.0.22',
  };
  const m = buildInventoryModel(plan, tofu(ips), { dnsDomain: 'ex.internal' });
  assert.equal(m.vars.indexerClusterEnabled, true);
  assert.equal(m.vars.replicationFactor, 3);
  assert.ok(m.warnings.some((w) => /CANNOT be met until >= 3 peers/.test(w)));
});

test('colocation: CM absorbs license/deployment/monitoring when no dedicated kinds', () => {
  const m = buildInventoryModel(distributedPlan(), tofu(distributedIps()), { dnsDomain: 'ex.internal' });
  assert.deepEqual(m.groups.license_master, ['mgmt1']);
  assert.deepEqual(m.groups.deployment_server, ['mgmt1']);
  assert.deepEqual(m.groups.monitoring_console, ['mgmt1']);
  const mgmt = m.hosts.find((h) => h.alias === 'mgmt1')!;
  assert.ok(mgmt.groups.includes('license_master'));
  assert.ok(mgmt.groups.includes('deployment_server'));
  assert.ok(mgmt.groups.includes('monitoring_console'));
});

test('colocation: dedicated deployment-server / license-manager kinds are honored separately', () => {
  const plan: RawPlanItem[] = [
    { planKey: 'control-plane/cluster-manager-1', kind: 'cluster-manager' },
    { planKey: 'control-plane/deployment-server-1', kind: 'deployment-server' },
    { planKey: 'control-plane/license-manager-1', kind: 'license-manager' },
    { planKey: 'data/indexer-1', kind: 'indexer' },
  ];
  const ips = {
    'control-plane/cluster-manager-1': '10.0.0.10',
    'control-plane/deployment-server-1': '10.0.0.12',
    'control-plane/license-manager-1': '10.0.0.13',
    'data/indexer-1': '10.0.0.21',
  };
  const m = buildInventoryModel(plan, tofu(ips), { dnsDomain: 'ex.internal' });
  // Dedicated nodes get their own group members; CM is NOT folded in.
  assert.deepEqual(m.groups.deployment_server, ['ds1']);
  assert.deepEqual(m.groups.license_master, ['lm1']);
  // CM still absorbs monitoring-console (no dedicated kind for it).
  assert.deepEqual(m.groups.monitoring_console, ['mgmt1']);
  const cm = m.hosts.find((h) => h.alias === 'mgmt1')!;
  assert.ok(!cm.groups.includes('deployment_server'));
  assert.ok(!cm.groups.includes('license_master'));
});

test('standalone-only plan: single all-in-one node, no clusters', () => {
  const plan: RawPlanItem[] = [{ planKey: 'data/standalone-1', kind: 'standalone' }];
  const m = buildInventoryModel(plan, tofu({ 'data/standalone-1': '10.0.0.5' }), { dnsDomain: 'ex.internal' });
  assert.deepEqual(m.groups.standalone, ['so1']);
  assert.equal(m.vars.indexerClusterEnabled, false);
  assert.equal(m.vars.shcEnabled, false);
  assert.equal(m.health.standaloneFqdn, 'so1.ex.internal');
});

test('throws when a compute node has no private IP (hard provisioning error)', () => {
  const plan: RawPlanItem[] = [{ planKey: 'data/indexer-1', kind: 'indexer' }];
  assert.throws(() => deriveInventory({ plan: normalizePlan(plan), tofu: tofu({}) }), /No private IP/);
});

test('toInventoryYaml emits all: children groups and per-host vars', () => {
  const m = buildInventoryModel(distributedPlan(), tofu(distributedIps()), {
    dnsDomain: 'ex.internal',
    secretsArn: 'arn:aws:secretsmanager:us-east-1:1:secret:x',
    region: 'us-east-1',
  });
  const yaml = toInventoryYaml(m);
  assert.match(yaml, /^all:/m);
  assert.match(yaml, /children:/);
  assert.match(yaml, /cluster_indexer:/);
  assert.match(yaml, /ansible_host: 10\.0\.0\.21/);
  assert.match(yaml, /bootstrap_captain: true/);
  assert.match(yaml, /splunk_secrets_arn: "arn:aws:secretsmanager:us-east-1:1:secret:x"/);
  assert.match(yaml, /splunk_cluster_manager_fqdn: mgmt1\.ex\.internal/);
});

// --- Control-plane consolidation (management-node) -------------------------

function distributedCoreIps(): Record<string, string> {
  return {
    'data/indexer-1': '10.0.0.21',
    'data/indexer-2': '10.0.0.22',
    'data/indexer-3': '10.0.0.23',
    'search/search-head-1': '10.0.0.31',
    'search/search-head-2': '10.0.0.32',
    'search/search-head-3': '10.0.0.33',
  };
}

const distributedCore: RawPlanItem[] = [
  { planKey: 'data/indexer-1', tier: 'data', kind: 'indexer' },
  { planKey: 'data/indexer-2', tier: 'data', kind: 'indexer' },
  { planKey: 'data/indexer-3', tier: 'data', kind: 'indexer' },
  { planKey: 'search/search-head-1', tier: 'search', kind: 'search-head' },
  { planKey: 'search/search-head-2', tier: 'search', kind: 'search-head' },
  { planKey: 'search/search-head-3', tier: 'search', kind: 'search-head' },
];

test('consolidated: a management-node joins each of its role groups and is NOT skipped', () => {
  const plan: RawPlanItem[] = [
    { planKey: 'control-plane/cluster-manager', tier: 'control-plane', kind: 'cluster-manager' },
    { planKey: 'control-plane/sh-deployer', tier: 'control-plane', kind: 'sh-deployer' },
    {
      planKey: 'control-plane/management',
      tier: 'control-plane',
      kind: 'management-node',
      roles: ['license-manager', 'deployment-server', 'monitoring-console'],
    },
    ...distributedCore,
  ];
  const ips = {
    'control-plane/cluster-manager': '10.0.0.10',
    'control-plane/sh-deployer': '10.0.0.11',
    'control-plane/management': '10.0.0.12',
    ...distributedCoreIps(),
  };
  const model = deriveInventory({ plan: normalizePlan(plan), tofu: tofu(ips) });

  // Never silently skipped as "not a Splunk compute kind".
  assert.ok(!model.warnings.some((w) => w.includes('control-plane/management') && w.includes('not a Splunk')));

  const mgmt = model.hosts.find((h) => h.planKey === 'control-plane/management');
  assert.ok(mgmt, 'management-node host exists');
  assert.equal(mgmt.ansibleHost, '10.0.0.12');
  assert.deepEqual([...mgmt.groups].sort(), ['deployment_server', 'license_master', 'monitoring_console']);
  // The dedicated cluster-manager keeps ONLY cluster_manager (LM/DS/MC live on the mgmt node).
  const cm = model.hosts.find((h) => h.planKey === 'control-plane/cluster-manager');
  assert.deepEqual(cm.groups, ['cluster_manager']);
});

test('single-node: one management-node carries every management role and forms the cluster', () => {
  const plan: RawPlanItem[] = [
    {
      planKey: 'control-plane/management',
      tier: 'control-plane',
      kind: 'management-node',
      roles: ['license-manager', 'cluster-manager', 'sh-deployer', 'deployment-server', 'monitoring-console'],
    },
    ...distributedCore,
  ];
  const ips = { 'control-plane/management': '10.0.0.12', ...distributedCoreIps() };
  const model = deriveInventory({ plan: normalizePlan(plan), tofu: tofu(ips) });

  const mgmt = model.hosts.find((h) => h.planKey === 'control-plane/management');
  assert.ok(mgmt, 'management-node host exists');
  // Primary SPLUNK_ROLE is the highest-precedence role it carries (cluster-manager).
  assert.equal(mgmt.splunkRole, 'splunk_cluster_manager');
  assert.deepEqual(
    [...mgmt.groups].sort(),
    ['cluster_manager', 'deployment_server', 'license_master', 'monitoring_console', 'search_head_deployer'],
  );
  // The indexer cluster forms because the management-node supplies the cluster-manager role.
  assert.equal(model.vars.indexerClusterEnabled, true);
});
