# =============================================================================
# Azure environment module — generic, tool-agnostic. A faithful translation of
# sdk/opentofu/modules/aws. Driven by an app's rendered InfraSpec; NOTHING here
# is tool-specific.
#
# Network mode (worker-set deployment var, NOT app InfraSpec):
#   shared    — Veltrix-hosted: data-source the shared VNet + create the
#               allocated per-stack subnet.
#   dedicated — BYOC: CREATE a fresh VNet + App Gateway/private subnets + a NAT
#               gateway (private egress) in the customer's subscription.
#   existing  — BYOC: data-source a customer VNet + create subnets in it.
# DNS mode: managed (in-account public record; App Gateway consumes a Key Vault
#   cert) / delegated (worker does the cross-account public DNS; module uses
#   certificate_arn) / private-only.
#
# One compute VM per compute plan item (for_each keyed by plan_key) + storage /
# secrets / TLS / LB / DNS per topology tier. Isolation: per-stack subnet +
# NSG/ASG SG-to-SG. Cost/attribution: var.tags on every taggable resource.
#
# Azure <-> AWS primitive map: VNet=VPC, Subnet=Subnet, NSG+ASG=SG self-ref,
# App Gateway(+WAF policy)=ALB(+WAFv2), Private DNS zone=Route53 private zone,
# Storage Account=S3, Key Vault=Secrets Manager. See per-resource comments.
# =============================================================================

