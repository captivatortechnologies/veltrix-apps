# =============================================================================
# Hetzner Cloud environment module — generic, tool-agnostic. A faithful
# translation of the AWS reference module (sdk/opentofu/modules/aws), honoring
# the SAME variable + output contract. Driven by an app's rendered InfraSpec;
# NOTHING here is tool-specific.
#
# Network mode (worker-set deployment var, NOT app InfraSpec):
#   shared    — Veltrix-hosted: data-source the shared hcloud_network + create
#               the per-stack cloud subnet.
#   dedicated — BYOC: CREATE a fresh hcloud_network + one cloud subnet.
#   existing  — BYOC: data-source a customer network + create a subnet in it.
#
# Servers attach to the private network (hcloud_server_network) for private IPs;
# they keep their default PUBLIC interface for egress (Hetzner private networks
# have no built-in NAT — a NAT gateway server would be a separate, out-of-band
# resource). The firewall (hcloud_firewall) is the SG analog and attaches to
# this stack's servers via a `veltrix-stack` label selector.
#
# =============================================================================
# DOCUMENTED GAPS — Hetzner is the simplest cloud and lacks several primitives
# the AWS module uses. These are handled HONESTLY (no-op + comment), never faked:
#
#   * WAF        — Hetzner has no WAF. `waf_enabled` is accepted for contract
#                  parity but is a NO-OP; a real WAF would require an external
#                  reverse-proxy/CDN in front of the LB. See the LB section.
#   * DNS records— The hcloud provider has NO managed-DNS resource (Hetzner DNS
#                  is the separate `timohirt/hetznerdns` provider). This module
#                  creates NO public or private DNS records in ANY dns_mode. It
#                  computes per-node FQDNs and EMITS them (output node_fqdns) so
#                  the bring-up layer can populate /etc/hosts or a hetznerdns
#                  stack out-of-band. dns_mode / create_private_zone /
#                  private_zone_id are kept for contract uniformity (no-ops).
#   * Object store— Hetzner Object Storage is S3-compatible but NOT in the hcloud
#                  provider. `storage` plan items create a block volume
#                  (hcloud_volume) instead; true object storage is external.
#   * Secrets    — Hetzner has no Secrets Manager / Key Vault. `secrets` and
#                  `license-file` plan items create NO resource here; those
#                  values live in the platform vault (injected out-of-band).
#   * MFA (alb_auth)— Hetzner LBs have no OIDC/Cognito equivalent. `alb_auth` is
#                  accepted for contract parity but is a NO-OP.
# =============================================================================

