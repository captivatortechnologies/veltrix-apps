# =============================================================================
# GCP environment module — generic, tool-agnostic. A faithful translation of
# sdk/opentofu/modules/aws (the reference), honoring the SAME variable + output
# contract. Driven by an app's rendered InfraSpec; NOTHING here is tool-specific.
#
# Network mode (worker-set deployment var, NOT app InfraSpec):
#   shared    — Veltrix-hosted: data-source the shared network + create ONE
#               per-stack subnetwork (subnet_cidr) in it.
#   dedicated — BYOC: CREATE a fresh custom-mode network + a subnetwork (vpc_cidr)
#               + Cloud Router + Cloud NAT for private egress.
#   existing  — BYOC: data-source a customer network + create a subnetwork in it.
# DNS mode: managed (in-project public A record → LB global IP + a Google-managed
#   SSL cert) / delegated (worker does the cross-account public DNS; module uses
#   certificate_arn) / private-only.
#
# GCP↔AWS mapping notes:
#   * SG-to-SG least privilege → a per-stack NETWORK TAG (local.stack_tag) applied
#     to every instance, plus google_compute_firewall rules keyed by (rule,source).
#     "self" => source_tags = [stack_tag]; "admin" => admin_cidr; "alb" => Google's
#     LB health-check + proxy ranges. GCP has no per-instance security group.
#   * ALB + WAFv2 → EXTERNAL_MANAGED global HTTPS LB (health check + unmanaged
#     instance group + backend service + url map + HTTPS proxy + global forwarding
#     rule + global address) with a Cloud Armor security policy for WAF.
#   * Compute has NO public IP in any mode; egress is via Cloud NAT (dedicated) or
#     the shared network's own NAT (shared/existing), mirroring AWS private subnets.
#   * Cognito MFA (alb_auth) → GCP IAP is a follow-on; the var is NO-OP'd here.
#   * Tags → sanitized LABELS (see local.labels) on every labelable resource.
#
# One compute instance per compute plan item (for_each keyed by plan_key) +
# storage / secrets / TLS / LB / DNS per topology tier. Cost/attribution:
# sanitized var.tags on every labelable resource.
# =============================================================================