locals {
  # Short, DNS/label-safe prefix. infrastructure_id is a UUID; 8 chars is enough
  # to disambiguate within a customer while staying under Azure name limits.
  name_prefix = "${var.app_id}-${substr(var.infrastructure_id, 0, 8)}"

  # plan_key -> plan object, for compute nodes only. This map's keys ARE the
  # azurerm_linux_virtual_machine.node[...] addresses, so status maps 1:1 back to
  # resource rows. Tool-agnostic: an explicit compute_kinds allow-list wins;
  # otherwise compute = any plan item whose kind is NOT a generic foundation kind.
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
  has_dns          = length([for r in var.plan : r if r.kind == "dns"]) > 0 && var.public_dns_zone_name != ""
  has_hec          = length([for r in var.plan : r if r.kind == "hec"]) > 0

  # A single Key Vault backs both the secrets bundle and the BYOL license file.
  has_key_vault = local.has_secrets || local.has_license_file

  # A per-resource Name/plan_key is merged INTO the canonical tag set so every
  # object still carries var.tags (incl. Veltrix:ManagedBy) verbatim.
  base_tags = var.tags

  # --- Network mode: hosted-shared vs BYOC dedicated/existing -----------
  is_dedicated   = var.network_mode == "dedicated"
  lookup_network = var.network_mode == "shared" || var.network_mode == "existing"

  # SSH key vs generated-password auth for the VMs.
  use_ssh_key = var.admin_ssh_public_key != ""

  # Resolved network + subnet sets, uniform across all three modes:
  #   dedicated -> the created VNet + its private (compute) / appgw subnets
  #   shared/existing -> the looked-up VNet + the single allocated subnet
  # Azure subnets span the region (no per-AZ split like AWS), so each set is a
  # single subnet — but we keep them as lists to mirror the AWS locals exactly.
  network_id = local.is_dedicated ? azurerm_virtual_network.env[0].id : data.azurerm_virtual_network.shared[0].id

  compute_subnet_ids = local.is_dedicated ? [azurerm_subnet.private[0].id] : [azurerm_subnet.env[0].id]
  lb_subnet_id       = local.is_dedicated ? azurerm_subnet.appgw[0].id : one(azurerm_subnet.appgw_shared[*].id)

  # Compute nodes are spread round-robin across the available compute subnets
  # (a single subnet on Azure, so all land on it — the loop mirrors AWS 1:1).
  compute_subnet_for = {
    for idx, k in sort(keys(local.compute_nodes)) : k =>
    local.compute_subnet_ids[idx % length(local.compute_subnet_ids)]
  }

  # Plan-time-known CIDR of the App Gateway subnet, used as the "alb" source in
  # NSG rules (the AWS module references the ALB SG id; on Azure we reference the
  # gateway subnet prefix). dedicated -> carved from vpc_cidr; else the caller's
  # appgw_subnet_cidr. Never a computed id, so it is safe in a for_each/rule set.
  appgw_subnet_prefix = local.is_dedicated ? cidrsubnet(var.vpc_cidr, 4, 0) : var.appgw_subnet_cidr

  # --- DNS mode: managed (in-account) / delegated (worker x-account) / none
  dns_managed    = var.dns_mode == "managed"
  has_public_dns = var.dns_mode != "private-only"

  # The App Gateway listener consumes a Key Vault certificate. Azure has no
  # in-module public CA issuance (unlike AWS ACM), so BOTH managed and delegated
  # reference var.certificate_arn (a KV cert secret id) here.
  listener_cert_secret_id = var.certificate_arn

  # --- Derived front-door / listener gates ------------------------------
  # has_lb        = the plan carries a load-balancer item.
  # has_lb_spec   = has_lb AND the app supplied a load_balancer spec. Unlike AWS
  #   (which can create a bare aws_lb on has_lb alone), an Azure Application
  #   Gateway REQUIRES a full backend/probe/listener/rule config, so the gateway
  #   is gated on has_lb_spec.
  has_lb_spec = local.has_lb && var.load_balancer != null
  # HTTPS listener needs BOTH a KV cert id AND a user-assigned identity that can
  # read it. When either is missing the App Gateway serves HTTP only (so a
  # partial plan still applies) — this is the documented Azure divergence from
  # AWS's has_listener (AWS issues its own cert in managed mode).
  has_listener = local.has_lb_spec && var.dns_domain != "" && var.certificate_arn != "" && var.appgw_identity_id != ""
  # alb_auth (Cognito MFA) has NO Application Gateway equivalent — accepted but
  # no-op'd (see the App Gateway block). Kept for tfvars uniformity.
  alb_auth_enabled = var.alb_auth.enabled

  # Azure protocol enum is title-case ("Http"/"Https"); the spec is upper-case.
  # Guarded with a null check because locals are always evaluated (the App
  # Gateway that consumes them only exists when has_lb_spec).
  appgw_backend_protocol = var.load_balancer != null ? title(lower(var.load_balancer.target_protocol)) : "Http"
  appgw_probe_protocol = (var.load_balancer != null && try(var.load_balancer.health_check_protocol, "") != "") ? (
    title(lower(var.load_balancer.health_check_protocol))
  ) : local.appgw_backend_protocol

  # Compute nodes that sit behind the front door — the kinds the app named as LB
  # targets. try() keeps it null-safe when there is no spec.
  lb_target_kinds = try(var.load_balancer.target_kinds, [])
  search_targets = {
    for k, r in local.compute_nodes : k => r
    if contains(local.lb_target_kinds, r.kind)
  }

  # --- Per-node function DNS labels (reused verbatim from the AWS module) ----
  node_prefix = {
    for k, r in local.compute_nodes : k => lookup(var.dns_prefixes, r.kind, r.kind)
  }
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
  # Either create a private zone for var.dns_domain (create_private_zone) or point
  # at a caller-supplied one (private_zone_id != "" => reuse). want_private_dns is
  # the plan-time-known intent used to gate the per-node record for_each. On Azure
  # a private DNS record is addressed by zone NAME (= dns_domain) + resource group,
  # not a zone id — so private_zone_id acts only as the "reuse existing" flag.
  create_private_zone = var.create_private_zone && var.dns_domain != "" && var.private_zone_id == ""
  want_private_dns    = var.dns_domain != "" && (var.private_zone_id != "" || local.create_private_zone)
  private_zone_name   = var.dns_domain
  private_zone_rg     = local.create_private_zone ? azurerm_resource_group.env.name : var.private_zone_resource_group

  # Public managed record name relative to public_dns_zone_name ("@" for apex).
  public_record_name = var.dns_domain == var.public_dns_zone_name ? "@" : trimsuffix(var.dns_domain, ".${var.public_dns_zone_name}")

  # --- Flattened NSG ingress rules (from the app's security_rules) --------
  # Each (rule, source) pair becomes one azurerm_network_security_rule, keyed
  # "<port>-<protocol>-<source>". "alb"-sourced rules are dropped when there is no
  # load balancer (no gateway subnet to reference). This replaces any hardcoded,
  # tool-specific port list — the app declares its ports in InfraSpec.securityRules.
  sg_ingress = merge([
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

  # NSG rules need an ascending, unique priority. Derive it deterministically from
  # the lexically-sorted key set (plan-time-known) so every apply is stable.
  sg_ingress_keys  = sort(keys(local.sg_ingress))
  sg_rule_priority = { for i, k in local.sg_ingress_keys : k => 100 + i }

  # App Gateway sub-resource names (referenced across multiple blocks).
  appgw_frontend_ip_name    = "frontend-ip"
  appgw_http_port_name      = "port-http"
  appgw_https_port_name     = "port-https"
  appgw_backend_pool_name   = "node-pool"
  appgw_backend_http_name   = "node-http-settings"
  appgw_probe_name          = "node-probe"
  appgw_http_listener_name  = "http-listener"
  appgw_https_listener_name = "https-listener"
  appgw_ssl_cert_name       = "listener-cert"
  appgw_gateway_ip_name     = "gateway-ip-config"
  appgw_redirect_name       = "http-to-https"
}

# Current subscription/tenant/principal — for Key Vault tenant + access policy.
data "azurerm_client_config" "current" {}

# --- Per-stack resource group ---------------------------------------------
# Azure requires a resource group for every resource (AWS has no equivalent). We
# create ONE per stack so a stack's resources are grouped + destroyed together.
# In shared/existing mode the compute subnet still lands in the VNet's OWN RG
# (subnets belong to their VNet), so only that subnet lives outside this RG.
resource "azurerm_resource_group" "env" {
  name     = "${local.name_prefix}-rg"
  location = var.region

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-rg"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- Network lookup (network_mode = shared | existing) --------------------
# The VNet is data-sourced (never created) — the shared Veltrix VNet for hosted,
# or a customer-designated VNet for BYOC "existing". Absent when dedicated. Azure
# resolves a VNet by name + resource group (there is no by-id data source).
data "azurerm_virtual_network" "shared" {
  count               = local.lookup_network ? 1 : 0
  name                = var.network_ref
  resource_group_name = var.network_resource_group
}

# The stack's single allocated compute subnet, in the looked-up VNet
# (shared|existing). Created into the VNet's RG. Azure subnets are not taggable.
resource "azurerm_subnet" "env" {
  count                = local.lookup_network ? 1 : 0
  name                 = "${local.name_prefix}-subnet"
  resource_group_name  = data.azurerm_virtual_network.shared[0].resource_group_name
  virtual_network_name = data.azurerm_virtual_network.shared[0].name
  address_prefixes     = [var.subnet_cidr]
}

# Dedicated App Gateway subnet in shared/existing mode. An Application Gateway
# MUST have its own empty subnet, so we carve one from appgw_subnet_cidr whenever
# there is a load balancer (the Azure analogue of AWS extra_lb_subnet_ids).
resource "azurerm_subnet" "appgw_shared" {
  count                = local.lookup_network && local.has_lb ? 1 : 0
  name                 = "${local.name_prefix}-appgw-subnet"
  resource_group_name  = data.azurerm_virtual_network.shared[0].resource_group_name
  virtual_network_name = data.azurerm_virtual_network.shared[0].name
  address_prefixes     = [var.appgw_subnet_cidr]
}

# --- Dedicated network fabric (network_mode = dedicated / BYOC) ------------
# A fresh, isolated VNet created in the DEPLOY subscription (the customer's, for
# BYOC): one App Gateway subnet + one private compute subnet + a NAT gateway for
# private egress. Nothing here runs in shared/existing mode.
resource "azurerm_virtual_network" "env" {
  count               = local.is_dedicated ? 1 : 0
  name                = "${local.name_prefix}-vnet"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  address_space       = [var.vpc_cidr]

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-vnet"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# App Gateway subnet (dedicated) — cidrsubnet(/16, 4, 0) => first /20.
resource "azurerm_subnet" "appgw" {
  count                = local.is_dedicated ? 1 : 0
  name                 = "${local.name_prefix}-appgw-subnet"
  resource_group_name  = azurerm_resource_group.env.name
  virtual_network_name = azurerm_virtual_network.env[0].name
  address_prefixes     = [cidrsubnet(var.vpc_cidr, 4, 0)]
}

# Private compute subnet (dedicated) — cidrsubnet(/16, 4, 1) => second /20.
resource "azurerm_subnet" "private" {
  count                = local.is_dedicated ? 1 : 0
  name                 = "${local.name_prefix}-private-subnet"
  resource_group_name  = azurerm_resource_group.env.name
  virtual_network_name = azurerm_virtual_network.env[0].name
  address_prefixes     = [cidrsubnet(var.vpc_cidr, 4, 1)]
}

# NAT gateway for private-subnet egress (peers, object storage, license/updates).
resource "azurerm_public_ip" "nat" {
  count               = local.is_dedicated ? 1 : 0
  name                = "${local.name_prefix}-nat-pip"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-nat-pip"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "azurerm_nat_gateway" "env" {
  count               = local.is_dedicated ? 1 : 0
  name                = "${local.name_prefix}-nat"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  sku_name            = "Standard"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-nat"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "azurerm_nat_gateway_public_ip_association" "env" {
  count                = local.is_dedicated ? 1 : 0
  nat_gateway_id       = azurerm_nat_gateway.env[0].id
  public_ip_address_id = azurerm_public_ip.nat[0].id
}

# Route private-subnet egress through the NAT (the AWS private route table + NAT).
resource "azurerm_subnet_nat_gateway_association" "private" {
  count          = local.is_dedicated ? 1 : 0
  subnet_id      = azurerm_subnet.private[0].id
  nat_gateway_id = azurerm_nat_gateway.env[0].id
}

# --- Security: SG-to-SG least privilege (NSG + Application Security Group) -----
# The AWS module self-references the node SG; on Azure "self" is expressed with an
# Application Security Group (ASG). Every compute NIC joins the node ASG, and
# NSG rules for "self" use it as source + destination — scoping intra-cluster
# traffic to THIS stack's instances, not a whole CIDR. "alb" => the App Gateway
# subnet prefix; "admin" => var.admin_cidr.

resource "azurerm_application_security_group" "node" {
  name                = "${local.name_prefix}-node-asg"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-node-asg"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# Node NSG. Rules live in a single for_each'd standalone rule resource (below);
# do NOT add inline security_rule blocks here — mixing inline + standalone rules
# on one NSG makes them clobber each other (same caveat as the AWS module).
resource "azurerm_network_security_group" "node" {
  name                = "${local.name_prefix}-nsg"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-nsg"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# One inbound rule per (security_rules entry, source), from local.sg_ingress.
# Exactly one source form is set per rule (the others are null/omitted):
# "self" -> source ASG; "alb" -> the App Gateway subnet prefix; "admin" ->
# var.admin_cidr. Destination is always the node ASG. NSG rules are not taggable.
resource "azurerm_network_security_rule" "node" {
  for_each = local.sg_ingress

  name                        = "allow-${each.key}"
  priority                    = local.sg_rule_priority[each.key]
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = title(each.value.protocol)
  source_port_range           = "*"
  destination_port_range      = tostring(each.value.port)
  description                 = each.value.description
  resource_group_name         = azurerm_resource_group.env.name
  network_security_group_name = azurerm_network_security_group.node.name

  source_application_security_group_ids = each.value.source == "self" ? [azurerm_application_security_group.node.id] : null
  source_address_prefix = each.value.source == "admin" ? var.admin_cidr : (
    each.value.source == "alb" ? local.appgw_subnet_prefix : null
  )

  destination_application_security_group_ids = [azurerm_application_security_group.node.id]
}

# Egress: Azure NSGs carry default rules that already permit outbound to the VNet
# and the Internet (AllowVnetOutBound / AllowInternetOutBound), so no explicit
# all-egress rule is needed (the AWS module adds one because AWS SGs deny egress
# by default). Nodes can therefore reach peers, object storage, and updates.

# --- Compute: one Linux VM (+ NIC) per compute plan item ------------------
# for_each keyed by plan_key => azurerm_linux_virtual_machine.node["data/indexer-1"].
# Hostname = the node's function short-label (idx1, sh1, ...).

resource "azurerm_network_interface" "node" {
  for_each            = local.compute_nodes
  name                = "${local.name_prefix}-${local.node_short_labels[each.key]}-nic"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name

  ip_configuration {
    name                          = "internal"
    subnet_id                     = local.compute_subnet_for[each.key]
    private_ip_address_allocation = "Dynamic"
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-${local.node_short_labels[each.key]}-nic"
    "Veltrix:PlanKey" = each.key
    "Veltrix:Tier"    = each.value.tier
    "Veltrix:Kind"    = each.value.kind
    "Veltrix:Role"    = each.value.role
  })
}

# Attach the node NSG to each compute NIC (closest analogue of AWS's per-instance
# vpc_security_group_ids). Associations are not taggable.
resource "azurerm_network_interface_security_group_association" "node" {
  for_each                  = local.compute_nodes
  network_interface_id      = azurerm_network_interface.node[each.key].id
  network_security_group_id = azurerm_network_security_group.node.id
}

# Join each compute NIC to the node ASG so "self" NSG rules scope to this stack.
resource "azurerm_network_interface_application_security_group_association" "node" {
  for_each                      = local.compute_nodes
  network_interface_id          = azurerm_network_interface.node[each.key].id
  application_security_group_id = azurerm_application_security_group.node.id
}

# When no SSH key is supplied, generate a complexity-compliant password so a
# minimal plan still applies (Azure requires SSH key OR password on a Linux VM).
resource "random_password" "vm" {
  count            = !local.use_ssh_key && length(local.compute_nodes) > 0 ? 1 : 0
  length           = 24
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
  min_special      = 2
  override_special = "!@#$%*()-_"
}

resource "azurerm_linux_virtual_machine" "node" {
  for_each            = local.compute_nodes
  name                = "${local.name_prefix}-${local.node_short_labels[each.key]}"
  computer_name       = local.node_short_labels[each.key]
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  # Multi-AZ placement: pin to the node's availability zone when set (null = non-zonal).
  zone = each.value.zone
  size = coalesce(
    lookup(var.vm_sizes_by_kind, each.value.kind, null),
    lookup(var.vm_sizes, each.value.tier, null),
    var.vm_size,
  )
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.node[each.key].id]

  disable_password_authentication = local.use_ssh_key
  admin_password                  = local.use_ssh_key ? null : one(random_password.vm[*].result)

  dynamic "admin_ssh_key" {
    for_each = local.use_ssh_key ? [1] : []
    content {
      username   = var.admin_username
      public_key = var.admin_ssh_public_key
    }
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.os_disk_gb
  }

  # Custom image id when supplied; else the Ubuntu 22.04 LTS marketplace fallback
  # (scaffold only — production must pass a tool-preinstalled image_ref).
  source_image_id = var.image_ref != "" ? var.image_ref : null

  dynamic "source_image_reference" {
    for_each = var.image_ref == "" ? [1] : []
    content {
      publisher = "Canonical"
      offer     = "0001-com-ubuntu-server-jammy"
      sku       = "22_04-lts-gen2"
      version   = "latest"
    }
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-${local.node_short_labels[each.key]}"
    "Veltrix:PlanKey" = each.key
    "Veltrix:Tier"    = each.value.tier
    "Veltrix:Kind"    = each.value.kind
    "Veltrix:Role"    = each.value.role
  })
}

# --- Storage: object-storage account/container (SmartStore, warm/cold, etc.) --
# Generic private blob storage for the app's bulk/object storage. The tool's
# meaning is app-defined (InfraSpec.storage); the module just provisions it.
# Storage account names are globally unique, 3-24 chars, lowercase alphanumeric.
resource "random_string" "storage_suffix" {
  count   = local.has_storage ? 1 : 0
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_storage_account" "objstore" {
  count                           = local.has_storage ? 1 : 0
  name                            = "${substr("st${replace(lower(local.name_prefix), "/[^a-z0-9]/", "")}", 0, 18)}${random_string.storage_suffix[0].result}"
  resource_group_name             = azurerm_resource_group.env.name
  location                        = var.region
  account_tier                    = "Standard"
  account_replication_type        = "LRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-objstore"
    "Veltrix:PlanKey" = "foundation/storage"
    "Veltrix:Tier"    = "foundation"
  })
}

# Private container inside the account. Storage containers are not taggable.
resource "azurerm_storage_container" "objstore" {
  count                 = local.has_storage ? 1 : 0
  name                  = "objstore"
  storage_account_name  = azurerm_storage_account.objstore[0].name
  container_access_type = "private"
}

# --- Secrets + BYOL license: a per-tenant Key Vault ------------------------
# One Key Vault backs the secrets bundle (admin seed / pass4SymmKey / etc.) AND
# the BYOL license file (each a secret). Created when EITHER tier is in the plan.
# An access policy grants the apply principal secret data-plane permissions.
resource "random_string" "kv_suffix" {
  count   = local.has_key_vault ? 1 : 0
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_key_vault" "secrets" {
  count               = local.has_key_vault ? 1 : 0
  name                = "${substr("kv${replace(lower(local.name_prefix), "/[^a-z0-9]/", "")}", 0, 18)}${random_string.kv_suffix[0].result}"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  access_policy {
    tenant_id          = data.azurerm_client_config.current.tenant_id
    object_id          = data.azurerm_client_config.current.object_id
    secret_permissions = ["Get", "List", "Set", "Delete", "Purge", "Recover"]
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-kv"
    "Veltrix:PlanKey" = "foundation/secrets"
    "Veltrix:Tier"    = "foundation"
  })
}