locals {
  # Short, DNS/label-safe prefix. infrastructure_id is a UUID; 8 chars is enough
  # to disambiguate within a customer while staying under name limits.
  name_prefix = "${var.app_id}-${substr(var.infrastructure_id, 0, 8)}"

  # Hostname-safe form of name_prefix (lowercase, [a-z0-9-]) for server names.
  host_prefix = replace(lower(local.name_prefix), "/[^a-z0-9-]/", "-")

  # Label-value-safe form of name_prefix, used as the per-stack selector value.
  stack_label = substr(replace(local.name_prefix, "/[^a-zA-Z0-9._-]/", "_"), 0, 63)

  # --- Location / network zone resolution -------------------------------
  # var.region may be a location (nbg1) OR a network zone (eu-central). Servers
  # and volumes need a location; the subnet and LB need a network zone. Resolve
  # both, deriving the missing side, with explicit override vars taking priority.
  network_zones = ["eu-central", "us-east", "us-west", "ap-southeast"]
  location_zone = {
    nbg1 = "eu-central"
    fsn1 = "eu-central"
    hel1 = "eu-central"
    ash  = "us-east"
    hil  = "us-west"
    sin  = "ap-southeast"
  }
  zone_default_location = {
    "eu-central"   = "nbg1"
    "us-east"      = "ash"
    "us-west"      = "hil"
    "ap-southeast" = "sin"
  }
  region_is_zone = contains(local.network_zones, var.region)
  network_zone = var.network_zone != "" ? var.network_zone : (
    local.region_is_zone ? var.region : lookup(local.location_zone, var.region, "eu-central")
  )
  location = var.location != "" ? var.location : (
    local.region_is_zone ? lookup(local.zone_default_location, var.region, "nbg1") : var.region
  )

  # plan_key -> plan object, for compute nodes only. This map's keys ARE the
  # hcloud_server.node[...] addresses, so status maps 1:1 back to resource rows.
  # Tool-agnostic: an explicit compute_kinds allow-list wins; otherwise compute =
  # any plan item whose kind is NOT a generic foundation kind.
  compute_nodes = {
    for r in var.plan : r.plan_key => r
    if(length(var.compute_kinds) > 0
      ? contains(var.compute_kinds, r.kind)
    : !contains(var.foundation_kinds, r.kind))
  }

  # Presence flags for the optional foundation tiers (derived from the plan).
  # NOTE: `secrets` and `license-file` intentionally have NO flag/resource —
  # Hetzner has no secret store (see the gap notes above).
  has_storage = length([for r in var.plan : r if r.kind == "storage"]) > 0
  has_tls     = length([for r in var.plan : r if r.kind == "tls"]) > 0
  has_lb      = length([for r in var.plan : r if r.kind == "load-balancer"]) > 0
  has_hec     = length([for r in var.plan : r if r.kind == "hec"]) > 0

  resolved_image = var.image != "" ? var.image : "ubuntu-22.04"

  # --- Network mode: hosted-shared vs BYOC dedicated/existing -----------
  is_dedicated   = var.network_mode == "dedicated"
  lookup_network = var.network_mode == "shared" || var.network_mode == "existing"

  # Resolved network id + the single per-stack subnet ip_range, uniform across
  # all three modes. Hetzner subnets are ip_ranges (not multi-AZ objects), so one
  # subnet per stack is sufficient. `.id` on an hcloud resource is a string in
  # TF; hcloud_network_subnet.network_id accepts it and coerces to int.
  network_id          = local.is_dedicated ? hcloud_network.env[0].id : data.hcloud_network.shared[0].id
  compute_subnet_cidr = var.subnet_cidr != "" ? var.subnet_cidr : var.vpc_cidr
  # Intra-stack peer range: firewall "self"/"alb" sources resolve to the subnet
  # CIDR (there is no SG-to-SG on Hetzner). The LB's private interface lives in
  # this range too, so "alb"-sourced rules use the same CIDR.
  self_cidr = local.compute_subnet_cidr

  # --- DNS mode: no records are created on Hetzner (see gap notes). ------
  # The LB serves HTTPS only when a certificate id is supplied; otherwise HTTP.
  lb_use_https = local.has_lb && var.load_balancer != null && var.certificate_arn != ""

  # --- Derived LB gates (mirror the AWS has_lb / has_lb_spec logic) ------
  has_lb_spec = local.has_lb && var.load_balancer != null

  # Compute nodes that sit behind the LB — the kinds the app named as LB targets.
  # try() keeps it null-safe when no LB spec is present.
  lb_target_kinds = try(var.load_balancer.target_kinds, [])
  search_targets = {
    for k, r in local.compute_nodes : k => r
    if contains(local.lb_target_kinds, r.kind)
  }

  # --- Per-node function DNS labels (VERBATIM from the AWS module) -------
  # DNS-label-safe prefix per compute kind, from the app's dns_prefixes (falls
  # back to the kind string). The bring-up layer resolves intra-cluster peers by
  # these function FQDNs, so the mapping MUST be deterministic and stable.
  node_prefix = {
    for k, r in local.compute_nodes : k => lookup(var.dns_prefixes, r.kind, r.kind)
  }

  # Deterministic per-kind ordinal: the label index is the key's position within
  # its kind's lexically-sorted plan_key list (1-based via index()+1). Distinct
  # keys therefore get unique, collision-free ordinals independent of the plan's
  # input order (e.g. idx1, idx2 / sh1, sh2).
  node_keys_by_kind = {
    for kind in distinct([for k, r in local.compute_nodes : r.kind]) : kind => sort([
      for k, r in local.compute_nodes : k if r.kind == kind
    ])
  }
  node_short_labels = {
    for k, r in local.compute_nodes : k => format(
      "%s%d",
      local.node_prefix[k],
      index(local.node_keys_by_kind[r.kind], k) + 1,
    )
  }

  # plan_key -> function FQDN. Empty when no domain is set. Emitted as an output
  # (node_fqdns); NO DNS record is created for it on Hetzner.
  node_fqdns = var.dns_domain != "" ? {
    for k, label in local.node_short_labels : k => "${label}.${var.dns_domain}"
  } : {}

  # --- Label sanitization: var.tags -> hcloud labels --------------------
  # hcloud labels use a restricted charset (key/value: start+end alphanumeric,
  # inner [a-zA-Z0-9._-], <=63; NO colons). AWS tag keys like "Veltrix:Customer"
  # are invalid, so: replace every invalid char with "_", truncate to 63, then
  # trim any leading/trailing separator so the value still starts/ends alnum.
  base_labels = {
    for k, v in var.tags :
    replace(substr(replace(k, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "")
    =>
    replace(substr(replace(v, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "")
  }

  # Per-compute-node sanitized meta (plan_key/tier/kind/role carry "/" etc.).
  compute_meta = {
    for k, r in local.compute_nodes : k => {
      plan_key = replace(substr(replace(k, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "")
      tier     = replace(substr(replace(r.tier, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "")
      kind     = replace(substr(replace(r.kind, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "")
      role     = r.role != "" ? replace(substr(replace(r.role, "/[^a-zA-Z0-9._-]/", "_"), 0, 63), "/^[._-]+|[._-]+$/", "") : "none"
    }
  }

  # Fixed foundation label sets (values written pre-sanitized: "/" -> "_").
  labels_network     = merge(local.base_labels, { "Name" = "${local.stack_label}-network", "Veltrix_PlanKey" = "foundation_network", "Veltrix_Tier" = "foundation", "veltrix-stack" = local.stack_label })
  labels_storage     = merge(local.base_labels, { "Name" = "${local.stack_label}-volume", "Veltrix_PlanKey" = "foundation_storage", "Veltrix_Tier" = "foundation", "veltrix-stack" = local.stack_label })
  labels_lb          = merge(local.base_labels, { "Name" = "${local.stack_label}-lb", "Veltrix_PlanKey" = "foundation_load-balancer", "Veltrix_Tier" = "foundation", "veltrix-stack" = local.stack_label })
  labels_firewall    = merge(local.base_labels, { "Name" = "${local.stack_label}-fw", "Veltrix_PlanKey" = "foundation_network", "Veltrix_Tier" = "foundation", "veltrix-stack" = local.stack_label })

  # Per-compute-node label set (base + sanitized meta + the stack selector label).
  compute_labels = {
    for k, r in local.compute_nodes : k => merge(local.base_labels, {
      "Name"            = "${local.host_prefix}-${local.node_short_labels[k]}"
      "Veltrix_PlanKey" = local.compute_meta[k].plan_key
      "Veltrix_Tier"    = local.compute_meta[k].tier
      "Veltrix_Kind"    = local.compute_meta[k].kind
      "Veltrix_Role"    = local.compute_meta[k].role
      "veltrix-stack"   = local.stack_label
    })
  }

  # --- Flattened firewall ingress rules (from the app's security_rules) --
  # There is NO SG-to-SG on Hetzner: each source resolves to a CIDR.
  #   self  -> the stack subnet CIDR (peer nodes)
  #   alb   -> the stack subnet CIDR (the LB's private interface range); the pair
  #            is dropped when there is no LB, exactly like the AWS module.
  #   admin -> var.admin_cidr
  # The map key is "<port>-<protocol>-<cidr>", which DEDUPES the common case where
  # self and alb resolve to the same CIDR (one firewall rule instead of two).
  source_cidr = {
    self  = local.self_cidr
    alb   = local.self_cidr
    admin = var.admin_cidr
  }
  fw_rules = {
    for e in flatten([
      for r in var.security_rules : [
        for s in r.sources : {
          port        = r.port
          protocol    = r.protocol
          cidr        = local.source_cidr[s]
          description = r.description != "" ? r.description : "port ${r.port} (${r.protocol}) from ${s}"
        }
        if !(s == "alb" && !local.has_lb)
      ]
    ]) : "${e.port}-${e.protocol}-${e.cidr}" => e
  }
}

# --- Network lookup (network_mode = shared | existing) --------------------
# The network is data-sourced (never created) — the shared Veltrix network for
# hosted, or a customer-designated network for BYOC "existing". Absent when
# dedicated. Resolved by name (default), id, or a label selector (network_lookup_by).
data "hcloud_network" "shared" {
  count         = local.lookup_network ? 1 : 0
  id            = var.network_lookup_by == "id" ? var.network_ref : null
  name          = var.network_lookup_by == "name" ? var.network_ref : null
  with_selector = var.network_lookup_by == "tag" ? var.network_ref : null
}

# --- Dedicated network fabric (network_mode = dedicated / BYOC) ------------
# A fresh, isolated private network created in the DEPLOY account (the
# customer's, for BYOC). One cloud subnet is carved from it (below). Nothing
# here runs in shared/existing mode.
resource "hcloud_network" "env" {
  count    = local.is_dedicated ? 1 : 0
  name     = "${local.host_prefix}-net"
  ip_range = var.vpc_cidr
  labels   = local.labels_network
}

# The stack's single cloud subnet, in the resolved network (all three modes).
# hcloud subnets have no standalone id — the resource id is "<network_id>-<range>".
resource "hcloud_network_subnet" "env" {
  network_id   = local.network_id
  type         = "cloud"
  network_zone = local.network_zone
  ip_range     = local.compute_subnet_cidr
}

# --- Firewall: the SG analog (CIDR-scoped, label-attached) -----------------
# One `rule` per (security_rules entry, applicable source), direction=in. Hetzner
# has no SG-to-SG, so sources are CIDRs (see local.fw_rules). The firewall
# attaches to THIS stack's servers via the `veltrix-stack` label selector — the
# per-stack isolation boundary. A firewall with rules is default-DENY inbound;
# outbound is unrestricted by default (mirrors the AWS "all egress" rule), so no
# explicit egress rule is needed. The resource is always created so
# security_group_id is stable (matching the AWS always-present node SG).
resource "hcloud_firewall" "node" {
  name   = "${local.host_prefix}-fw"
  labels = local.labels_firewall

  dynamic "rule" {
    for_each = local.fw_rules
    content {
      direction   = "in"
      protocol    = rule.value.protocol
      port        = tostring(rule.value.port)
      source_ips  = [rule.value.cidr]
      description = substr(rule.value.description, 0, 255)
    }
  }

  apply_to {
    label_selector = "veltrix-stack==${local.stack_label}"
  }
}

# --- Compute: one hcloud_server per compute plan item ----------------------
# for_each keyed by plan_key => hcloud_server.node["data/indexer-1"] etc. The
# server keeps its default public interface (egress); its private IP comes from
# the hcloud_server_network attachment below. name = function short-label,
# prefixed with the stack for cross-stack uniqueness (a valid RFC1123 hostname).
resource "hcloud_server" "node" {
  for_each = local.compute_nodes

  name  = "${local.host_prefix}-${local.node_short_labels[each.key]}"
  image = local.resolved_image
  server_type = coalesce(
    lookup(var.server_types_by_kind, each.value.kind, null),
    lookup(var.server_types, each.value.tier, null),
    var.default_server_type,
  )
  location = local.location
  ssh_keys = var.ssh_keys
  labels   = local.compute_labels[each.key]

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }
}

# Attach each server to the per-stack subnet, giving it a private IP.
resource "hcloud_server_network" "node" {
  for_each  = local.compute_nodes
  server_id = hcloud_server.node[each.key].id
  subnet_id = hcloud_network_subnet.env.id
}

# --- Storage: block volume (object storage is external — see gap notes) -----
# Hetzner Object Storage is S3-compatible but not in the hcloud provider, so a
# `storage` plan item provisions a block volume instead. The app's meaning of
# the storage is app-defined (InfraSpec.storage); the module just provisions it.
resource "hcloud_volume" "objstore" {
  count             = local.has_storage ? 1 : 0
  name              = "${local.host_prefix}-vol"
  size              = var.storage_volume_gb
  location          = local.location
  format            = "ext4"
  labels            = local.labels_storage
  delete_protection = false
}

# --- TLS ------------------------------------------------------------------
# NO certificate resource is created here. A MANAGED hcloud certificate needs
# Hetzner DNS (out of the hcloud provider); an UPLOADED certificate is
# provisioned out-of-band. The LB references var.certificate_arn (an hcloud
# certificate id) on its HTTPS service when provided (see below).

# --- Load balancer: the app's web tier + HEC ingress ----------------------
# hcloud_load_balancer + a network attachment (private interface) + one service
# + per-server targets. NO WAF (Hetzner has none — waf_enabled is a no-op) and
# NO LB-level MFA (alb_auth is a no-op). Both vars are accepted for contract
# parity only; realizing either would need an external reverse-proxy/CDN tier.
resource "hcloud_load_balancer" "env" {
  count              = local.has_lb ? 1 : 0
  name               = "${local.host_prefix}-lb"
  load_balancer_type = "lb11"
  network_zone       = local.network_zone
  labels             = local.labels_lb
}

# Attach the LB to the private network so it can reach nodes on their private IPs.
resource "hcloud_load_balancer_network" "env" {
  count            = local.has_lb ? 1 : 0
  load_balancer_id = hcloud_load_balancer.env[0].id
  network_id       = local.network_id
  depends_on       = [hcloud_network_subnet.env]
}

# The web service: HTTPS (with the supplied cert + automatic HTTP->HTTPS
# redirect) when certificate_arn is set, else plain HTTP on the listener port.
# Port / health-check all come from the app's load_balancer spec. Gated on
# has_lb_spec (plan LB item + a spec), so var.load_balancer is non-null here.
resource "hcloud_load_balancer_service" "web" {
  count            = local.has_lb_spec ? 1 : 0
  load_balancer_id = hcloud_load_balancer.env[0].id
  protocol         = local.lb_use_https ? "https" : "http"
  listen_port      = var.load_balancer.listener_port
  destination_port = var.load_balancer.target_port

  dynamic "http" {
    for_each = local.lb_use_https ? [1] : []
    content {
      certificates  = [tonumber(var.certificate_arn)]
      redirect_http = true
    }
  }

  health_check {
    protocol = lower(var.load_balancer.health_check_protocol != "" ? var.load_balancer.health_check_protocol : var.load_balancer.target_protocol)
    port     = var.load_balancer.target_port
    interval = 15
    timeout  = 10
    retries  = 3

    http {
      # Hetzner uses status-code patterns (e.g. "2??"), not the AWS matcher range
      # "200-399"; "2??"/"3??" is the faithful equivalent of the default matcher.
      path         = var.load_balancer.health_check_path
      status_codes = ["2??", "3??"]
    }
  }
}

# One target per web-serving node (the kinds the app named in the LB spec's
# target_kinds). Keyed by plan_key so the set tracks the compute for_each.
# use_private_ip requires the LB + servers to share the private network, hence
# the depends_on on both network attachments.
resource "hcloud_load_balancer_target" "web" {
  for_each         = local.has_lb_spec ? local.search_targets : {}
  type             = "server"
  load_balancer_id = hcloud_load_balancer.env[0].id
  server_id        = hcloud_server.node[each.key].id
  use_private_ip   = true

  depends_on = [
    hcloud_load_balancer_network.env,
    hcloud_server_network.node,
  ]
}

# --- WAF: NO-OP (Hetzner has no WAF) --------------------------------------
# `var.waf_enabled` is accepted for cross-cloud contract parity but realizes
# NOTHING here — Hetzner Cloud has no WAF primitive. Web-application filtering
# would require an external reverse proxy / CDN (e.g. a self-managed nginx+
# modsecurity server or a third-party CDN WAF) in front of the LB, provisioned
# as a separate out-of-band tier. Documented, not faked.

# --- MFA (alb_auth): NO-OP (no LB-level OIDC on Hetzner) ------------------
# `var.alb_auth` is accepted for contract parity but realizes NOTHING — Hetzner
# LBs have no Cognito/OIDC equivalent. Enforce MFA at the app (Splunk SAML/OIDC)
# or via an external identity-aware proxy. Documented, not faked.

# --- DNS records: NONE created (see gap notes at top) ---------------------
# The hcloud provider has no managed-DNS resource. Per-node FQDNs are computed
# (local.node_fqdns) and emitted as an output for the out-of-band bring-up layer
# (a `timohirt/hetznerdns` stack, or /etc/hosts built from node_fqdns +
# instance_private_ips). dns_mode / create_private_zone / private_zone_id are
# kept as accepted no-op variables so the worker passes a uniform var set.
