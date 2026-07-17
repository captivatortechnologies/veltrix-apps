# =============================================================================
# Azure environment module — input variables.
#
# One BYOL environment (a "stack") = one dedicated subnet carved from a Veltrix
# or customer VNet, plus one compute VM per plan item and the storage / secrets /
# TLS / LB / DNS a tool tier needs. The shared VNet is looked up (data source),
# NEVER created here; a dedicated (BYOC) VNet IS created.
#
# The `plan` list is the SAME topology the app persists as its BYOL resource
# rows. Keying compute by `plan_key` is the contract that lets the CI apply
# report `resource.status` back per row (see outputs.tf).
#
# This file mirrors sdk/opentofu/modules/aws/variables.tf 1:1. The SPEC-DERIVED
# block (foundation_kinds, compute_kinds, security_rules, load_balancer,
# dns_prefixes, waf_enabled, alb_auth) is byte-identical across all clouds — it
# is what `renderInfraVars` emits. The DEPLOYMENT vars keep the same names as AWS
# and adapt only the Azure specifics (AMI -> image, instance types -> vm sizes,
# route53 -> Azure DNS zone, ACM arn -> Key Vault cert id).
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
  description = "Cloud provider code (informational; this module is Azure). One of aws|azure|gcp|hetzner."
  type        = string
  default     = "azure"
}

variable "region" {
  description = "Azure location to deploy into, e.g. eastus. (Named `region` for cross-cloud contract parity.)"
  type        = string
}

# --- Network (mode: hosted-shared vs BYOC dedicated/existing) --------------
# network_mode is a DEPLOYMENT-TARGET var set by the worker per environment — it
# is NOT part of the app's InfraSpec (which describes only the tool). One app
# spec deploys hosted OR into a customer's own account, any cloud.

variable "network_mode" {
  description = <<-EOT
    How the environment's network is sourced:
      shared    — Veltrix-hosted: data-source the shared VNet (network_ref in
                  network_resource_group) and create the allocated per-stack
                  subnet (subnet_cidr).
      dedicated — BYOC: CREATE a fresh VNet (vpc_cidr) + an App Gateway subnet +
                  a private compute subnet + a NAT gateway for private egress,
                  isolated per env.
      existing  — BYOC: data-source a customer-designated VNet (network_ref in
                  network_resource_group) and create subnets inside it.
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
    Name of the VNet to deploy into, for network_mode = shared|existing (a
    Veltrix-managed name such as `vnet-veltrix-eastus-shared`, or a customer VNet
    name). Resolved together with network_resource_group. Ignored for
    network_mode = dedicated (the VNet is created).
  EOT
  type        = string
  default     = ""
}

variable "network_lookup_by" {
  description = <<-EOT
    Contract parity with the other clouds. Azure resolves the VNet by NAME
    (network_ref) + resource group (network_resource_group) via the
    azurerm_virtual_network data source — there is no by-id VNet data source — so
    "id" is accepted but treated the same as "name". Kept for uniform tfvars.
  EOT
  type        = string
  default     = "name"

  validation {
    condition     = contains(["name", "id", "tag"], var.network_lookup_by)
    error_message = "network_lookup_by must be one of: name, id, tag (Azure resolves by name+resource group regardless)."
  }
}

variable "network_resource_group" {
  description = "Resource group holding the existing VNet (network_ref), for network_mode = shared|existing. The per-stack subnet is created into this RG (subnets belong to their VNet's RG). Ignored for dedicated."
  type        = string
  default     = ""
}

variable "subnet_cidr" {
  description = <<-EOT
    Per-stack compute subnet CIDR for network_mode = shared|existing
    (IPAM-allocated for hosted). Ignored for dedicated (subnets are carved from
    vpc_cidr). Empty is allowed only when dedicated.
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
    Address space for the VNet CREATED when network_mode = dedicated (BYOC). An
    App Gateway /20 (index 0) and a private compute /20 (index 1) are carved from
    it. Named `vpc_cidr` for cross-cloud contract parity. Ignored otherwise.
  EOT
  type        = string
  default     = "10.60.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a valid IPv4 CIDR, e.g. 10.60.0.0/16."
  }
}

variable "appgw_subnet_cidr" {
  description = <<-EOT
    Dedicated subnet CIDR for the Application Gateway when network_mode =
    shared|existing (an Azure Application Gateway REQUIRES its own empty subnet —
    it cannot share the compute subnet). This is the Azure analogue of the AWS
    module's extra_lb_subnet_ids. Required for a load-balancer in shared|existing;
    ignored for dedicated (the module carves the App Gateway subnet from vpc_cidr).
  EOT
  type        = string
  default     = ""

  validation {
    condition     = var.appgw_subnet_cidr == "" || can(cidrhost(var.appgw_subnet_cidr, 0))
    error_message = "appgw_subnet_cidr must be empty or a valid IPv4 CIDR, e.g. 10.20.17.0/26."
  }
}

