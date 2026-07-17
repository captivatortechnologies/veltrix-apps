# =============================================================================
# AWS environment module — input variables.
#
# One BYOL environment (a "stack") = one dedicated /24 subnet carved from the
# shared Veltrix Network (VPC), plus one compute resource per plan item and the
# storage / secrets / TLS / LB / DNS a Splunk tier needs. The shared VPC is
# Veltrix-owned and is looked up (data source), NEVER created here.
#
# The `plan` list is the SAME topology the app persists as `splunk_byol_resource`
# rows (see apps/splunk-enterprise/lib/byolTopology.ts). Keying compute by
# `plan_key` is the contract that lets the CI apply report `resource.status`
# back per row (see outputs.tf + ci/emit-status.mjs).
# =============================================================================

# --- Identity / naming / tenancy ------------------------------------------

variable "app_id" {
  description = "Owning app id, e.g. splunk-enterprise. Used for naming + state key."
  type        = string
}

variable "customer_id" {
  description = "Tenant (customer) id. Used for naming + tag Veltrix:Customer."
  type        = string
}

variable "infrastructure_id" {
  description = "BYOL infrastructure (environment/stack) id. Unique per stack."
  type        = string
}

variable "provider_code" {
  description = "Cloud provider code (informational; this module is AWS). One of aws|azure|gcp|hetzner."
  type        = string
  default     = "aws"
}

variable "region" {
  description = "AWS region to deploy into, e.g. us-east-1."
  type        = string
}

# --- Network (mode: hosted-shared vs BYOC dedicated/existing) --------------
# network_mode is a DEPLOYMENT-TARGET var set by the worker per environment — it
# is NOT part of the app's InfraSpec (which describes only the tool). One app
# spec deploys hosted OR into a customer's own account, any cloud.

variable "network_mode" {
  description = <<-EOT
    How the environment's network is sourced:
      shared    — Veltrix-hosted: data-source the shared VPC (network_ref) and
                  create the IPAM-allocated per-stack subnet (subnet_cidr).
      dedicated — BYOC: CREATE a fresh VPC (vpc_cidr) + public/private subnets
                  across 2 AZs + internet gateway + NAT, isolated per env.
      existing  — BYOC: data-source a customer-designated VPC (network_ref) and
                  create subnets inside it (subnet_cidr).
  EOT
  type    = string
  default = "shared"

  validation {
    condition     = contains(["shared", "dedicated", "existing"], var.network_mode)
    error_message = "network_mode must be one of: shared, dedicated, existing."
  }
}

variable "network_ref" {
  description = <<-EOT
    Reference to the VPC to deploy into, for network_mode = shared|existing.
    Matched against the VPC's `Name` tag by default (a Veltrix-managed name such
    as `vpc-veltrix-use1-shared`, or a customer VPC name); pass a vpc-id and set
    network_lookup_by = "id" to resolve by id. Ignored for network_mode =
    dedicated (the VPC is created).
  EOT
  type        = string
  default     = ""
}

variable "network_lookup_by" {
  description = "How to resolve network_ref: `tag` (Name tag) or `id` (vpc-xxxx). Used for shared|existing."
  type        = string
  default     = "tag"

  validation {
    condition     = contains(["tag", "id"], var.network_lookup_by)
    error_message = "network_lookup_by must be either \"tag\" or \"id\"."
  }
}

variable "subnet_cidr" {
  description = <<-EOT
    Per-stack subnet CIDR for network_mode = shared|existing (IPAM-allocated for
    hosted). Ignored for dedicated (subnets are carved from vpc_cidr). Empty is
    allowed only when dedicated.
  EOT
  type    = string
  default = ""

  validation {
    condition     = var.subnet_cidr == "" || can(cidrhost(var.subnet_cidr, 0))
    error_message = "subnet_cidr must be empty or a valid IPv4 CIDR, e.g. 10.20.16.0/24."
  }
}

variable "vpc_cidr" {
  description = <<-EOT
    CIDR for the VPC CREATED when network_mode = dedicated (BYOC). Public and
    private /20 subnets are carved from it across 2 AZs. Ignored otherwise.
  EOT
  type    = string
  default = "10.60.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR, e.g. 10.60.0.0/16."
  }
}

variable "admin_cidr" {
  description = "CIDR allowed to reach management ports + the web UI when there is no ALB. Typically the Veltrix control-plane / customer bastion range."
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
    kind     = string # network | storage | indexer | search-head | ... (see byolTopology.ts)
    name     = optional(string, "")
    role     = optional(string, "")
    region   = optional(string, null)
  }))

  validation {
    condition     = length(var.plan) > 0
    error_message = "plan must contain at least one item."
  }
}

# --- Per-tier compute sizing ----------------------------------------------

variable "instance_types" {
  description = <<-EOT
    Per-tier EC2 instance type override, keyed by tier
    (foundation|control-plane|data|search|ingest). Missing tiers fall back to
    default_instance_type. Kind-level overrides go in instance_types_by_kind.
  EOT
  type    = map(string)
  default = {}
}

variable "instance_types_by_kind" {
  description = "Per-kind EC2 instance type override (wins over instance_types). e.g. { indexer = \"m6i.2xlarge\" }."
  type        = map(string)
  default     = {}
}