locals {
  # Short, DNS/label-safe prefix. infrastructure_id is a UUID; 8 chars is enough
  # to disambiguate within a customer while staying under GCP name limits. Used
  # for human-facing label VALUES / descriptions (not as a resource name).
  name_prefix = "${var.app_id}-${substr(var.infrastructure_id, 0, 8)}"

  # The per-stack GCP NETWORK TAG. This is the SG-to-SG analog: it is applied to
  # every instance and referenced by the firewall rules (self / target). It also
  # serves as the base for every GCP resource NAME, so it MUST satisfy RFC1035 /
  # the network-tag charset `[a-z]([-a-z0-9]*[a-z0-9])?`. We lowercase and replace
  # any invalid char with "-"; name_prefix starts with app_id (a letter) and ends
  # with a hex char, so the result starts with a letter and ends alnum.
  stack_tag = substr(lower(replace(local.name_prefix, "/[^a-zA-Z0-9-]/", "-")), 0, 63)

  # plan_key -> plan object, for compute nodes only. This map's keys ARE the
  # google_compute_instance.node[...] addresses, so status maps 1:1 back to rows.
  # Tool-agnostic: an explicit compute_kinds allow-list wins; otherwise compute =
  # any plan item whose kind is NOT a generic foundation kind. So an app's roles
  # (Splunk indexer/search-head, Security Onion sensor/manager, ...) are compute
  # automatically, with no per-tool list in the module.
  compute_nodes = {
    for r in var.plan : r.plan_key => r
    if(length(var.compute_kinds) > 0
      ? contains(var.compute_kinds, r.kind)
    : !contains(var.foundation_kinds, r.kind))
  }

  # Presence flags for the optional foundation tiers (derived from the plan).
  has_storage      = length([for r in var.plan : r if r.kind == "storage"]) > 0
  has_secrets      = length([for r in var.plan : r if r.kind == "secrets"]) > 0
  has_license_file = length([for r in var.plan : r if r.kind == "license-file"]) > 0
  has_tls          = length([for r in var.plan : r if r.kind == "tls"]) > 0
  has_lb           = length([for r in var.plan : r if r.kind == "load-balancer"]) > 0
  has_dns          = length([for r in var.plan : r if r.kind == "dns"]) > 0 && var.public_dns_managed_zone != ""
  has_hec          = length([for r in var.plan : r if r.kind == "hec"]) > 0

  resolved_image = var.image != "" ? var.image : data.google_compute_image.default.self_link

  # --- Tags -> GCP labels sanitization ----------------------------------
  # GCP labels: keys+values match [a-z0-9_-], keys start with a letter, <=63 chars.
  # The Veltrix tag keys (Veltrix:Customer, CostCenter, ...) are INVALID as-is, so
  # every taggable resource gets local.labels instead of var.tags: lowercase, any
  # char outside [a-zA-Z0-9_-] replaced with "_", truncated to 63. The canonical
  # Veltrix tag keys all start with a letter, so the sanitized keys are valid.
  labels = {
    for k, v in var.tags :
    substr(lower(replace(k, "/[^a-zA-Z0-9_-]/", "_")), 0, 63) =>
    substr(lower(replace(v, "/[^a-zA-Z0-9_-]/", "_")), 0, 63)
  }

  # --- Network mode: hosted-shared vs BYOC dedicated/existing -----------
  is_dedicated   = var.network_mode == "dedicated"
  lookup_network = var.network_mode == "shared" || var.network_mode == "existing"

  # Resolved network self-link, uniform across all three modes:
  #   dedicated -> the created custom-mode network
  #   shared/existing -> the looked-up network
  network_self_link = local.is_dedicated ? google_compute_network.env[0].self_link : data.google_compute_network.shared[0].self_link

  # Single per-stack subnetwork (GCP LBs are global/regional and don't need the
  # multi-AZ public/private split AWS uses). One subnet in all modes.
  compute_subnet_ids = [google_compute_subnetwork.env.self_link]
  # Compute nodes are spread round-robin across the available compute subnets
  # (a single subnet here, so all land on index 0). Kept for AWS parity.
  compute_subnet_for = {
    for idx, k in sort(keys(local.compute_nodes)) : k =>
    local.compute_subnet_ids[idx % length(local.compute_subnet_ids)]
  }

  # --- DNS mode: managed (in-project) / delegated (worker x-account) / none
  dns_managed    = var.dns_mode == "managed"
  has_public_dns = var.dns_mode != "private-only"
  # The listener cert is either issued here (managed) or supplied (delegated).
  listener_cert = local.dns_managed ? (
    (local.has_tls && var.dns_domain != "") ? google_compute_managed_ssl_certificate.env[0].id : ""
  ) : var.certificate_arn

  # --- Derived LB / listener gates --------------------------------------
  # has_lb = the plan carries a load-balancer item; has_lb_spec additionally
  # requires the app to have supplied a load_balancer spec. The backend service +
  # health check build only when a spec is present. has_listener adds the TLS cert
  # + domain (plan-time-known, like the other has_* flags), gating the HTTPS proxy
  # + forwarding rule identically.
  has_lb_spec = local.has_lb && var.load_balancer != null
  # HTTPS front door needs a cert: issued here (managed + a tls plan item) or
  # supplied by the worker (delegated + certificate_arn).
  has_listener = local.has_lb_spec && var.dns_domain != "" && (
    local.dns_managed ? local.has_tls : var.certificate_arn != ""
  )
  # Cognito MFA (alb_auth) -> GCP IAP is a documented follow-on; NO-OP here. The
  # flag is surfaced for parity but drives no resources (see header + variables).
  alb_auth_enabled = var.alb_auth.enabled

  # Health-check protocol from the LB spec (falls back to target protocol). Guarded
  # so it never dereferences a null load_balancer.
  hc_protocol = local.has_lb_spec ? (
    var.load_balancer.health_check_protocol != "" ? var.load_balancer.health_check_protocol : var.load_balancer.target_protocol
  ) : ""

  # Compute nodes that sit behind the LB — the kinds the app named as LB targets
  # (e.g. Splunk search-head/standalone). try() keeps it null-safe when no spec.
  lb_target_kinds = try(var.load_balancer.target_kinds, [])
  search_targets = {
    for k, r in local.compute_nodes : k => r
    if contains(local.lb_target_kinds, r.kind)
  }

  # --- Per-node function DNS labels -------------------------------------
  # DNS-label-safe prefix per compute kind, from the app's dns_prefixes (falls
  # back to the kind string). The bring-up layer resolves intra-cluster peers by
  # these function FQDNs (e.g. idx1.<domain>), so the mapping MUST be
  # deterministic and stable across applies. (Verbatim from the AWS module.)
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

  # plan_key -> function FQDN in the private zone. Empty when no domain is set.
  node_fqdns = var.dns_domain != "" ? {
    for k, label in local.node_short_labels : k => "${label}.${var.dns_domain}"
  } : {}

  # --- Private DNS zone resolution --------------------------------------
  # Either create a private managed zone for var.dns_domain (create_private_zone)
  # or point at a caller-supplied one (private_zone_id). want_private_dns is the
  # plan-time-known intent used to gate the per-node record for_each (the zone name
  # itself may stay computed until apply, which is fine for a record attribute but
  # NOT for a for_each key set).
  create_private_zone = var.create_private_zone && var.dns_domain != "" && var.private_zone_id == ""
  want_private_dns    = var.dns_domain != "" && (var.private_zone_id != "" || local.create_private_zone)
  private_zone_name = var.private_zone_id != "" ? var.private_zone_id : (
    local.create_private_zone ? google_dns_managed_zone.private[0].name : ""
  )

  # --- Flattened firewall ingress rules (from the app's security_rules) --
  # Each (rule, source) pair becomes one google_compute_firewall, keyed
  # "<port>-<protocol>-<source>". "alb"-sourced rules are dropped when there is no
  # LB. This replaces any hardcoded, tool-specific port list — the app declares its
  # ports in InfraSpec.securityRules. (Verbatim shape from the AWS module.)
  fw_ingress = merge([
    for r in var.security_rules : {
      for s in r.sources : "${r.port}-${r.protocol}-${s}" => {
        port        = r.port
        protocol    = r.protocol
        source      = s
        description = r.description != "" ? r.description : "port ${r.port} (${r.protocol}) from ${s}"
      }
      if !(s == "alb" && !local.has_lb)
    }
  ]...)

  # Google Cloud Load Balancing health-check + proxy source ranges (used by the
  # "alb"-sourced firewall rules so the LB can reach the backends + health-check).
  gclb_ranges = ["130.211.0.0/22", "35.191.0.0/16"]
}

