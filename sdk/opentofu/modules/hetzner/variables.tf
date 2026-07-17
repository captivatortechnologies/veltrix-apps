# =============================================================================
# Hetzner Cloud environment module — input variables.
#
# A faithful, tool-agnostic translation of the AWS reference module
# (sdk/opentofu/modules/aws). It honors the SAME variable + output contract:
# the spec-derived block (foundation_kinds, compute_kinds, security_rules,
# load_balancer, dns_prefixes, waf_enabled, alb_auth) is byte-identical to AWS
# so `renderInfraVars` output feeds every cloud unchanged; the deployment vars
# keep the AWS names and adapt only the Hetzner specifics (server_type, image,
# ssh_keys, network zone/location).
#
# One BYOL environment (a "stack") = one per-stack cloud subnet on a Hetzner
# private network, plus one hcloud_server per compute plan item and the
# storage / TLS / LB a tier needs. See the gap notes in main.tf for the honest
# handling of Hetzner's missing primitives (WAF, in-provider DNS, object store,
# secret store, LB-level MFA).
# =============================================================================

# --- Identity / naming / tenancy ------------------------------------------

variable "app_id" {
  description = "Owning app id, e.g. splunk-enterprise. Used for naming + state key."
  type        = string
}

variable "customer_id" {
  description = "Tenant (customer) id. Used for naming + label Veltrix_Customer."
  type        = string
}

variable "infrastructure_id" {
  description = "BYOL infrastructure (environment/stack) id. Unique per stack."
  type        = string
}

variable "provider_code" {
  description = "Cloud provider code (informational; this module is Hetzner). One of aws|azure|gcp|hetzner."
  type        = string
  default     = "hetzner"
}

variable "region" {
  description = <<-EOT
    Hetzner target region. Accepts EITHER a location (e.g. nbg1, fsn1, hel1,
    ash, hil, sin) OR a network zone (e.g. eu-central, us-east, us-west,
    ap-southeast). Servers/volumes/LB use the location; the private network
    subnet + LB use the network zone. When a location is given the zone is
    derived (and vice-versa); override explicitly with `location` / `network_zone`.
  EOT
  type        = string
}

variable "location" {
  description = "Explicit Hetzner location for servers/volumes (e.g. nbg1). Empty = derive from region."
  type        = string
  default     = ""
}

variable "network_zone" {
  description = "Explicit Hetzner network zone for the subnet + LB (e.g. eu-central). Empty = derive from region."
  type        = string
  default     = ""
}

# --- Network (mode: hosted-shared vs BYOC dedicated/existing) --------------
# network_mode is a DEPLOYMENT-TARGET var set by the worker per environment — it
# is NOT part of the app's InfraSpec (which describes only the tool). One app
# spec deploys hosted OR into a customer's own account, any cloud.

variable "network_mode" {
  description = <<-EOT
    How the environment's network is sourced:
      shared    — Veltrix-hosted: data-source the shared hcloud_network
                  (network_ref) and create the per-stack cloud subnet (subnet_cidr).
      dedicated — BYOC: CREATE a fresh hcloud_network (vpc_cidr) + one cloud
                  subnet (subnet_cidr, or the whole ip_range), isolated per env.
      existing  — BYOC: data-source a customer-designated hcloud_network
                  (network_ref) and create a subnet inside it (subnet_cidr).
  EOT
  type        = string
  default     = "shared"

  validation {
    condition     = contains(["shared", "dedicated", "existing"], var.network_mode)
    error_message = "network_mode must be one of: shared, dedicated, existing."
  }
}

variable "network_ref" {
  description = <<-EOT
    Reference to the hcloud_network to deploy into, for network_mode =
    shared|existing. Resolved per network_lookup_by (name | id | label selector).
    Ignored for network_mode = dedicated (the network is created).
  EOT
  type        = string
  default     = ""
}