# Seed secret for the secrets tier. Azure requires a value (AWS leaves the secret
# container empty), so we generate a real random seed; bring-up overwrites it,
# and ignore_changes keeps that rotation from showing as drift.
resource "random_password" "secret_seed" {
  count            = local.has_secrets ? 1 : 0
  length           = 32
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
  min_special      = 2
  override_special = "!@#$%*()-_"
}

resource "azurerm_key_vault_secret" "env" {
  count        = local.has_secrets ? 1 : 0
  name         = "env-secrets"
  value        = random_password.secret_seed[0].result
  key_vault_id = azurerm_key_vault.secrets[0].id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-secrets"
    "Veltrix:PlanKey" = "foundation/secrets"
    "Veltrix:Tier"    = "foundation"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

# BYOL license file (stored as a secret; the real content is uploaded post-apply).
resource "azurerm_key_vault_secret" "license" {
  count        = local.has_license_file ? 1 : 0
  name         = "byol-license"
  value        = "REPLACE_WITH_LICENSE"
  key_vault_id = azurerm_key_vault.secrets[0].id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-license"
    "Veltrix:PlanKey" = "foundation/license-file"
    "Veltrix:Tier"    = "foundation"
  })

  lifecycle {
    ignore_changes = [value]
  }
}

# --- TLS certificate note --------------------------------------------------
# Azure has no in-module public CA issuance equivalent to AWS ACM. The App
# Gateway HTTPS listener consumes a Key Vault certificate referenced by
# var.certificate_arn (see the App Gateway ssl_certificate block). In dns_mode =
# managed the caller/worker provisions that KV cert (and the public A record is
# still created below); in delegated the worker also supplies certificate_arn.
# There is therefore NO azurerm resource here mirroring aws_acm_certificate.