variable "default_instance_type" {
  description = "Fallback EC2 instance type for any compute plan item with no tier/kind override."
  type        = string
  default     = "t2.medium"
}

variable "root_volume_gb" {
  description = "Root EBS volume size (GiB) for each compute node."
  type        = number
  default     = 100
}

# --- Machine image / access -----------------------------------------------

variable "ami_id" {
  description = <<-EOT
    AMI for Splunk compute nodes. If empty, the module falls back to the latest
    Amazon Linux 2023 image (scaffold only) — production MUST supply a hardened,
    Splunk-preinstalled AMI id per region.
  EOT
  type    = string
  default = ""
}

variable "key_name" {
  description = "Optional EC2 key pair name for SSH break-glass access. Empty = none."
  type        = string
  default     = ""
}

# --- Foundation options ----------------------------------------------------

variable "dns_domain" {
  description = "Base domain for the environment (e.g. <cust>-<env>.veltrixsecops.com, or a customer domain in BYOC). Required only if the plan includes a dns item."
  type        = string
  default     = ""
}

variable "dns_mode" {
  description = <<-EOT
    How the PUBLIC (analyst-facing) DNS name + TLS cert are handled. The PRIVATE
    intra-cluster zone is always created in the deploy account's VPC regardless.
      managed      — the module creates the public A/alias record + ACM cert in
                     route53_zone_id (works for hosted on the Veltrix zone AND
                     BYOC customer-owned zone — both live in the deploy account).
      delegated    — BYOC cross-account: the WORKER writes the public record +
                     ACM-validation record into Veltrix's zone; the module makes
                     NO public record/cert and uses certificate_arn on the
                     listener instead.
      private-only — no public DNS; reached via the customer network (ZTNA/VPN).
  EOT
  type    = string
  default = "managed"

  validation {
    condition     = contains(["managed", "delegated", "private-only"], var.dns_mode)
    error_message = "dns_mode must be one of: managed, delegated, private-only."
  }
}

variable "route53_zone_id" {
  description = "Route53 hosted zone id for the PUBLIC record, when dns_mode = managed. The zone must be in the DEPLOY account (Veltrix's for hosted, the customer's for BYOC customer-owned)."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = <<-EOT
    Pre-validated ACM certificate ARN for the HTTPS listener, used when
    dns_mode = delegated (the worker provisions + cross-account-validates the
    cert). Empty otherwise (the module issues its own ACM cert in dns_mode =
    managed).
  EOT
  type    = string
  default = ""
}

variable "extra_lb_subnet_ids" {
  description = <<-EOT
    Additional subnet ids (in OTHER AZs) for the ALB, which needs >= 2 subnets
    across >= 2 AZs. Used for network_mode = shared|existing where the per-stack
    subnet is single-AZ. Ignored for dedicated (the module creates multi-AZ
    public subnets itself). Required for a load-balancer in shared|existing.
  EOT
  type    = list(string)
  default = []
}

variable "web_ingress_cidr" {
  description = <<-EOT
    CIDR allowed to reach the PUBLIC ALB on 443/80 (Splunk Web). Defaults to
    0.0.0.0/0 because the v1 posture is a public ALB fronted by WAF + optional
    Cognito MFA. Narrow this to an office/VPN range to restrict access.
  EOT
  type    = string
  default = "0.0.0.0/0"
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

variable "create_private_zone" {
  description = <<-EOT
    Create a Route53 PRIVATE hosted zone for dns_domain, associated with the
    shared VPC, to hold per-node function FQDNs (idx1.<domain>, sh1.<domain>, ...).
    Ignored when dns_domain is empty. Mutually complementary with
    private_zone_id: set private_zone_id instead to reuse an existing zone.
  EOT
  type    = bool
  default = false
}

variable "private_zone_id" {
  description = <<-EOT
    Existing Route53 private hosted zone id to publish per-node function FQDNs
    into. Takes precedence over create_private_zone when non-empty. Leave empty
    (and set create_private_zone) to have the module create the zone.
  EOT
  type    = string
  default = ""
}

# --- Declarative infra spec (rendered from the app's InfraSpec) -----------
# These are what make the module tool-agnostic. The app declares its ports /
# front-door / DNS as DATA (sdk/src/opentofu/spec.ts InfraSpec) and the SDK
# renders them here. NOTHING below is Splunk-specific.

variable "foundation_kinds" {
  description = <<-EOT
    Plan `kind`s the module realizes as shared FOUNDATION infra (not compute).
    Any plan item whose kind is NOT in this set (and not named by compute_kinds)
    is a compute node. Kept in sync with FOUNDATION_KINDS in spec.ts.
  EOT
  type = list(string)
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
  type    = list(string)
  default = []
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
  type    = map(string)
  default = {}
}

variable "waf_enabled" {
  description = "Attach a WAFv2 web ACL (managed rules + IP rate limit) to the ALB. Ignored when there is no load balancer."
  type        = bool
  default     = true
}

# --- Tags (threaded onto every resource) ----------------------------------

variable "tags" {
  description = <<-EOT
    Canonical Veltrix tag set applied to every resource
    (Veltrix:Customer, Veltrix:Environment, Veltrix:App, Veltrix:ManagedBy,
    CostCenter, Owner, ...). The OIDC apply role is scoped by
    Veltrix:ManagedBy = Veltrix, so this map MUST include it.
  EOT
  type    = map(string)
}