variable "network_lookup_by" {
  description = <<-EOT
    How to resolve network_ref for shared|existing:
      name — the hcloud_network name (default),
      id   — the numeric hcloud_network id,
      tag  — a Hetzner label selector (e.g. "veltrix-shared==true"), via
             the hcloud_network data source `with_selector`.
    ("tag" is kept for cross-cloud name parity with the AWS module, mapped to
    Hetzner's label selector — Hetzner networks carry labels, not tags.)
  EOT
  type        = string
  default     = "name"

  validation {
    condition     = contains(["name", "id", "tag"], var.network_lookup_by)
    error_message = "network_lookup_by must be one of: name, id, tag."
  }
}

variable "subnet_cidr" {
  description = <<-EOT
    Per-stack cloud subnet ip_range for network_mode = shared|existing (and, when
    set, for dedicated). Empty is allowed only when dedicated (the whole vpc_cidr
    is then used as a single subnet).
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.subnet_cidr == "" || can(cidrhost(var.subnet_cidr, 0))
    error_message = "subnet_cidr must be empty or a valid IPv4 CIDR, e.g. 10.20.16.0/24."
  }
}

variable "vpc_cidr" {
  description = <<-EOT
    ip_range for the hcloud_network CREATED when network_mode = dedicated (BYOC).
    A single cloud subnet is carved from it (subnet_cidr, or the whole range).
    Ignored otherwise. Named `vpc_cidr` for cross-cloud contract parity.
  EOT
  type        = string
  default     = "10.60.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR, e.g. 10.60.0.0/16."
  }
}

variable "admin_cidr" {
  description = "CIDR allowed to reach management ports + the web UI when there is no LB. Typically the Veltrix control-plane / customer bastion range."
  type        = string
  default     = "10.0.0.0/8"
}

# --- The plan (topology) --------------------------------------------------

variable "plan" {
  description = <<-EOT
    Ordered resource plan from the app topology. One object per resource the
    environment needs. `plan_key` is the stable key that maps 1:1 to a
    `splunk_byol_resource` row; the CI apply emits resource.status per plan_key.
  EOT
  type = list(object({
    plan_key = string
    tier     = string # foundation | control-plane | data | search | ingest
    kind     = string # network | storage | indexer | search-head | management-node | ...
    name     = optional(string, "")
    role     = optional(string, "")
    region   = optional(string, null)
    # Accepted for cross-cloud plan-shape parity. Hetzner has no in-location AZs,
    # so `zone` is unused here (multi-site uses locations via region granularity);
    # `roles` carries a consolidated control-plane node's role set for bring-up.
    zone  = optional(string, null)
    roles = optional(list(string), [])
  }))

  validation {
    condition     = length(var.plan) > 0
    error_message = "plan must contain at least one item."
  }
}

# --- Per-tier compute sizing ----------------------------------------------
# Mirrors the AWS instance_types / instance_types_by_kind / default_instance_type
# trio, keyed the same way. Hetzner has no separately-sized root disk: a server
# type fixes its own root disk, so there is no `root_volume_gb` equivalent
# (extra capacity is a block volume — see storage_volume_gb).

variable "server_types" {
  description = <<-EOT
    Per-tier hcloud server_type override, keyed by tier
    (foundation|control-plane|data|search|ingest). Missing tiers fall back to
    default_server_type. Kind-level overrides go in server_types_by_kind.
  EOT
  type        = map(string)
  default     = {}
}

variable "server_types_by_kind" {
  description = "Per-kind hcloud server_type override (wins over server_types). e.g. { indexer = \"ccx33\" }."
  type        = map(string)
  default     = {}
}

variable "default_server_type" {
  description = "Fallback hcloud server_type for any compute plan item with no tier/kind override (e.g. cx22, cpx31, ccx23)."
  type        = string
  default     = "cx22"
}

variable "storage_volume_gb" {
  description = "Size (GiB) of the hcloud_volume created per `storage` plan item. Min 10. See the object-storage gap note in main.tf."
  type        = number
  default     = 100
}