variable "admin_cidr" {
  description = "CIDR allowed to reach management ports + the web UI when there is no load balancer. Typically the Veltrix control-plane / customer bastion range."
  type        = string
  default     = "10.0.0.0/8"
}

# --- The plan (topology) --------------------------------------------------

variable "plan" {
  description = <<-EOT
    Ordered resource plan from the app topology. One object per resource the
    environment needs. `plan_key` is the stable key that maps 1:1 to a BYOL
    resource row; the CI apply emits resource.status per plan_key.
  EOT
  type = list(object({
    plan_key = string
    tier     = string # foundation | control-plane | data | search | ingest
    kind     = string # network | storage | indexer | search-head | management-node | ...
    name     = optional(string, "")
    role     = optional(string, "")
    region   = optional(string, null)
    # Multi-AZ placement: the Azure availability zone ("1"|"2"|"3") this node is
    # pinned to (null = non-zonal). Azure subnets are regional; only the VM zone varies.
    zone  = optional(string, null)
    roles = optional(list(string), [])
  }))

  validation {
    condition     = length(var.plan) > 0
    error_message = "plan must contain at least one item."
  }
}

# --- Per-tier compute sizing (Azure VM sizes; mirrors AWS instance_types) ---

variable "vm_sizes" {
  description = <<-EOT
    Per-tier Azure VM size override, keyed by tier
    (foundation|control-plane|data|search|ingest). Missing tiers fall back to
    vm_size. Kind-level overrides go in vm_sizes_by_kind. (Mirrors AWS
    instance_types.)
  EOT
  type        = map(string)
  default     = {}
}

variable "vm_sizes_by_kind" {
  description = "Per-kind Azure VM size override (wins over vm_sizes). e.g. { indexer = \"Standard_D8s_v5\" }. (Mirrors AWS instance_types_by_kind.)"
  type        = map(string)
  default     = {}
}

variable "vm_size" {
  description = "Fallback Azure VM size for any compute plan item with no tier/kind override. (Mirrors AWS default_instance_type.)"
  type        = string
  default     = "Standard_B2s"
}

variable "os_disk_gb" {
  description = "OS managed-disk size (GiB) for each compute node. (Mirrors AWS root_volume_gb.)"
  type        = number
  default     = 100
}

# --- Machine image / access -----------------------------------------------

variable "image_ref" {
  description = <<-EOT
    Managed image / Shared Image Gallery version resource id for compute nodes.
    If empty, the module falls back to the latest Ubuntu 22.04 LTS marketplace
    image (scaffold only) — production MUST supply a hardened, tool-preinstalled
    image id. (Mirrors AWS ami_id.)
  EOT
  type        = string
  default     = ""
}

variable "admin_username" {
  description = "Admin username created on each compute VM. Azure disallows reserved names (admin, root, ...)."
  type        = string
  default     = "veltrixadmin"
}

variable "admin_ssh_public_key" {
  description = <<-EOT
    Optional OpenSSH public key for break-glass SSH access. When set, VMs use
    key-only auth (password auth disabled). When empty, the module generates a
    complex random password per apply and enables password auth (so a minimal
    plan still applies). (Mirrors AWS key_name.)
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
    intra-cluster zone is always created in the deploy account regardless.
      managed      — the module creates the public A record in public_dns_zone_name
                     (works for hosted on the Veltrix zone AND a BYOC customer-owned
                     zone — both live in the deploy subscription). See certificate_arn
                     for the TLS handling (Azure has no in-module public CA issuance).
      delegated    — BYOC cross-account: the WORKER writes the public record into
                     Veltrix's zone; the module makes NO public record and uses
                     certificate_arn on the App Gateway listener instead.
      private-only — no public DNS; reached via the customer network (ZTNA/VPN).
  EOT
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "delegated", "private-only"], var.dns_mode)
    error_message = "dns_mode must be one of: managed, delegated, private-only."
  }
}

variable "public_dns_zone_name" {
  description = <<-EOT
    Azure Public DNS zone NAME for the public record, when dns_mode = managed
    (e.g. `veltrixsecops.com`). The zone must live in the DEPLOY subscription
    (Veltrix's for hosted, the customer's for BYOC customer-owned). This holds the
    ROLE of AWS's route53_zone_id.
  EOT
  type        = string
  default     = ""
}

variable "public_dns_rg" {
  description = "Resource group of public_dns_zone_name. Required when dns_mode = managed and the plan carries a dns item."
  type        = string
  default     = ""
}