# Scaffold fallback image only. Production must pass a tool-preinstalled image.
data "google_compute_image" "default" {
  family  = "debian-12"
  project = "debian-cloud"
}

# --- Network lookup (network_mode = shared | existing) --------------------
# The network is data-sourced (never created) — the shared Veltrix network for
# hosted, or a customer-designated network for BYOC "existing". Absent when
# dedicated. GCP networks are keyed by NAME (no tag lookup), so network_ref is the
# network name for both network_lookup_by values.

data "google_compute_network" "shared" {
  count   = local.lookup_network ? 1 : 0
  name    = var.network_ref
  project = var.project
}

# --- Dedicated network fabric (network_mode = dedicated / BYOC) ------------
# A fresh, isolated custom-mode network created in the DEPLOY project (the
# customer's, for BYOC), plus a Cloud Router + Cloud NAT so the private (no public
# IP) instances get egress. Nothing here runs in shared/existing mode.

resource "google_compute_network" "env" {
  count                   = local.is_dedicated ? 1 : 0
  name                    = "${local.stack_tag}-net"
  project                 = var.project
  auto_create_subnetworks = false
}

resource "google_compute_router" "env" {
  count   = local.is_dedicated ? 1 : 0
  name    = "${local.stack_tag}-router"
  project = var.project
  region  = var.region
  network = google_compute_network.env[0].self_link
}