# --- Machine image / access -----------------------------------------------

variable "image" {
  description = <<-EOT
    hcloud image for compute nodes — a system image name (e.g. ubuntu-22.04,
    debian-12) or a snapshot id. Defaults to ubuntu-22.04 (scaffold only);
    production SHOULD supply a hardened, tool-preinstalled snapshot id.
  EOT
  type        = string
  default     = "ubuntu-22.04"
}

variable "ssh_keys" {
  description = "Optional list of hcloud SSH key names or ids to inject for break-glass access. Empty = none."
  type        = list(string)
  default     = []
}

# --- Foundation options ----------------------------------------------------

variable "dns_domain" {
  description = "Base domain for the environment (e.g. <cust>-<env>.veltrixsecops.com, or a customer domain in BYOC). Drives per-node FQDNs (emitted as output). Required only if the plan includes a dns item."
  type        = string
  default     = ""
}

variable "dns_mode" {
  description = <<-EOT
    How the PUBLIC (analyst-facing) DNS name + TLS cert are handled. NOTE: on
    Hetzner this module creates NO DNS records in any mode — the hcloud provider
    has no managed-DNS resource (Hetzner DNS is the separate `timohirt/hetznerdns`
    provider). The variable is kept for cross-cloud contract parity; per-node
    FQDNs are emitted as `node_fqdns` for the out-of-band bring-up layer.
      managed      — public name + cert handled out-of-band; the LB serves HTTPS
                     using certificate_arn when provided.
      delegated    — the worker manages the public record cross-account; the LB
                     uses certificate_arn on its HTTPS service.
      private-only — no public DNS; reached via the customer network (ZTNA/VPN).
  EOT
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "delegated", "private-only"], var.dns_mode)
    error_message = "dns_mode must be one of: managed, delegated, private-only."
  }
}

variable "certificate_arn" {
  description = <<-EOT
    hcloud Certificate id for the LB's HTTPS service (an UPLOADED or MANAGED
    hcloud_certificate provisioned out-of-band — a managed cert needs Hetzner
    DNS, which this module does not touch). Must be numeric (the hcloud cert id).
    Empty => the LB serves plain HTTP on the listener port (documented). Named
    `certificate_arn` for cross-cloud contract parity; it is NOT an AWS ARN.
  EOT
  type        = string
  default     = ""
}

variable "create_private_zone" {
  description = <<-EOT
    Cross-cloud parity flag. On AWS this creates a Route53 PRIVATE zone for
    per-node FQDNs. Hetzner has no in-provider DNS, so this is a DOCUMENTED
    NO-OP: no zone/record is created. Per-node FQDNs are still emitted as
    `node_fqdns` for the bring-up layer (hetznerdns provider or /etc/hosts).
  EOT
  type        = bool
  default     = false
}

variable "private_zone_id" {
  description = <<-EOT
    Cross-cloud parity input. On AWS this is an existing Route53 private zone id.
    Hetzner has no in-provider DNS, so it is UNUSED here (documented no-op); kept
    so the worker can pass a uniform variable set across clouds.
  EOT
  type        = string
  default     = ""
}

# --- Declarative infra spec (rendered from the app's InfraSpec) -----------
# These are BYTE-IDENTICAL to the AWS module (same names, types, defaults,
# validations) so `renderInfraVars` (sdk/src/opentofu/render.ts) feeds every
# cloud module unchanged. NOTHING below is Splunk-specific or cloud-specific.

variable "foundation_kinds" {
  description = <<-EOT
    Plan `kind`s the module realizes as shared FOUNDATION infra (not compute).
    Any plan item whose kind is NOT in this set (and not named by compute_kinds)
    is a compute node. Kept in sync with FOUNDATION_KINDS in spec.ts.
  EOT
  type        = list(string)
  default = [
    "network", "storage", "secrets", "tls",
    "load-balancer", "dns", "license-file", "hec",
  ]
}

