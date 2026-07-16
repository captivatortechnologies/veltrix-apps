// =============================================================================
// Splunk inventory derivation — PURE logic (single source of truth).
//
// Given a normalized topology plan + the tofu outputs (private IPs, optional
// node_fqdns), derive an Ansible inventory grouping hosts into splunk-ansible
// groups, with deterministic ordinals/FQDNs and a single SHC captain.
//
// This module has NO runtime imports beyond ./types so the compiled JS can be
// imported by build-inventory.mjs in CI without dragging in the logger / broker.
// Everything is a pure function: no Date.now(), no Math.random(), no I/O.
// build-inventory.mjs is a thin CLI over deriveInventory() + toInventoryYaml().
// =============================================================================

import {
  HealthTargets,
  InventoryHost,
  InventoryModel,
  InventoryVars,
  NormalizedPlanItem,
  RawPlanItem,
  SplunkGroup,
  SplunkKind,
  TofuOutputs,
} from './types.js';

/** Standard Splunk indexer-cluster durability targets (RF=3 / SF=2). */
export const DEFAULT_REPLICATION_FACTOR = 3;
export const DEFAULT_SEARCH_FACTOR = 2;
/** SHC replication factor (search artifact replication) — 3 by convention. */
export const DEFAULT_SHC_REPLICATION_FACTOR = 3;
/** Minimum members required to form a real cluster (idx cluster / SHC). */
export const MIN_CLUSTER_SIZE = 3;

/** Per-kind derivation metadata: FQDN prefix, primary group, SPLUNK_ROLE. */
interface KindMeta {
  /** FQDN/host-alias prefix (function name). */
  prefix: string;
  group: SplunkGroup;
  /** splunk-ansible SPLUNK_ROLE value. */
  role: string;
}

const KIND_META: Record<SplunkKind, KindMeta> = {
  // The cluster-manager is THE management node in the reference topology; the
  // AWS module names it `mgmt` (idx1/sh1/mgmt/hf1). When node_fqdns is present
  // it wins; the prefix here only drives the fallback + host alias.
  'cluster-manager': { prefix: 'mgmt', group: 'cluster_manager', role: 'splunk_cluster_manager' },
  'license-manager': { prefix: 'lm', group: 'license_master', role: 'splunk_license_master' },
  'deployment-server': { prefix: 'ds', group: 'deployment_server', role: 'splunk_deployment_server' },
  'sh-deployer': { prefix: 'depl', group: 'search_head_deployer', role: 'splunk_deployer' },
  'monitoring-console': { prefix: 'mc', group: 'monitoring_console', role: 'splunk_monitor' },
  indexer: { prefix: 'idx', group: 'cluster_indexer', role: 'splunk_indexer' },
  'search-head': { prefix: 'sh', group: 'cluster_search_head', role: 'splunk_search_head' },
  'heavy-forwarder': { prefix: 'hf', group: 'heavy_forwarder', role: 'splunk_heavy_forwarder' },
  standalone: { prefix: 'so', group: 'standalone', role: 'splunk_standalone' },
};

const ALL_GROUPS: SplunkGroup[] = [
  'cluster_manager',
  'cluster_indexer',
  'cluster_search_head',
  'search_head_deployer',
  'deployment_server',
  'license_master',
  'monitoring_console',
  'heavy_forwarder',
  'standalone',
];

export function isSplunkKind(kind: string): kind is SplunkKind {
  return Object.prototype.hasOwnProperty.call(KIND_META, kind);
}

/** Read the plan_key off a raw item regardless of camel/snake spelling. */
function rawPlanKey(item: RawPlanItem): string {
  const key = item.planKey ?? item.plan_key;
  if (!key) throw new Error(`Plan item is missing planKey/plan_key: ${JSON.stringify(item)}`);
  return key;
}

/**
 * Normalize a raw plan (camelCase or snake_case, array or {plan:[...]}) into the
 * canonical NormalizedPlanItem shape. Pure.
 */
