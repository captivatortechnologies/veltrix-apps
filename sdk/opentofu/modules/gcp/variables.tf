# =============================================================================
# GCP environment module — input variables.
#
# One BYOL environment (a "stack") = one dedicated /24 subnetwork carved from the
# shared Veltrix Network (VPC), plus one Compute Engine instance per plan item and
# the storage / secrets / TLS / LB / DNS a tool tier needs. The shared network is
# Veltrix-owned and is looked up (data source), NEVER created here.
#
# This is a faithful translation of sdk/opentofu/modules/aws: it honors the SAME
# variable + output contract. Spec-derived variables (foundation_kinds,
# compute_kinds, security_rules, load_balancer, dns_prefixes, waf_enabled,
# alb_auth) are byte-identical to AWS — they come from the app's InfraSpec via
# renderInfraVars and MUST match across clouds. Deployment variables keep the same
# NAMES as AWS; GCP specifics (project/zone/image/machine-type) are added.
#
# The `plan` list is the SAME topology the app persists as `splunk_byol_resource`
# rows. Keying compute by `plan_key` is the contract that lets the CI apply report
# `resource.status` back per row (see outputs.tf + ci/emit-status.mjs).
# =============================================================================

# --- Identity / naming / tenancy ------------------------------------------

variable "app_id" {
  description = "Owning app id, e.g. splunk-enterprise. Used for naming + state key."
  type        = string
}

variable "customer_id" {
  description = "Tenant (customer) id. Used for naming + label veltrix_customer."
  type        = string
}

variable "infrastructure_id" {
  description = "BYOL infrastructure (environment/stack) id. Unique per stack."
  type        = string
}

variable "provider_code" {
  description = "Cloud provider code (informational; this module is GCP). One of aws|azure|gcp|hetzner."
  type        = string
  default     = "gcp"
}

# --- GCP placement --------------------------------------------------------

variable "project" {
  description = "GCP project id to deploy into. For BYOC this is the customer's project; for hosted it is the Veltrix project."
  type        = string
}

variable "region" {
  description = "GCP region for regional resources (subnetwork, router/NAT, bucket), e.g. us-central1."
  type        = string
}

variable "zone" {
  description = "GCP zone for zonal compute (instances + the LB instance group), e.g. us-central1-a. Must be within var.region."
  type        = string
}

# --- Network (mode: hosted-shared vs BYOC dedicated/existing) --------------
# network_mode is a DEPLOYMENT-TARGET var set by the worker per environment — it
# is NOT part of the app's InfraSpec (which describes only the tool). One app
# spec deploys hosted OR into a customer's own account, any cloud.

variable "network_mode" {
  description = <<-EOT
    How the environment's network is sourced:
      shared    — Veltrix-hosted: data-source the shared network (network_ref) and
                  create the IPAM-allocated per-stack subnetwork (subnet_cidr).
      dedicated — BYOC: CREATE a fresh custom-mode network (auto_create_subnetworks
                  = false) + a subnetwork (vpc_cidr) + Cloud Router + Cloud NAT for
                  private egress, isolated per env.
      existing  — BYOC: data-source a customer-designated network (network_ref) and
                  create a subnetwork inside it (subnet_cidr).
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
    Reference to the network to deploy into, for network_mode = shared|existing.
    GCP networks are identified by NAME (there is no tag-based lookup), so this is
    the network name (e.g. `vpc-veltrix-usc1-shared` or a customer network name).
    Ignored for network_mode = dedicated (the network is created).
  EOT
  type        = string
  default     = ""
}

variable "network_lookup_by" {
  description = <<-EOT
    How to resolve network_ref. Kept for cross-cloud contract parity with AWS;
    GCP has no tag-based network lookup, so both `tag` and `id` resolve
    network_ref as the network NAME. Used for shared|existing.
  EOT
  type        = string
  default     = "tag"

  validation {
    condition     = contains(["tag", "id"], var.network_lookup_by)
    error_message = "network_lookup_by must be either \"tag\" or \"id\"."
  }
}

variable "subnet_cidr" {
  description = <<-EOT
    Per-stack subnetwork CIDR for network_mode = shared|existing (IPAM-allocated
    for hosted). Ignored for dedicated (the subnetwork range is vpc_cidr). Empty is
    allowed only when dedicated.
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
    CIDR for the subnetwork of the network CREATED when network_mode = dedicated
    (BYOC). GCP custom-mode networks have no parent range; this whole CIDR becomes
    the stack's single regional subnetwork. Ignored otherwise.
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
    # Multi-AZ placement: the GCP zone (e.g. us-central1-b) this node is pinned to
    # (null = var.zone). GCP subnets are regional, so only the instance zone varies.
    zone  = optional(string, null)
    roles = optional(list(string), [])
  }))

  validation {
    condition     = length(var.plan) > 0
    error_message = "plan must contain at least one item."
  }
}

# --- Per-tier compute sizing ----------------------------------------------

variable "machine_types" {
  description = <<-EOT
    Per-tier Compute Engine machine type override, keyed by tier
    (foundation|control-plane|data|search|ingest). Missing tiers fall back to
    default_machine_type. Kind-level overrides go in machine_types_by_kind.
  EOT
  type        = map(string)
  default     = {}
}

variable "machine_types_by_kind" {
  description = "Per-kind machine type override (wins over machine_types). e.g. { indexer = \"n2-standard-8\" }."
  type        = map(string)
  default     = {}
}