resource "google_compute_router_nat" "env" {
  count                              = local.is_dedicated ? 1 : 0
  name                               = "${local.stack_tag}-nat"
  project                            = var.project
  region                             = var.region
  router                             = google_compute_router.env[0].name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# --- Subnetwork (all modes) -----------------------------------------------
# The stack's single subnetwork: in the created network (dedicated, range =
# vpc_cidr) or the looked-up network (shared/existing, range = subnet_cidr).
# private_ip_google_access lets no-public-IP instances reach Google APIs
# (Secret Manager / Storage) without traversing the NAT. Subnetworks are NOT
# labelable in GCP.

resource "google_compute_subnetwork" "env" {
  name                     = "${local.stack_tag}-subnet"
  project                  = var.project
  region                   = var.region
  network                  = local.network_self_link
  ip_cidr_range            = local.is_dedicated ? var.vpc_cidr : var.subnet_cidr
  private_ip_google_access = true
}

# --- Firewall: SG-to-SG least privilege via a per-stack network tag --------
# GCP has no per-instance security group. Instead every instance carries the
# stack network tag (local.stack_tag), and each (security_rules entry, source)
# becomes one firewall rule targeting that tag. "self" -> source_tags (this
# stack's own instances); "admin" -> admin_cidr; "alb" -> Google's LB
# health-check + proxy ranges. Exactly one origin is set per rule; the other is
# null (omitted). "alb" rules are pre-filtered out of fw_ingress when there is no
# LB. Firewalls are NOT labelable in GCP.

resource "google_compute_firewall" "node" {
  for_each = local.fw_ingress

  name        = substr("${local.stack_tag}-${each.key}", 0, 63)
  project     = var.project
  network     = local.network_self_link
  direction   = "INGRESS"
  description = each.value.description

  allow {
    protocol = each.value.protocol
    ports    = [tostring(each.value.port)]
  }

  target_tags = [local.stack_tag]
  source_tags = each.value.source == "self" ? [local.stack_tag] : null
  source_ranges = (
    each.value.source == "admin" ? [var.admin_cidr] :
    each.value.source == "alb" ? local.gclb_ranges :
    null
  )
}

# --- Compute: one google_compute_instance per compute plan item ------------
# for_each keyed by plan_key => google_compute_instance.node["data/indexer-1"].
# No public IP (egress via Cloud NAT). The stack network tag ties the instance to
# the firewall rules above. `hostname` must be a FQDN on GCP, so we use the node
# function FQDN when a domain is set (else omit -> the default internal name).

resource "google_compute_instance" "node" {
  for_each = local.compute_nodes

  name    = substr(lower("${local.stack_tag}-${local.node_short_labels[each.key]}"), 0, 63)
  project = var.project
  # Multi-AZ placement: pin to the node's zone when set, else the default zone.
  zone = coalesce(each.value.zone, var.zone)
  machine_type = coalesce(
    lookup(var.machine_types_by_kind, each.value.kind, null),
    lookup(var.machine_types, each.value.tier, null),
    var.default_machine_type,
  )
  hostname = lookup(local.node_fqdns, each.key, null)

  boot_disk {
    initialize_params {
      image = local.resolved_image
      size  = var.boot_disk_gb
      type  = "pd-ssd"
    }
  }

  network_interface {
    subnetwork = local.compute_subnet_for[each.key]
    # No access_config block => no external IP. Egress is via Cloud NAT.
  }

  tags     = [local.stack_tag]
  metadata = var.ssh_public_key != "" ? { "ssh-keys" = var.ssh_public_key } : {}

  labels = local.labels
}

# --- Storage: object-storage bucket (e.g. Splunk SmartStore, warm/cold) -----
# Generic GCS bucket for the app's bulk/object storage. Private: uniform
# bucket-level access + enforced public-access prevention (no ACLs, no public).

resource "random_id" "bucket_suffix" {
  count       = local.has_storage ? 1 : 0
  byte_length = 4
}

resource "google_storage_bucket" "objstore" {
  count                       = local.has_storage ? 1 : 0
  name                        = "${local.stack_tag}-objstore-${random_id.bucket_suffix[0].hex}"
  project                     = var.project
  location                    = var.region
  force_destroy               = false
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = local.labels
}

# --- Secrets: per-tenant secret bundle (admin seed / pass4SymmKey / etc.) ----

resource "google_secret_manager_secret" "env" {
  count     = local.has_secrets ? 1 : 0
  secret_id = "${local.stack_tag}-env-secrets"
  project   = var.project

  replication {
    auto {}
  }

  labels = local.labels
}

# --- BYOL license file (stored as a secret; validated post-apply) ---------

resource "google_secret_manager_secret" "license" {
  count     = local.has_license_file ? 1 : 0
  secret_id = "${local.stack_tag}-byol-license"
  project   = var.project

  replication {
    auto {}
  }

  labels = local.labels
}

# --- TLS certificate (Google-managed, for the public domain) --------------
# Issued in-project only for dns_mode = managed. In delegated mode the worker
# provisions the cert and passes certificate_arn (a cert self-link). Managed SSL
# certs are NOT labelable in GCP.

resource "google_compute_managed_ssl_certificate" "env" {
  count   = local.dns_managed && local.has_tls && var.dns_domain != "" ? 1 : 0
  name    = "${local.stack_tag}-cert"
  project = var.project

  managed {
    domains = [var.dns_domain]
  }

  # NOTE: unlike the AWS ACM cert (create_before_destroy), a google_compute_
  # managed_ssl_certificate has a unique NAME, so create_before_destroy would fail
  # on replacement (two certs can't share a name). Cert domain changes are rare;
  # we take the default replace behaviour. Zero-downtime cert rotation would use a
  # name suffix (random_id), a GCP-specific follow-on.
}

# --- Load balancer: EXTERNAL_MANAGED global HTTPS LB ----------------------
# The front door for the app's web tier + HEC ingress. Global external
# Application LB: a reserved global IP + health check + unmanaged instance group
# (target-kind instances) + backend service + url map + HTTPS proxy + global
# forwarding rule. Google runs the proxy fleet, so (unlike the AWS ALB) there is
# no public edge subnet/SG — client access is governed by Cloud Armor.

# Reserved global IPv4 for the LB frontend. Gated on has_lb (mirrors aws_lb).
resource "google_compute_global_address" "lb" {
  count      = local.has_lb ? 1 : 0
  name       = "${local.stack_tag}-lb-ip"
  project    = var.project
  ip_version = "IPV4"
}

# Health check from the app's load_balancer spec. Port = the LB target port (the
# GCP equivalent of the ALB's "traffic-port"), so the "alb"-sourced firewall rule
# on that port also admits health checks. HTTP vs HTTPS selected by hc_protocol.
resource "google_compute_health_check" "lb" {
  count   = local.has_lb_spec ? 1 : 0
  name    = "${local.stack_tag}-hc"
  project = var.project

  dynamic "http_health_check" {
    for_each = local.hc_protocol == "HTTP" ? [1] : []
    content {
      port         = var.load_balancer.target_port
      request_path = var.load_balancer.health_check_path
    }
  }

  dynamic "https_health_check" {
    for_each = local.hc_protocol == "HTTPS" ? [1] : []
    content {
      port         = var.load_balancer.target_port
      request_path = var.load_balancer.health_check_path
    }
  }
}

# Unmanaged instance group holding the web-serving nodes (the kinds the app named
# in the LB spec's target_kinds), added by self-link. named_port maps the target
# port to the "http" port name the backend service references.
resource "google_compute_instance_group" "lb" {
  count     = local.has_lb_spec ? 1 : 0
  name      = "${local.stack_tag}-ig"
  project   = var.project
  zone      = var.zone
  instances = [for k, r in local.search_targets : google_compute_instance.node[k].self_link]

  named_port {
    name = "http"
    port = var.load_balancer.target_port
  }
}

# Backend service: protocol from target_protocol, the health check, and the
# instance group backend. Cloud Armor security policy attached when waf_enabled.
resource "google_compute_backend_service" "lb" {
  count                 = local.has_lb_spec ? 1 : 0
  name                  = "${local.stack_tag}-backend"
  project               = var.project
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = var.load_balancer.target_protocol
  port_name             = "http"
  health_checks         = [google_compute_health_check.lb[0].id]
  security_policy       = var.waf_enabled ? google_compute_security_policy.waf[0].id : null

  backend {
    group           = google_compute_instance_group.lb[0].self_link
    balancing_mode  = "UTILIZATION"
    capacity_scaler = 1.0
  }
}

resource "google_compute_url_map" "lb" {
  count           = local.has_lb_spec ? 1 : 0
  name            = "${local.stack_tag}-urlmap"
  project         = var.project
  default_service = google_compute_backend_service.lb[0].id
}

# HTTPS proxy + global forwarding rule — the public listener. Gated on
# has_listener (LB spec + domain + a cert: managed cert here, or certificate_arn).
resource "google_compute_target_https_proxy" "lb" {
  count            = local.has_listener ? 1 : 0
  name             = "${local.stack_tag}-https-proxy"
  project          = var.project
  url_map          = google_compute_url_map.lb[0].id
  ssl_certificates = [local.listener_cert]
}

resource "google_compute_global_forwarding_rule" "lb" {
  count                 = local.has_listener ? 1 : 0
  name                  = "${local.stack_tag}-fr"
  project               = var.project
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.lb[0].id
  ip_address            = google_compute_global_address.lb[0].address
  port_range            = tostring(var.load_balancer.listener_port)

  labels = local.labels
}

# NOTE: an HTTP(80)->HTTPS redirect (the AWS module's http listener) is omitted —
# on GCP it needs a separate redirect url-map + HTTP target proxy + forwarding
# rule. It can be added as a follow-on; the primary HTTPS front door is complete.

# --- Cloud Armor (WAF analog) ---------------------------------------------
# Attached to the backend service when waf_enabled. Default allow, with OWASP
# preconfigured rules (SQLi/XSS) blocking and a per-IP rate limit (~2000 req /
# 5 min), mirroring the AWS WAFv2 managed rule groups + rate-based rule. Gated on
# has_lb (a Cloud Armor policy fronts the LB backend). Not labelable.

resource "google_compute_security_policy" "waf" {
  count   = local.has_lb && var.waf_enabled ? 1 : 0
  name    = "${local.stack_tag}-waf"
  project = var.project

  # OWASP CRS: SQL injection.
  rule {
    action      = "deny(403)"
    priority    = 1000
    description = "OWASP CRS: SQL injection"

    match {
      expr {
        expression = "evaluatePreconfiguredExpr('sqli-v33-stable')"
      }
    }
  }

  # OWASP CRS: cross-site scripting.
  rule {
    action      = "deny(403)"
    priority    = 1001
    description = "OWASP CRS: cross-site scripting"

    match {
      expr {
        expression = "evaluatePreconfiguredExpr('xss-v33-stable')"
      }
    }
  }

  # Volumetric protection: throttle a source IP over ~2000 requests / 5 min.
  rule {
    action      = "throttle"
    priority    = 2000
    description = "Per-IP rate limit"

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }

    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"

      rate_limit_threshold {
        count        = 2000
        interval_sec = 300
      }
    }
  }

  # Required default rule (lowest priority): allow everything else.
  rule {
    action      = "allow"
    priority    = 2147483647
    description = "Default allow"

    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
  }
}