# --- Front door: Application Gateway (+ WAF policy) ------------------------
# The Azure analogue of the ALB (+ WAFv2). Public IP + gateway-subnet IP config +
# backend pool (target-kind NICs, attached below) + backend HTTP settings + probe
# (from the app's load_balancer spec) + an HTTP listener, plus an HTTPS listener +
# HTTP->HTTPS redirect when a KV cert + identity are supplied. WAF_v2 SKU with an
# OWASP policy when waf_enabled, else Standard_v2. Gated on has_lb_spec.

resource "azurerm_public_ip" "appgw" {
  count               = local.has_lb_spec ? 1 : 0
  name                = "${local.name_prefix}-appgw-pip"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name
  allocation_method   = "Static"
  sku                 = "Standard"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-appgw-pip"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# OWASP-managed WAF policy, associated with the gateway when waf_enabled. Mirrors
# the AWS WAFv2 web ACL (managed rule groups). Default action is Prevention/block.
resource "azurerm_web_application_firewall_policy" "env" {
  count               = local.has_lb_spec && var.waf_enabled ? 1 : 0
  name                = "${local.name_prefix}-waf"
  resource_group_name = azurerm_resource_group.env.name
  location            = var.region

  policy_settings {
    enabled = true
    mode    = "Prevention"
  }

  managed_rules {
    managed_rule_set {
      type    = "OWASP"
      version = "3.2"
    }
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-waf"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "azurerm_application_gateway" "env" {
  count               = local.has_lb_spec ? 1 : 0
  name                = "${local.name_prefix}-appgw"
  location            = var.region
  resource_group_name = azurerm_resource_group.env.name

  sku {
    name     = var.waf_enabled ? "WAF_v2" : "Standard_v2"
    tier     = var.waf_enabled ? "WAF_v2" : "Standard_v2"
    capacity = 2
  }

  # OWASP WAF policy when enabled; null (and Standard_v2) otherwise.
  firewall_policy_id = one(azurerm_web_application_firewall_policy.env[*].id)

  gateway_ip_configuration {
    name      = local.appgw_gateway_ip_name
    subnet_id = local.lb_subnet_id
  }

  frontend_ip_configuration {
    name                 = local.appgw_frontend_ip_name
    public_ip_address_id = azurerm_public_ip.appgw[0].id
  }

  frontend_port {
    name = local.appgw_http_port_name
    port = 80
  }

  dynamic "frontend_port" {
    for_each = local.has_listener ? [1] : []
    content {
      name = local.appgw_https_port_name
      port = var.load_balancer.listener_port
    }
  }

  # Empty backend pool; target-kind NICs are attached via the association below
  # (the Azure analogue of aws_lb_target_group_attachment, keyed by plan_key).
  backend_address_pool {
    name = local.appgw_backend_pool_name
  }

  # port/protocol/health check all come from the app's load_balancer spec.
  backend_http_settings {
    name                                = local.appgw_backend_http_name
    cookie_based_affinity               = "Disabled"
    port                                = var.load_balancer.target_port
    protocol                            = local.appgw_backend_protocol
    request_timeout                     = 30
    probe_name                          = local.appgw_probe_name
    pick_host_name_from_backend_address = false
  }

  probe {
    name                                      = local.appgw_probe_name
    protocol                                  = local.appgw_probe_protocol
    path                                      = var.load_balancer.health_check_path
    host                                      = "127.0.0.1"
    interval                                  = 30
    timeout                                   = 5
    unhealthy_threshold                       = 3
    pick_host_name_from_backend_http_settings = false

    match {
      status_code = [var.load_balancer.health_check_matcher]
    }
  }

  # Always-present HTTP listener on :80.
  http_listener {
    name                           = local.appgw_http_listener_name
    frontend_ip_configuration_name = local.appgw_frontend_ip_name
    frontend_port_name             = local.appgw_http_port_name
    protocol                       = "Http"
  }

  # HTTPS listener + KV cert + user-assigned identity, only when has_listener.
  dynamic "http_listener" {
    for_each = local.has_listener ? [1] : []
    content {
      name                           = local.appgw_https_listener_name
      frontend_ip_configuration_name = local.appgw_frontend_ip_name
      frontend_port_name             = local.appgw_https_port_name
      protocol                       = "Https"
      ssl_certificate_name           = local.appgw_ssl_cert_name
    }
  }

  dynamic "ssl_certificate" {
    for_each = local.has_listener ? [1] : []
    content {
      name                = local.appgw_ssl_cert_name
      key_vault_secret_id = local.listener_cert_secret_id
    }
  }

  # The identity that reads the Key Vault cert. has_listener already requires
  # appgw_identity_id to be non-empty.
  dynamic "identity" {
    for_each = local.has_listener ? [1] : []
    content {
      type         = "UserAssigned"
      identity_ids = [var.appgw_identity_id]
    }
  }

  # HTTP -> HTTPS permanent redirect (the AWS HTTP(80) -> 301 listener), used by
  # the http-redirect routing rule below.
  dynamic "redirect_configuration" {
    for_each = local.has_listener ? [1] : []
    content {
      name                 = local.appgw_redirect_name
      redirect_type        = "Permanent"
      target_listener_name = local.appgw_https_listener_name
      include_path         = true
      include_query_string = true
    }
  }

  # No TLS cert -> the HTTP listener forwards straight to the backend.
  dynamic "request_routing_rule" {
    for_each = local.has_listener ? [] : [1]
    content {
      name                       = "http-forward"
      rule_type                  = "Basic"
      http_listener_name         = local.appgw_http_listener_name
      backend_address_pool_name  = local.appgw_backend_pool_name
      backend_http_settings_name = local.appgw_backend_http_name
      priority                   = 100
    }
  }

  # TLS cert present -> HTTPS forwards to the backend; HTTP redirects to HTTPS.
  dynamic "request_routing_rule" {
    for_each = local.has_listener ? [1] : []
    content {
      name                       = "https-forward"
      rule_type                  = "Basic"
      http_listener_name         = local.appgw_https_listener_name
      backend_address_pool_name  = local.appgw_backend_pool_name
      backend_http_settings_name = local.appgw_backend_http_name
      priority                   = 100
    }
  }

  dynamic "request_routing_rule" {
    for_each = local.has_listener ? [1] : []
    content {
      name                        = "http-redirect"
      rule_type                   = "Basic"
      http_listener_name          = local.appgw_http_listener_name
      redirect_configuration_name = local.appgw_redirect_name
      priority                    = 200
    }
  }

  # NOTE (documented gap): AWS enforces optional Cognito/OIDC MFA at the ALB
  # listener (authenticate-cognito). Azure Application Gateway has NO equivalent
  # built-in auth action — the Azure path is Azure AD Application Proxy / Front
  # Door + Entra ID, a follow-on. var.alb_auth (alb_auth_enabled) is therefore
  # ACCEPTED but NOT wired here. Do NOT fake it.

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-appgw"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# One backend-pool membership per web-serving node (the kinds named in the LB
# spec's target_kinds). Keyed by plan_key so the set tracks the compute for_each —
# the Azure analogue of aws_lb_target_group_attachment. Associations are untagged.
resource "azurerm_network_interface_application_gateway_backend_address_pool_association" "node" {
  for_each                = local.has_lb_spec ? local.search_targets : {}
  network_interface_id    = azurerm_network_interface.node[each.key].id
  ip_configuration_name   = "internal"
  backend_address_pool_id = one([for p in azurerm_application_gateway.env[0].backend_address_pool : p.id if p.name == local.appgw_backend_pool_name])
}

# --- Public DNS record ----------------------------------------------------
# Created in-account only for dns_mode = managed. delegated => the worker writes
# it cross-account into Veltrix's zone; private-only => no public record. An alias
# A record (target_resource_id) points at the App Gateway public IP — the Azure
# analogue of the AWS alias to the ALB.
resource "azurerm_dns_a_record" "env" {
  count               = local.dns_managed && local.has_dns && local.has_lb_spec ? 1 : 0
  name                = local.public_record_name
  zone_name           = var.public_dns_zone_name
  resource_group_name = var.public_dns_rg
  ttl                 = 60
  target_resource_id  = azurerm_public_ip.appgw[0].id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-public-dns"
    "Veltrix:PlanKey" = "foundation/dns"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- Private DNS: intra-cluster function FQDNs ----------------------------
# A Private DNS zone (linked to the deploy VNet) gives every node a stable
# function FQDN (idx1.<domain>, sh1.<domain>, ...). The bring-up layer uses
# node_fqdns (see outputs) to build its inventory. The PUBLIC record above is
# unaffected. Either create the zone here (create_private_zone) or reuse a
# caller-supplied one (private_zone_id != "").
resource "azurerm_private_dns_zone" "env" {
  count               = local.create_private_zone ? 1 : 0
  name                = var.dns_domain
  resource_group_name = azurerm_resource_group.env.name

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-private-zone"
    "Veltrix:PlanKey" = "foundation/dns"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "azurerm_private_dns_zone_virtual_network_link" "env" {
  count                 = local.create_private_zone ? 1 : 0
  name                  = "${local.name_prefix}-dns-link"
  resource_group_name   = azurerm_resource_group.env.name
  private_dns_zone_name = azurerm_private_dns_zone.env[0].name
  virtual_network_id    = local.network_id
  registration_enabled  = false

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-dns-link"
    "Veltrix:PlanKey" = "foundation/dns"
    "Veltrix:Tier"    = "foundation"
  })
}

# One A record per compute node -> its private IP, keyed by plan_key so the set
# tracks the compute for_each. Gated on want_private_dns (plan-time-known). The
# record NAME is the relative label (idx1), the zone NAME is dns_domain. zone_name
# resolves via the created zone when present (establishing the dependency), else
# the reused zone name.
resource "azurerm_private_dns_a_record" "node" {
  for_each            = local.want_private_dns ? local.node_short_labels : {}
  name                = each.value
  zone_name           = coalesce(one(azurerm_private_dns_zone.env[*].name), local.private_zone_name)
  resource_group_name = local.private_zone_rg
  ttl                 = 60
  records             = [azurerm_network_interface.node[each.key].private_ip_address]
}