variable "default_machine_type" {
  description = "Fallback machine type for any compute plan item with no tier/kind override."
  type        = string
  default     = "e2-medium"
}

variable "boot_disk_gb" {
  description = "Boot disk size (GiB) for each compute instance."
  type        = number
  default     = 100
}

# --- Machine image / access -----------------------------------------------

variable "image" {
  description = <<-EOT
    Boot image for compute instances — an image self-link, `project/family`, or
    image name. If empty, the module falls back to the latest Debian 12 image
    (scaffold only) — production MUST supply a hardened, tool-preinstalled image.
  EOT
  type        = string
  default     = ""
}

variable "ssh_public_key" {
  description = <<-EOT
    Optional SSH public key for break-glass access, in GCP metadata format
    `user:ssh-rsa AAAA... comment`. Empty = none (published to the instance's
    ssh-keys metadata when set).
  EOT
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
    intra-cluster zone is always created in the deploy account's network regardless.
      managed      — the module creates the public A record (→ the LB's global IP)
                     in public_dns_managed_zone + a Google-managed SSL cert (works
                     for hosted on the Veltrix zone AND a BYOC customer-owned zone —
                     both live in the deploy account).
      delegated    — BYOC cross-account: the WORKER writes the public record into
                     Veltrix's zone; the module makes NO public record/cert and uses
                     certificate_arn (a self-provided SSL cert self-link) on the
                     HTTPS proxy instead.
      private-only — no public DNS; reached via the customer network (ZTNA/VPN).
  EOT
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "delegated", "private-only"], var.dns_mode)
    error_message = "dns_mode must be one of: managed, delegated, private-only."
  }
}

variable "public_dns_managed_zone" {
  description = "Cloud DNS managed zone NAME for the PUBLIC record, when dns_mode = managed. The zone must be in the DEPLOY project (Veltrix's for hosted, the customer's for BYOC customer-owned)."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = <<-EOT
    Pre-provisioned SSL certificate reference for the HTTPS proxy, used when
    dns_mode = delegated (the worker provisions + validates the cert). On GCP this
    is a `google_compute_ssl_certificate` / managed-cert SELF-LINK (the name is
    kept as `certificate_arn` for cross-cloud contract uniformity). Empty otherwise
    (the module issues its own managed cert in dns_mode = managed).
  EOT
  type        = string
  default     = ""
}

variable "alb_auth" {
  description = <<-EOT
    Optional OIDC/MFA enforced at the front door, in front of the tool's web UI.
    The field shape is identical to AWS (Cognito) for cross-cloud contract parity.
    On GCP the analog is Identity-Aware Proxy (IAP); it is a larger lift and is
    DOCUMENTED AS A FOLLOW-ON — this module NO-OPS the variable (no IAP resources
    are created). When enabled, all three user_pool_* fields are required so the
    tfvars stay valid across clouds.
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
    Create a Cloud DNS PRIVATE managed zone for dns_domain, associated with the
    stack network, to hold per-node function FQDNs (idx1.<domain>, sh1.<domain>, ...).
    Ignored when dns_domain is empty. Mutually complementary with private_zone_id:
    set private_zone_id instead to reuse an existing zone.
  EOT
  type        = bool
  default     = false
}

variable "private_zone_id" {
  description = <<-EOT
    Existing Cloud DNS private managed zone NAME to publish per-node function FQDNs
    into. Takes precedence over create_private_zone when non-empty. Leave empty
    (and set create_private_zone) to have the module create the zone. Named
    private_zone_id for cross-cloud parity; on GCP it is the managed-zone name.
  EOT
  type        = string
  default     = ""
}

# --- Declarative infra spec (rendered from the app's InfraSpec) -----------
# These are what make the module tool-agnostic. The app declares its ports /
# front-door / DNS as DATA (sdk/src/opentofu/spec.ts InfraSpec) and the SDK
# renders them here. NOTHING below is Splunk-specific. This block is
# byte-identical to sdk/opentofu/modules/aws/variables.tf.

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
    Firewall ingress rules from the app's InfraSpec. Each rule opens `port` to one
    or more `sources`: "self" (peer nodes — the stack network tag referencing
    itself), "alb" (the front-door LB; on GCP this maps to Google's LB health-check
    + proxy ranges 130.211.0.0/22 and 35.191.0.0/16; ignored when there is no load
    balancer), or "admin" (var.admin_cidr). Replaces any hardcoded, tool-specific
    port list.
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
    Front-door LB spec from the app's InfraSpec. Null for headless / forwarder-
    only tools. When set (and the plan carries a load-balancer item), the module
    builds the health check + backend service + HTTPS proxy + forwarding rule from
    this. `target_kinds` are the compute kinds that sit behind the LB.
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
  description = "Attach a Cloud Armor security policy (OWASP preconfigured rules + IP rate limit) to the LB backend service. Ignored when there is no load balancer."
  type        = bool
  default     = true
}

# --- Labels (threaded onto every labelable resource) ----------------------

variable "tags" {
  description = <<-EOT
    Canonical Veltrix tag set. Named `tags` for cross-cloud contract parity, but on
    GCP these are SANITIZED into labels (lowercase [a-z0-9_-], key starts with a
    letter, <=63 chars) before being applied — the raw keys (Veltrix:Customer,
    CostCenter, ...) are invalid GCP label keys. Must include Veltrix:ManagedBy
    (the OIDC/WIF apply identity is scoped by veltrix_managedby = veltrix).
  EOT
  type        = map(string)
}