# --- Public DNS record ----------------------------------------------------
# Created in-project only for dns_mode = managed. delegated => the worker writes
# it cross-account into Veltrix's zone; private-only => no public record. An A
# record to the LB's reserved global IP (GCP LBs have no DNS name to alias).

resource "google_dns_record_set" "env" {
  count        = local.dns_managed && local.has_dns && local.has_lb ? 1 : 0
  name         = "${var.dns_domain}."
  project      = var.project
  managed_zone = var.public_dns_managed_zone
  type         = "A"
  ttl          = 60
  rrdatas      = [google_compute_global_address.lb[0].address]
}

# --- Private DNS: intra-cluster function FQDNs ----------------------------
# A private managed zone (visibility = private, bound to the stack network) gives
# every node a stable function FQDN (idx1.<domain>, sh1.<domain>, ...). The
# bring-up layer uses node_fqdns (see outputs) to build its inventory. Either
# create the zone here (create_private_zone) or reuse a caller-supplied one
# (private_zone_id).

resource "google_dns_managed_zone" "private" {
  count      = local.create_private_zone ? 1 : 0
  name       = "${local.stack_tag}-private"
  project    = var.project
  dns_name   = "${var.dns_domain}."
  visibility = "private"

  private_visibility_config {
    networks {
      network_url = local.network_self_link
    }
  }

  labels = local.labels
}

# One A record per compute node -> its private IP, keyed by plan_key so the set
# tracks the compute for_each. Gated on want_private_dns (plan-time-known) so the
# key set never depends on the not-yet-known created-zone name.
resource "google_dns_record_set" "node" {
  for_each     = local.want_private_dns ? local.node_fqdns : {}
  name         = "${each.value}."
  project      = var.project
  managed_zone = local.private_zone_name
  type         = "A"
  ttl          = 60
  rrdatas      = [google_compute_instance.node[each.key].network_interface[0].network_ip]
}