export function normalizePlan(raw: RawPlanItem[] | { plan?: RawPlanItem[] }): NormalizedPlanItem[] {
  const items = Array.isArray(raw) ? raw : raw.plan ?? [];
  return items.map((item) => ({
    planKey: rawPlanKey(item),
    tier: item.tier ?? '',
    kind: item.kind,
    name: item.name ?? '',
    role: item.role ?? '',
  }));
}

/**
 * Natural (numeric-aware) comparator so `indexer-2` sorts before `indexer-10`.
 * Pure and total, giving deterministic ordinals from a plan_key list.
 */
export function naturalCompare(a: string, b: string): number {
  const ax = a.match(/(\d+|\D+)/g) ?? [];
  const bx = b.match(/(\d+|\D+)/g) ?? [];
  const n = Math.min(ax.length, bx.length);
  for (let i = 0; i < n; i++) {
    const as = ax[i];
    const bs = bx[i];
    const an = Number(as);
    const bn = Number(bs);
    const bothNum = !Number.isNaN(an) && !Number.isNaN(bn) && /^\d+$/.test(as) && /^\d+$/.test(bs);
    if (bothNum) {
      if (an !== bn) return an - bn;
    } else if (as !== bs) {
      return as < bs ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

/** Read the { value } payload off a tofu output, tolerating a bare map. */
function tofuValue(out: TofuOutputs, key: string): Record<string, string> {
  const entry = out[key];
  if (!entry) return {};
  const v = (entry as { value?: unknown }).value ?? entry;
  return (v && typeof v === 'object' ? (v as Record<string, string>) : {}) ?? {};
}

export interface DeriveInput {
  plan: NormalizedPlanItem[];
  tofu: TofuOutputs;
  secretsArn?: string | null;
  region?: string | null;
  dnsDomain?: string | null;
}

/**
 * Derive the full inventory model. Pure: same inputs -> same output, no clock,
 * no randomness. Throws only on a structural impossibility (a compute node with
 * no private IP), which is a hard provisioning error, not an advisory.
 */
export function deriveInventory(input: DeriveInput): InventoryModel {
  const { plan } = input;
  const privateIps = tofuValue(input.tofu, 'instance_private_ips');
  const nodeFqdns = tofuValue(input.tofu, 'node_fqdns');
  const dnsDomain = input.dnsDomain ?? null;
  const warnings: string[] = [];

  // Keep only real compute kinds; warn (not throw) on anything unexpected so an
  // evolving topology never hard-fails the whole bring-up.
  const computePlan = plan.filter((p) => {
    if (isSplunkKind(p.kind)) return true;
    warnings.push(`Skipping plan item ${p.planKey}: kind "${p.kind}" is not a Splunk compute kind`);
    return false;
  });

  // Group plan items by kind, each sorted by natural plan_key order → ordinals.
  const byKind = new Map<SplunkKind, NormalizedPlanItem[]>();
  for (const item of computePlan) {
    const kind = item.kind as SplunkKind;
    const list = byKind.get(kind) ?? [];
    list.push(item);
    byKind.set(kind, list);
  }
  for (const list of byKind.values()) list.sort((a, b) => naturalCompare(a.planKey, b.planKey));

  const counts = {
    indexer: byKind.get('indexer')?.length ?? 0,
    searchHead: byKind.get('search-head')?.length ?? 0,
    clusterManager: byKind.get('cluster-manager')?.length ?? 0,
    deployer: byKind.get('sh-deployer')?.length ?? 0,
    licenseManager: byKind.get('license-manager')?.length ?? 0,
    deploymentServer: byKind.get('deployment-server')?.length ?? 0,
    monitoringConsole: byKind.get('monitoring-console')?.length ?? 0,
    heavyForwarder: byKind.get('heavy-forwarder')?.length ?? 0,
    standalone: byKind.get('standalone')?.length ?? 0,
  };

  const indexerClusterEnabled = counts.indexer > 0 && counts.clusterManager > 0;
  const shcEnabled = counts.searchHead >= MIN_CLUSTER_SIZE;

  // --- Advisories -------------------------------------------------------
  if (counts.indexer > 0 && counts.clusterManager === 0) {
    warnings.push(
      `Plan has ${counts.indexer} indexer(s) but no cluster-manager: an indexer cluster cannot form. ` +
        `Add a cluster-manager kind.`,
    );
  }
  if (indexerClusterEnabled && counts.indexer < MIN_CLUSTER_SIZE) {
    warnings.push(
      `Only ${counts.indexer} indexer(s): a cluster is still formed but replication_factor=` +
        `${DEFAULT_REPLICATION_FACTOR}/search_factor=${DEFAULT_SEARCH_FACTOR} CANNOT be met until >= ` +
        `${MIN_CLUSTER_SIZE} peers exist. The health gate will report replication_factor_met=0 until scaled.`,
    );
  }
  if (counts.searchHead > 0 && !shcEnabled) {
    warnings.push(
      `Only ${counts.searchHead} search-head(s) (< ${MIN_CLUSTER_SIZE}): NOT forming a search-head cluster. ` +
        `Configuring as standalone (independent) search head(s) against the indexer cluster; no captain, ` +
        `deployer bundle push is skipped.`,
    );
  }
  if (shcEnabled && counts.deployer === 0) {
    warnings.push(
      `Search-head cluster of ${counts.searchHead} members has no sh-deployer: SHC app-bundle pushes ` +
        `will be unavailable. Add a sh-deployer kind.`,
    );
  }

  // --- Build hosts ------------------------------------------------------
  const hosts: InventoryHost[] = [];
  const groups: Record<SplunkGroup, string[]> = ALL_GROUPS.reduce(
    (acc, g) => ((acc[g] = []), acc),
    {} as Record<SplunkGroup, string[]>,
  );

  const addToGroup = (group: SplunkGroup, alias: string) => {
    if (!groups[group].includes(alias)) groups[group].push(alias);
  };

  for (const kind of byKind.keys()) {
    const list = byKind.get(kind)!;
    const meta = KIND_META[kind];
    list.forEach((item, idx) => {
      const ordinal = idx + 1;
      const alias = `${meta.prefix}${ordinal}`;
      const ansibleHost = privateIps[item.planKey];
      if (!ansibleHost) {
        throw new Error(
          `No private IP for plan_key "${item.planKey}" in tofu output instance_private_ips. ` +
            `The root stack must re-export module.instance_private_ips.`,
        );
      }
      const fqdn = resolveFqdn(item.planKey, meta.prefix, ordinal, nodeFqdns, dnsDomain, warnings);
      const host: InventoryHost = {
        alias,
        planKey: item.planKey,
        kind,
        ansibleHost,
        fqdn,
        splunkRole: meta.role,
        groups: [meta.group],
        bootstrapCaptain: false,
      };
      hosts.push(host);
      addToGroup(meta.group, alias);
    });
  }

  // --- Colocation: fold management roles onto the cluster-manager -------
  // The reference topology runs License Manager / Deployment Server / Monitoring
  // Console on the cluster-manager node UNLESS the plan carries a dedicated kind.
  const cmHost = hosts.find((h) => h.kind === 'cluster-manager');
  if (cmHost) {
    if (counts.licenseManager === 0) colocate(cmHost, 'license_master', groups);
    if (counts.deploymentServer === 0) colocate(cmHost, 'deployment_server', groups);
    if (counts.monitoringConsole === 0) colocate(cmHost, 'monitoring_console', groups);
  } else if (counts.standalone === 0 && counts.licenseManager === 0 && (counts.indexer > 0 || counts.searchHead > 0)) {
    warnings.push('No cluster-manager and no license-manager: license-master role is unassigned.');
  }

  // --- SHC captain selection (exactly one, lowest ordinal) --------------
  const shMembers = hosts.filter((h) => h.kind === 'search-head');
  if (shcEnabled && shMembers.length > 0) {
    // shMembers already in ordinal order (byKind sorted); lowest ordinal = [0].
    shMembers[0].bootstrapCaptain = true;
  }

  const vars: InventoryVars = {
    shcEnabled,
    indexerClusterEnabled,
    replicationFactor: DEFAULT_REPLICATION_FACTOR,
    searchFactor: DEFAULT_SEARCH_FACTOR,
    shcReplicationFactor: DEFAULT_SHC_REPLICATION_FACTOR,
    indexerClusterLabel: 'idxc',
    shClusterLabel: 'shc',
    secretsArn: input.secretsArn ?? null,
    region: input.region ?? null,
    dnsDomain,
  };

  const health = deriveHealthTargets(hosts, counts, shcEnabled, indexerClusterEnabled);

  return { hosts, groups, vars, health, warnings };
}

function colocate(host: InventoryHost, group: SplunkGroup, groups: Record<SplunkGroup, string[]>): void {
  if (!host.groups.includes(group)) host.groups.push(group);
  if (!groups[group].includes(host.alias)) groups[group].push(host.alias);
}

/**
 * Resolve a host FQDN: node_fqdns (module, authoritative) wins; otherwise derive
 * `<prefix><ordinal>.<dnsDomain>` (bare `<prefix><ordinal>` when no domain).
 */
function resolveFqdn(
  planKey: string,
  prefix: string,
  ordinal: number,
  nodeFqdns: Record<string, string>,
  dnsDomain: string | null,
  warnings: string[],
): string {
  const fromModule = nodeFqdns[planKey];
  if (fromModule) return fromModule;
  if (dnsDomain) return `${prefix}${ordinal}.${dnsDomain}`;
  warnings.push(
    `No node_fqdns entry for ${planKey} and no dnsDomain: falling back to bare hostname ` +
      `"${prefix}${ordinal}" (not DNS-resolvable). Confirm the module emits node_fqdns.`,
  );
  return `${prefix}${ordinal}`;
}

function deriveHealthTargets(
  hosts: InventoryHost[],
  counts: { indexer: number; searchHead: number },
  shcEnabled: boolean,
  indexerClusterEnabled: boolean,
): HealthTargets {
  const cm = hosts.find((h) => h.kind === 'cluster-manager') ?? null;
  const standalone = hosts.find((h) => h.kind === 'standalone') ?? null;
  const shMembers = hosts.filter((h) => h.kind === 'search-head');
  const captain = shMembers.find((h) => h.bootstrapCaptain) ?? shMembers[0] ?? null;
  // Captain candidates: bootstrap member first, then the rest (fallback probing).
  const candidates = captain
    ? [captain.fqdn, ...shMembers.filter((h) => h !== captain).map((h) => h.fqdn)]
    : [];
  return {
    clusterManagerFqdn: cm?.fqdn ?? null,
    expectedIndexerCount: counts.indexer,
    shcCaptainCandidates: candidates,
    expectedShcMemberCount: shcEnabled ? shMembers.length : 0,
    searchHeadFqdn: shMembers[0]?.fqdn ?? standalone?.fqdn ?? null,
    standaloneFqdn: standalone?.fqdn ?? null,
    shcEnabled,
    indexerClusterEnabled,
  };
}

// =============================================================================
// YAML emission — minimal, purpose-built for this constrained inventory shape.
// (No yaml dependency in the repo; all values here are simple scalars.)
// =============================================================================

/** Quote a scalar only when YAML would otherwise misparse it. Pure. */
function yamlScalar(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const s = String(value);
  // Safe bareword: letters/digits/dot/dash/underscore, not a YAML-ambiguous token.
  const safe = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s);
  if (safe && !/^\d+$/.test(s)) return s; // keep numeric-looking strings quoted
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render the derived inventory model as a splunk-ansible YAML inventory. Pure.
 * Structure: all -> vars + children groups -> hosts -> per-host vars.
 */
export function toInventoryYaml(model: InventoryModel): string {
  const L: string[] = [];
  L.push('# =============================================================================');
  L.push('# GENERATED Splunk bring-up inventory — do not edit by hand.');
  L.push('# Produced by rabbitmq/splunk/inventory/build-inventory.mjs (deriveInventory).');
  L.push('# =============================================================================');
  L.push('all:');
  L.push('  vars:');
  L.push(`    splunk_shc_enabled: ${yamlScalar(model.vars.shcEnabled)}`);
  L.push(`    splunk_indexer_cluster_enabled: ${yamlScalar(model.vars.indexerClusterEnabled)}`);
  L.push(`    splunk_replication_factor: ${yamlScalar(model.vars.replicationFactor)}`);
  L.push(`    splunk_search_factor: ${yamlScalar(model.vars.searchFactor)}`);
  L.push(`    splunk_shc_replication_factor: ${yamlScalar(model.vars.shcReplicationFactor)}`);
  L.push(`    splunk_idxc_label: ${yamlScalar(model.vars.indexerClusterLabel)}`);
  L.push(`    splunk_shc_label: ${yamlScalar(model.vars.shClusterLabel)}`);
  if (model.vars.secretsArn) L.push(`    splunk_secrets_arn: ${yamlScalar(model.vars.secretsArn)}`);
  if (model.vars.region) L.push(`    splunk_secrets_region: ${yamlScalar(model.vars.region)}`);
  if (model.vars.dnsDomain) L.push(`    splunk_dns_domain: ${yamlScalar(model.vars.dnsDomain)}`);
  // Cross-group coordinates the group_vars/site.yml need (manager/deployer/captain).
  if (model.health.clusterManagerFqdn)
    L.push(`    splunk_cluster_manager_fqdn: ${yamlScalar(model.health.clusterManagerFqdn)}`);
  const deployer = model.hosts.find((h) => h.kind === 'sh-deployer');
  if (deployer) L.push(`    splunk_deployer_fqdn: ${yamlScalar(deployer.fqdn)}`);
  const captain = model.hosts.find((h) => h.bootstrapCaptain);
  if (captain) L.push(`    splunk_shc_captain_fqdn: ${yamlScalar(captain.fqdn)}`);

  L.push('  children:');
  const hostByAlias = new Map(model.hosts.map((h) => [h.alias, h]));
  for (const group of ALL_GROUPS) {
    const aliases = model.groups[group];
    if (!aliases || aliases.length === 0) continue;
    L.push(`    ${group}:`);
    L.push('      hosts:');
    for (const alias of aliases) {
      const host = hostByAlias.get(alias)!;
      // Emit full host vars under the host's PRIMARY group; a bare reference
      // under any colocated group (Ansible merges membership across groups).
      const isPrimary = host.groups[0] === group;
      if (!isPrimary) {
        L.push(`        ${alias}: {}`);
        continue;
      }
      L.push(`        ${alias}:`);
      L.push(`          ansible_host: ${yamlScalar(host.ansibleHost)}`);
      L.push(`          splunk_hostname: ${yamlScalar(host.fqdn)}`);
      L.push(`          splunk_server_name: ${yamlScalar(host.fqdn)}`);
      L.push(`          splunk_role: ${yamlScalar(host.splunkRole)}`);
      L.push(`          splunk_plan_key: ${yamlScalar(host.planKey)}`);
      if (host.bootstrapCaptain) L.push('          bootstrap_captain: true');
    }
  }
  return L.join('\n') + '\n';
}

/** End-to-end: normalize raw plan + tofu output -> derived model. Pure. */
export function buildInventoryModel(
  rawPlan: RawPlanItem[] | { plan?: RawPlanItem[] },
  tofu: TofuOutputs,
  opts: { secretsArn?: string | null; region?: string | null; dnsDomain?: string | null } = {},
): InventoryModel {
  const plan = normalizePlan(rawPlan);
  return deriveInventory({ plan, tofu, ...opts });
}
