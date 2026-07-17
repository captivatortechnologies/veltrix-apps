// =============================================================================
// Splunk bring-up layer — shared types.
//
// This layer takes freshly-provisioned cloud VMs (from the opentofu worker) and
// turns them into a healthy, clustered Splunk Enterprise deployment via
// splunk-ansible, then gates "ready" on Splunk's own health REST endpoints.
//
// The types here are deliberately decoupled from the opentofu service: the
// inventory derivation (inventory.ts) is a PURE module with no runtime imports
// so the same compiled logic can be re-used by the build-inventory.mjs CLI in
// CI without pulling the logger / dotenv / broker dependency graph.
// =============================================================================

/** Compute kinds that become a Splunk node (mirrors modules/aws compute_kinds). */
export type SplunkKind =
  | 'license-manager'
  | 'cluster-manager'
  | 'sh-deployer'
  | 'deployment-server'
  | 'monitoring-console'
  | 'indexer'
  | 'search-head'
  | 'heavy-forwarder'
  | 'standalone';

/**
 * A plan item as it may arrive on disk. The plan is emitted camelCase by the
 * app server (PlanItem: planKey/tier/kind) but rendered snake_case into
 * terraform.tfvars.json (plan_key). build-inventory.mjs may be pointed at
 * either source, so we accept both spellings and normalize.
 */
export interface RawPlanItem {
  planKey?: string;
  plan_key?: string;
  tier?: string;
  kind: string;
  name?: string;
  role?: string;
  region?: string | null;
  zone?: string | null;
  roles?: string[] | null;
}

/** A plan item after normalization — the shape the pure logic operates on. */
export interface NormalizedPlanItem {
  planKey: string;
  tier: string;
  kind: string;
  name: string;
  role: string;
  /** Management roles a consolidated `management-node` runs; empty otherwise. */
  roles: string[];
}

/** The tofu-output JSON, as produced by `tofu output -json` (root outputs). */
export interface TofuOutputs {
  /** plan_key -> private IP. Root MUST re-export module.instance_private_ips. */
  instance_private_ips?: TofuOutputValue<Record<string, string>>;
  /** plan_key -> function FQDN (idx1.<domain> ...). Added by the AWS module. */
  node_fqdns?: TofuOutputValue<Record<string, string>>;
  /** plan_key -> external ref / arn (foundation/secrets -> secret ARN). */
  resource_refs?: TofuOutputValue<Record<string, string>>;
  [k: string]: TofuOutputValue<unknown> | undefined;
}

/** `tofu output -json` wraps every output as { sensitive, type, value }. */
export interface TofuOutputValue<T> {
  sensitive?: boolean;
  type?: unknown;
  value: T;
}

/** Ansible-inventory group names this layer emits (per the platform contract). */
export type SplunkGroup =
  | 'cluster_manager'
  | 'cluster_indexer'
  | 'cluster_search_head'
  | 'search_head_deployer'
  | 'deployment_server'
  | 'license_master'
  | 'monitoring_console'
  | 'heavy_forwarder'
  | 'standalone';

/** One resolved host in the derived inventory. */
export interface InventoryHost {
  /** Short, deterministic inventory alias (idx1, sh2, mgmt1 ...). */
  alias: string;
  /** The plan_key this host was derived from (1:1 with a tofu instance). */
  planKey: string;
  kind: string;
  /** Private IP (ansible_host). */
  ansibleHost: string;
  /** Function FQDN — used for splunk_hostname / serverName (host rename). */
  fqdn: string;
  /** splunk-ansible SPLUNK_ROLE for this host's primary function. */
  splunkRole: string;
  /** Every inventory group this host belongs to (primary + colocated). */
  groups: SplunkGroup[];
  /** True on exactly one SHC member (lowest ordinal) when an SHC is formed. */
  bootstrapCaptain: boolean;
}

/** Topology-level variables the group_vars/site.yml consume. */
export interface InventoryVars {
  /** Whether a real search-head cluster is formed (>= 3 members). */
  shcEnabled: boolean;
  /** Whether an indexer cluster is formed (>= 1 indexer + a cluster-manager). */
  indexerClusterEnabled: boolean;
  replicationFactor: number;
  searchFactor: number;
  shcReplicationFactor: number;
  indexerClusterLabel: string;
  shClusterLabel: string;
  /** AWS Secrets Manager ARN (foundation/secrets) for the pass4SymmKey lookups. */
  secretsArn: string | null;
  region: string | null;
  dnsDomain: string | null;
}

/** The health-gate targets extracted from the derived inventory. */
export interface HealthTargets {
  /** Cluster-manager FQDN the CM health endpoints are polled on (8089). */
  clusterManagerFqdn: string | null;
  /** Expected indexer peer count (all must be Up). */
  expectedIndexerCount: number;
  /** SHC captain-candidate FQDNs (the bootstrap member first). */
  shcCaptainCandidates: string[];
  /** Expected SHC member count. */
  expectedShcMemberCount: number;
  /** A search-head FQDN to poll distributed search peers on (8089). */
  searchHeadFqdn: string | null;
  /** Standalone node FQDN when the deployment is a single all-in-one instance. */
  standaloneFqdn: string | null;
  shcEnabled: boolean;
  indexerClusterEnabled: boolean;
}

/** The full derived inventory model (pure output of deriveInventory). */
export interface InventoryModel {
  hosts: InventoryHost[];
  /** group name -> host aliases. */
  groups: Record<SplunkGroup, string[]>;
  vars: InventoryVars;
  health: HealthTargets;
  /** Non-fatal advisories (small clusters, missing deployer, ...). */
  warnings: string[];
}

// --- Orchestrator (bringUp.ts) -------------------------------------------

export interface BringUpInput {
  /** Path to the plan JSON (array of plan items, or a tfvars object with .plan). */
  planPath: string;
  /** Path to the `tofu output -json` result. */
  tofuOutputPath: string;
  /** Where to write the rendered Ansible inventory (YAML). */
  inventoryOutPath: string;
  /** Secrets Manager ARN for pass4SymmKey/splunk.secret/admin-hash lookups. */
  secretsArn?: string | null;
  region?: string | null;
  dnsDomain?: string | null;
  /** Overrides for the driver scripts / dirs (defaults resolve to the repo). */
  buildInventoryScript?: string;
  ansibleDir?: string;
  healthGateScript?: string;
  /** Hard timeout for the health gate (ms). */
  healthTimeoutMs?: number;
  /** Skip the ansible play (inventory + health only) — for dry runs / tests. */
  skipAnsible?: boolean;
}

export type BringUpPhase = 'inventory' | 'ansible' | 'health' | 'done';

export interface BringUpResult {
  ready: boolean;
  phase: BringUpPhase;
  /** Set when the health gate timed out — the precise gate that failed. */
  failedGate?: string;
  /** Admin is seeded with force-change-pass=true; first login must rotate it. */
  adminActivationRequired: true;
  inventoryPath: string;
  warnings: string[];
}