variable "compute_kinds" {
  description = <<-EOT
    Optional explicit allow-list of compute kinds. When non-empty, ONLY these
    kinds become compute nodes. When empty (default), compute = any plan item
    whose kind is not in foundation_kinds (so an app's roles are compute
    automatically).
  EOT
  type        = list(string)
  default     = []
}

variable "security_rules" {
  description = <<-EOT
    SG ingress rules from the app's InfraSpec. Each rule opens `port` to one or
    more `sources`: "self" (peer nodes — the node SG referencing itself),
    "alb" (the public ALB SG; ignored when there is no load balancer), or
    "admin" (var.admin_cidr). Replaces any hardcoded, tool-specific port list.
  EOT
  type = list(object({
    port        = number
    protocol    = optional(string, "tcp")
    sources     = list(string)
    description = optional(string, "")
  }))
  default = []

  validation {
    condition = alltrue([
      for r in var.security_rules : alltrue([
        for s in r.sources : contains(["self", "alb", "admin"], s)
      ])
    ])
    error_message = "Every security_rules[*].sources entry must be one of: self, alb, admin."
  }
}

variable "load_balancer" {
  description = <<-EOT
    Front-door ALB spec from the app's InfraSpec. Null for headless / forwarder-
    only tools. When set (and the plan carries a load-balancer item), the module
    builds the target group + health check + listeners from this. `target_kinds`
    are the compute kinds that sit behind the ALB.
  EOT
  type = object({
    target_port           = number
    target_protocol       = optional(string, "HTTP")
    health_check_path     = string
    health_check_matcher  = optional(string, "200-399")
    health_check_protocol = optional(string, "")
    target_kinds          = list(string)
    listener_port         = optional(number, 443)
  })
  default = null
}

variable "dns_prefixes" {
  description = <<-EOT
    kind -> DNS label prefix for per-node function FQDNs (e.g.
    { indexer = "idx", search-head = "sh", cluster-manager = "mgmt" }). A compute
    kind absent from the map falls back to the kind string itself.
  EOT
  type        = map(string)
  default     = {}
}

variable "waf_enabled" {
  description = "Attach a WAFv2 web ACL (managed rules + IP rate limit) to the ALB. Ignored when there is no load balancer."
  type        = bool
  default     = true
}

variable "alb_auth" {
  description = <<-EOT
    Optional OIDC/Cognito MFA enforced at the ALB, in front of Splunk Web. When
    enabled, the HTTPS listener authenticates against the given Cognito user pool
    BEFORE forwarding to the search target group. Leave disabled (default) for a
    v1 public ALB + WAF posture without ALB-level auth. When enabled, all three
    user_pool_* fields are required.
  EOT
  type = object({
    enabled             = optional(bool, false)
    user_pool_arn       = optional(string, "")
    user_pool_client_id = optional(string, "")
    user_pool_domain    = optional(string, "")
  })
  default = {}

  validation {
    condition = !var.alb_auth.enabled || (
      var.alb_auth.user_pool_arn != "" &&
      var.alb_auth.user_pool_client_id != "" &&
      var.alb_auth.user_pool_domain != ""
    )
    error_message = "When alb_auth.enabled is true, user_pool_arn, user_pool_client_id and user_pool_domain are all required."
  }
}

# --- Tags -> Hetzner labels (threaded onto every labelable resource) -------

variable "tags" {
  description = <<-EOT
    Canonical Veltrix tag set. On Hetzner these are SANITIZED into labels
    (colons and other invalid characters replaced with "_", truncated to 63)
    because hcloud labels use a restricted charset. The OIDC/token apply
    identity is scoped by Veltrix:ManagedBy = Veltrix, so this map MUST include
    it (it becomes the Veltrix_ManagedBy label).
  EOT
  type        = map(string)
}