variable "certificate_arn" {
  description = <<-EOT
    Key Vault certificate/secret id for the App Gateway HTTPS listener
    (secret-identifier form, e.g.
    https://<vault>.vault.azure.net/secrets/<name>/<version>). Named
    `certificate_arn` for cross-cloud contract parity; on Azure it holds a Key
    Vault cert id, NOT an ACM ARN.

    Unlike AWS (which auto-issues a DNS-validated ACM cert in dns_mode = managed),
    Azure has NO in-module public CA issuance — the App Gateway consumes a Key
    Vault certificate that must be provisioned out-of-band. Therefore BOTH managed
    and delegated modes reference this var for the HTTPS listener. Pair it with
    appgw_identity_id (a user-assigned identity with GET access to that Key Vault).
    Empty => the App Gateway serves HTTP only (no HTTPS listener).
  EOT
  type        = string
  default     = ""
}

variable "appgw_identity_id" {
  description = <<-EOT
    Resource id of a user-assigned managed identity that has GET access to the Key
    Vault holding certificate_arn. Required for the HTTPS listener (App Gateway
    reads the KV cert through this identity). Provisioning the identity + KV access
    is a worker/caller responsibility (analogous to AWS's cross-account ACM
    validation in delegated mode). Empty => no HTTPS listener.
  EOT
  type        = string
  default     = ""
}

variable "web_ingress_cidr" {
  description = <<-EOT
    CIDR allowed to reach the PUBLIC App Gateway on 443/80. Declared for
    cross-cloud contract parity. NOTE: Azure Application Gateway v2 subnets require
    permissive GatewayManager/AzureLoadBalancer NSG rules, so source-IP restriction
    is best expressed as a WAF custom rule rather than a subnet NSG — that is a
    follow-on and is NOT wired here (the module does not narrow ingress by this var).
  EOT
  type        = string
  default     = "0.0.0.0/0"
}

variable "alb_auth" {
  description = <<-EOT
    Optional OIDC/Cognito-style MFA at the front door, in front of the tool's web
    UI. Shape kept byte-identical to AWS for uniform tfvars. NOTE: Azure
    Application Gateway has NO direct equivalent of AWS ALB authenticate-cognito;
    the Azure follow-on is Azure AD Application Proxy / Front Door + Entra ID. This
    var is ACCEPTED but NO-OP'd on Azure (documented gap) — see main.tf.
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
    Create an Azure Private DNS zone for dns_domain, linked to the deploy VNet, to
    hold per-node function FQDNs (idx1.<domain>, sh1.<domain>, ...). Ignored when
    dns_domain is empty. Mutually complementary with private_zone_id: set
    private_zone_id instead to reuse an existing zone.
  EOT
  type        = bool
  default     = false
}

variable "private_zone_id" {
  description = <<-EOT
    Set non-empty to REUSE an existing Private DNS zone (named dns_domain) instead
    of creating one; takes precedence over create_private_zone. Kept as
    `private_zone_id` for cross-cloud parity — on Azure the zone is addressed by
    NAME (dns_domain) + private_zone_resource_group, so this value is only used as
    the "reuse an existing zone" flag. Leave empty (and set create_private_zone) to
    have the module create the zone.
  EOT
  type        = string
  default     = ""
}

variable "private_zone_resource_group" {
  description = "Resource group of the existing Private DNS zone to reuse (when private_zone_id is set). Ignored when the module creates the zone (records go into the per-stack RG)."
  type        = string
  default     = ""
}

# --- Declarative infra spec (rendered from the app's InfraSpec) -----------
# These are what make the module tool-agnostic. The app declares its ports /
# front-door / DNS as DATA (sdk/src/opentofu/spec.ts InfraSpec) and the SDK
# renders them here. NOTHING below is Splunk-specific. This block is BYTE-IDENTICAL
# across the aws/azure/gcp/hetzner modules — it is exactly what renderInfraVars emits.

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
    Ingress rules from the app's InfraSpec. Each rule opens `port` to one or
    more `sources`: "self" (peer nodes — the node ASG referencing itself),
    "alb" (the front-door / App Gateway subnet; ignored when there is no load
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
    Front-door spec from the app's InfraSpec. Null for headless / forwarder-only
    tools. When set (and the plan carries a load-balancer item), the module builds
    the App Gateway backend pool + health probe + listeners from this.
    `target_kinds` are the compute kinds that sit behind the front door.
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
  description = "Attach a WAF policy (OWASP managed rules) to the App Gateway (WAF_v2 SKU). Ignored when there is no load balancer."
  type        = bool
  default     = true
}

# --- Tags (threaded onto every taggable resource) --------------------------

variable "tags" {
  description = <<-EOT
    Canonical Veltrix tag set applied to every taggable resource
    (Veltrix:Customer, Veltrix:Environment, Veltrix:App, Veltrix:ManagedBy,
    CostCenter, Owner, ...). The apply identity is scoped by
    Veltrix:ManagedBy = Veltrix, so this map MUST include it. NOTE: Azure subnets,
    NSG rules, storage containers, and NIC associations are not taggable and carry
    no tags.
  EOT
  type        = map(string)
}
