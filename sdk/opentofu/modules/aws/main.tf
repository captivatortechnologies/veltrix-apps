# =============================================================================
# AWS environment module — generic, tool-agnostic (REFERENCE for the other
# clouds). Driven by an app's rendered InfraSpec; NOTHING here is tool-specific.
#
# Network mode (worker-set deployment var, NOT app InfraSpec):
#   shared    — Veltrix-hosted: data-source the shared VPC + allocated subnet.
#   dedicated — BYOC: CREATE a fresh VPC + multi-AZ public/private subnets + IGW
#               + NAT + route tables in the customer's account.
#   existing  — BYOC: data-source a customer VPC + create a subnet in it.
# DNS mode: managed (in-account record + ACM cert) / delegated (worker does the
#   cross-account public DNS; module uses certificate_arn) / private-only.
#
# One compute resource per compute plan item (for_each keyed by plan_key) +
# storage / secrets / TLS / LB / DNS per topology tier. Isolation: per-stack
# subnet + SG-to-SG. Cost/attribution: var.tags on every taggable resource.
# =============================================================================

locals {
  # Short, DNS/label-safe prefix. infrastructure_id is a UUID; 8 chars is enough
  # to disambiguate within a customer while staying under AWS name limits.
  name_prefix = "${var.app_id}-${substr(var.infrastructure_id, 0, 8)}"

  # plan_key -> plan object, for compute nodes only. This map's keys ARE the
  # aws_instance.node[...] addresses, so status maps 1:1 back to resource rows.
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
  has_dns          = length([for r in var.plan : r if r.kind == "dns"]) > 0 && var.route53_zone_id != ""
  has_hec          = length([for r in var.plan : r if r.kind == "hec"]) > 0

  # Instance-profile inline policy references only the secret ARNs this stack created
  # ([*] splat yields [] when the count-gated resource is absent). node_needs_inline
  # gates the inline policy so we never attach an empty document.
  node_secret_arns  = concat(aws_secretsmanager_secret.env[*].arn, aws_secretsmanager_secret.license[*].arn)
  node_needs_inline = local.has_storage || length(local.node_secret_arns) > 0 || var.artifacts_bucket != ""

  resolved_ami = var.ami_id != "" ? var.ami_id : data.aws_ami.al2023.id

  # A per-resource Name/plan_key is merged INTO the canonical tag set so every
  # object still carries var.tags (incl. Veltrix:ManagedBy) verbatim.
  base_tags = var.tags

  # --- Network mode: hosted-shared vs BYOC dedicated/existing -----------
  is_dedicated   = var.network_mode == "dedicated"
  lookup_network = var.network_mode == "shared" || var.network_mode == "existing"

  # Two AZs for a multi-AZ dedicated fabric (and the ALB's 2-subnet minimum).
  azs = slice(data.aws_availability_zones.available.names, 0, 2)

  # Availability zones the plan pins nodes to (multi-AZ placement — indexer /
  # search-head only). Unioned with the default AZs so a dedicated fabric creates
  # a compute subnet for every zone a node needs.
  placement_azs = distinct(compact([for r in var.plan : r.zone]))
  all_azs       = distinct(concat(local.azs, local.placement_azs))

  # Resolved network + subnet sets, uniform across all three modes:
  #   dedicated -> the created VPC + its private (compute) / public (ALB) subnets
  #   shared/existing -> the looked-up VPC + the single allocated subnet
  network_id         = local.is_dedicated ? aws_vpc.env[0].id : data.aws_vpc.shared[0].id
  compute_subnet_ids = local.is_dedicated ? [for s in aws_subnet.private : s.id] : [aws_subnet.env[0].id]
  lb_subnet_ids = local.is_dedicated ? [for s in aws_subnet.public : s.id] : concat(
    [aws_subnet.env[0].id], var.extra_lb_subnet_ids,
  )
  # AZ name -> compute subnet id. Dedicated mode has a private subnet per AZ;
  # shared/existing has only the single allocated subnet, so this stays empty and
  # every node falls back to that subnet (multi-AZ needs a dedicated fabric).
  compute_subnet_by_az = local.is_dedicated ? {
    for az in local.all_azs : az => aws_subnet.private[az].id
  } : {}
  # Pin each node to the subnet in its `zone` when one exists; otherwise spread
  # round-robin across the available compute subnets (backward-compatible default
  # for single-site plans, which carry no zone).
  compute_subnet_for = {
    for idx, k in sort(keys(local.compute_nodes)) : k =>
    lookup(
      local.compute_subnet_by_az,
      coalesce(local.compute_nodes[k].zone, "__no_zone__"),
      local.compute_subnet_ids[idx % length(local.compute_subnet_ids)],
    )
  }

  # --- DNS mode: managed (in-account) / delegated (worker x-account) / none
  dns_managed    = var.dns_mode == "managed"
  has_public_dns = var.dns_mode != "private-only"
  # The listener cert is either issued here (managed) or supplied (delegated).
  listener_cert_arn = local.dns_managed ? (
    (local.has_tls && var.dns_domain != "") ? aws_acm_certificate.env[0].arn : ""
  ) : var.certificate_arn

  # --- Derived ALB / listener gates -------------------------------------
  # has_lb = the plan carries a load-balancer item; has_lb_spec additionally
  # requires the app to have supplied a load_balancer spec (target port / health
  # check / target kinds). The target group + listeners build only when a spec is
  # present. has_listener adds the TLS cert + domain (plan-time-known, like the
  # other has_* flags, so every listener/attachment gates identically).
  has_lb_spec = local.has_lb && var.load_balancer != null
  # HTTPS listener needs a cert: issued here (managed + a tls plan item) or
  # supplied by the worker (delegated + certificate_arn).
  has_listener = local.has_lb_spec && var.dns_domain != "" && (
    local.dns_managed ? local.has_tls : var.certificate_arn != ""
  )
  alb_auth_enabled = var.alb_auth.enabled

  # Compute nodes that sit behind the ALB — the kinds the app named as LB targets
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
  # deterministic and stable across applies.
  node_prefix = {
    for k, r in local.compute_nodes : k => lookup(var.dns_prefixes, r.kind, r.kind)
  }

  # Deterministic per-kind ordinal: the label index is the key's position within
  # its kind's lexically-sorted plan_key list (1-based via index()+1). Distinct
  # keys therefore get unique, collision-free ordinals independent of the plan's
  # input order (e.g. idx1, idx2 / sh1, sh2). NOTE: ordering is lexical, so with
  # >=10 nodes of a kind the label index may differ from the plan_key's numeric
  # suffix — it stays unique and stable, which is all the inventory contract needs.
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
  # Either create a private hosted zone for var.dns_domain (create_private_zone)
  # or point at a caller-supplied one (private_zone_id). want_private_dns is the
  # plan-time-known intent used to gate the per-node record for_each (the zone id
  # itself may stay computed until apply, which is fine for a record attribute
  # but NOT for a for_each key set).
  create_private_zone = var.create_private_zone && var.dns_domain != "" && var.private_zone_id == ""
  want_private_dns    = var.dns_domain != "" && (var.private_zone_id != "" || local.create_private_zone)
  private_zone_id = var.private_zone_id != "" ? var.private_zone_id : (
    local.create_private_zone ? aws_route53_zone.private[0].id : ""
  )

  # --- Flattened SG ingress rules (from the app's security_rules) --------
  # Each (rule, source) pair becomes one aws_vpc_security_group_ingress_rule,
  # keyed "<port>-<protocol>-<source>". "alb"-sourced rules are dropped when there
  # is no ALB (no alb SG to reference). This replaces any hardcoded, tool-specific
  # port list — the app declares its ports in InfraSpec.securityRules.
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

  # Cross-region cluster traffic: peers in a PEERED VPC (a multi-region indexer/
  # search-head satellite) are in a different security group, so the "self" rules
  # don't reach them. For every intra-cluster ("self") rule, allow the same port
  # from each peer VPC CIDR. Empty peer_cidrs (the single-region default) yields
  # no extra rules — fully backward compatible.
  sg_peer_ingress = merge([
    for r in var.security_rules : {
      for cidr in(contains(r.sources, "self") ? var.peer_cidrs : []) :
      "${r.port}-${r.protocol}-peer-${cidr}" => {
        port        = r.port
        protocol    = r.protocol
        cidr        = cidr
        description = "port ${r.port} (${r.protocol}) from peer VPC ${cidr}"
      }
    }
  ]...)
}

data "aws_availability_zones" "available" {
  state = "available"
}

# Scaffold fallback AMI only. Production must pass a tool-preinstalled AMI.
data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
}

# --- Network lookup (network_mode = shared | existing) --------------------
# The VPC is data-sourced (never created) — the shared Veltrix VPC for hosted,
# or a customer-designated VPC for BYOC "existing". Absent when dedicated.

data "aws_vpc" "shared" {
  count = local.lookup_network ? 1 : 0
  id    = var.network_lookup_by == "id" ? var.network_ref : null

  dynamic "filter" {
    for_each = var.network_lookup_by == "tag" ? [1] : []
    content {
      name   = "tag:Name"
      values = [var.network_ref]
    }
  }
}

# The stack's single allocated subnet, in the looked-up VPC (shared|existing).
resource "aws_subnet" "env" {
  count             = local.lookup_network ? 1 : 0
  vpc_id            = data.aws_vpc.shared[0].id
  cidr_block        = var.subnet_cidr
  availability_zone = local.azs[0]

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-subnet"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- Dedicated network fabric (network_mode = dedicated / BYOC) ------------
# A fresh, isolated VPC created in the DEPLOY account (the customer's, for BYOC):
# 2 public + 2 private subnets across 2 AZs, an internet gateway, a NAT gateway,
# and route tables. Compute nodes live in the private subnets; the ALB in the
# public subnets. Nothing here runs in shared/existing mode.

resource "aws_vpc" "env" {
  count                = local.is_dedicated ? 1 : 0
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-vpc"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_internet_gateway" "env" {
  count  = local.is_dedicated ? 1 : 0
  vpc_id = aws_vpc.env[0].id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-igw"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# Public subnets (one per AZ) — carry the ALB + NAT. cidrsubnet(/16, 4, i) => /20.
resource "aws_subnet" "public" {
  for_each                = local.is_dedicated ? toset(local.azs) : toset([])
  vpc_id                  = aws_vpc.env[0].id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, index(local.azs, each.key))
  map_public_ip_on_launch = true

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-public-${each.key}"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# Private subnets (one per AZ the plan uses) — carry the compute nodes. Offset by
# 8 => distinct /20 blocks that never overlap the public ones.
resource "aws_subnet" "private" {
  for_each          = local.is_dedicated ? toset(local.all_azs) : toset([])
  vpc_id            = aws_vpc.env[0].id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, index(local.all_azs, each.key) + 8)

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-private-${each.key}"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_eip" "nat" {
  count  = local.is_dedicated ? 1 : 0
  domain = "vpc"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-nat-eip"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_nat_gateway" "env" {
  count         = local.is_dedicated ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[local.azs[0]].id
  depends_on    = [aws_internet_gateway.env]

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-nat"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_route_table" "public" {
  count  = local.is_dedicated ? 1 : 0
  vpc_id = aws_vpc.env[0].id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.env[0].id
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-public-rt"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_route_table" "private" {
  count  = local.is_dedicated ? 1 : 0
  vpc_id = aws_vpc.env[0].id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-private-rt"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# Default egress via NAT — a SEPARATE aws_route (not an inline `route` block) so
# the root can add cross-region VPC-peering routes to this same table without the
# inline-vs-resource conflict the AWS provider forbids. Same route, no behavior change.
resource "aws_route" "private_nat" {
  count                  = local.is_dedicated ? 1 : 0
  route_table_id         = aws_route_table.private[0].id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.env[0].id
}

resource "aws_route_table_association" "public" {
  for_each       = local.is_dedicated ? aws_subnet.public : {}
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public[0].id
}

resource "aws_route_table_association" "private" {
  for_each       = local.is_dedicated ? aws_subnet.private : {}
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[0].id
}

# --- Security groups: SG-to-SG least privilege ----------------------------
# Two SGs replace the old flat-CIDR SG:
#   * alb  — public edge, only 443/80 from the web ingress CIDR.
#   * node — Splunk hosts; peer ports self-reference the node SG so intra-cluster
#            traffic is scoped to *this stack's* instances (not a whole CIDR), and
#            Splunk Web is reachable only via the ALB (or admin CIDR with no ALB).

# Public ALB edge SG. Only created when the plan carries a load-balancer.
resource "aws_security_group" "alb" {
  count       = local.has_lb ? 1 : 0
  name        = "${local.name_prefix}-alb-sg"
  description = "Public ALB ingress (443/80) for ${local.name_prefix}"
  vpc_id      = local.network_id

  ingress {
    description = "HTTPS from web clients"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.web_ingress_cidr]
  }

  ingress {
    description = "HTTP (redirected to HTTPS at the listener)"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.web_ingress_cidr]
  }

  egress {
    description = "All egress (forward to Splunk nodes)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-alb-sg"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# Node SG. Ingress lives in a single for_each'd standalone rule resource (below)
# so intra-cluster ports can self-reference this SG's own id without an inline
# dependency cycle. Do NOT add inline rules here — mixing inline blocks with
# standalone rule resources on one SG makes them clobber each other. The resource
# name stays `splunk` so security_group_id / the instances' vpc_security_group_ids
# keep a stable address across apps.
resource "aws_security_group" "splunk" {
  name        = "${local.name_prefix}-sg"
  description = "Compute node ports for ${local.name_prefix} (SG-to-SG least privilege)"
  vpc_id      = local.network_id

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-sg"
    "Veltrix:PlanKey" = "foundation/network"
    "Veltrix:Tier"    = "foundation"
  })
}

# One ingress rule per (security_rules entry, source), from local.sg_ingress.
# The app declares its ports/sources in InfraSpec.securityRules — the module
# stays tool-agnostic. Exactly one origin attribute is set per rule; the others
# are null (omitted): "self"/"alb" -> referenced_security_group_id, "admin" ->
# cidr_ipv4. "alb" rules are pre-filtered out of sg_ingress when there is no ALB.
resource "aws_vpc_security_group_ingress_rule" "node" {
  for_each = local.sg_ingress

  security_group_id = aws_security_group.splunk.id
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = each.value.protocol
  description       = each.value.description

  referenced_security_group_id = (
    each.value.source == "self" ? aws_security_group.splunk.id :
    each.value.source == "alb" ? aws_security_group.alb[0].id :
    null
  )
  cidr_ipv4 = each.value.source == "admin" ? var.admin_cidr : null

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-${each.key}" })
}

# Cross-region cluster ingress: same intra-cluster ports, from each peered VPC's
# CIDR (multi-region satellites). Empty when peer_cidrs is empty (single-region).
resource "aws_vpc_security_group_ingress_rule" "peer" {
  for_each = local.sg_peer_ingress

  security_group_id = aws_security_group.splunk.id
  from_port         = each.value.port
  to_port           = each.value.port
  ip_protocol       = each.value.protocol
  description       = each.value.description
  cidr_ipv4         = each.value.cidr

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-${each.key}" })
}

# Egress: all (nodes reach peers, object storage, license/registration, updates).
resource "aws_vpc_security_group_egress_rule" "node_all" {
  security_group_id = aws_security_group.splunk.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  description       = "All egress"

  tags = merge(local.base_tags, { Name = "${local.name_prefix}-egress" })
}

# --- Compute: one aws_instance per compute plan item ----------------------
# for_each keyed by plan_key => aws_instance.node["data/indexer-1"] etc.

resource "aws_instance" "node" {
  for_each = local.compute_nodes

  ami = local.resolved_ami
  instance_type = coalesce(
    lookup(var.instance_types_by_kind, each.value.kind, null),
    lookup(var.instance_types, each.value.tier, null),
    var.default_instance_type,
  )
  subnet_id              = local.compute_subnet_for[each.key]
  vpc_security_group_ids = [aws_security_group.splunk.id]
  key_name               = var.key_name != "" ? var.key_name : null
  # Instance profile gives the bring-up layer SSM reachability (no SSH) plus scoped
  # reads of the secret bundle, the SmartStore bucket, and the Splunk artifacts bucket.
  iam_instance_profile = aws_iam_instance_profile.node.name

  root_block_device {
    volume_size = var.root_volume_gb
    volume_type = "gp3"
    encrypted   = true
  }

  tags = merge(local.base_tags, {
    # Meaningful, unique per-node name (e.g. <prefix>-cm1 / -idx1 / -sh1) instead of
    # colliding on kind. node_short_labels also feeds the private-DNS FQDNs.
    Name              = "${local.name_prefix}-${local.node_short_labels[each.key]}"
    "Veltrix:PlanKey" = each.key
    "Veltrix:Tier"    = each.value.tier
    "Veltrix:Kind"    = each.value.kind
    "Veltrix:Role"    = each.value.role
    # Consolidated control-plane roles + placement zone (topology authoring).
    "Veltrix:Roles" = join(",", each.value.roles)
    "Veltrix:Zone"  = each.value.zone != null ? each.value.zone : ""
  })
}

# --- Instance IAM: SSM reachability + Secrets + S3 (SmartStore + artifacts) ---
# Every node gets an instance profile so the bring-up layer can reach it over SSM
# Run Command (no SSH, no inbound), read its admin-seed / pass4SymmKey bundle,
# read/write the SmartStore bucket, and pull the Splunk .tgz from the artifacts bucket.

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${local.name_prefix}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = local.base_tags
}

# SSM Run Command / Session Manager connectivity + inventory.
resource "aws_iam_role_policy_attachment" "node_ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Scoped inline policy: only the ARNs this stack actually created.
data "aws_iam_policy_document" "node_inline" {
  dynamic "statement" {
    for_each = length(local.node_secret_arns) > 0 ? [1] : []
    content {
      sid       = "ReadSecrets"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = local.node_secret_arns
    }
  }
  dynamic "statement" {
    for_each = local.has_storage ? [1] : []
    content {
      sid       = "SmartStoreBucket"
      actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
      resources = [aws_s3_bucket.objstore[0].arn]
    }
  }
  dynamic "statement" {
    for_each = local.has_storage ? [1] : []
    content {
      sid       = "SmartStoreObjects"
      actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      resources = ["${aws_s3_bucket.objstore[0].arn}/*"]
    }
  }
  dynamic "statement" {
    for_each = var.artifacts_bucket != "" ? [1] : []
    content {
      sid       = "SplunkArtifacts"
      actions   = ["s3:GetObject", "s3:ListBucket"]
      resources = ["arn:aws:s3:::${var.artifacts_bucket}", "arn:aws:s3:::${var.artifacts_bucket}/*"]
    }
  }
}

resource "aws_iam_role_policy" "node" {
  count  = local.node_needs_inline ? 1 : 0
  name   = "${local.name_prefix}-node"
  role   = aws_iam_role.node.id
  policy = data.aws_iam_policy_document.node_inline.json
}

resource "aws_iam_instance_profile" "node" {
  name = "${local.name_prefix}-node"
  role = aws_iam_role.node.name
}

# --- Storage: object-storage bucket (e.g. Splunk SmartStore, warm/cold) -----
# Generic S3 bucket for the app's bulk/object storage. The tool's meaning is
# app-defined (InfraSpec.storage); the module just provisions a private bucket.

resource "random_id" "bucket_suffix" {
  count       = local.has_storage ? 1 : 0
  byte_length = 4
}

resource "aws_s3_bucket" "objstore" {
  count         = local.has_storage ? 1 : 0
  bucket        = "${local.name_prefix}-objstore-${random_id.bucket_suffix[0].hex}"
  force_destroy = false

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-objstore"
    "Veltrix:PlanKey" = "foundation/storage"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_s3_bucket_public_access_block" "objstore" {
  count                   = local.has_storage ? 1 : 0
  bucket                  = aws_s3_bucket.objstore[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- Secrets: per-tenant secret bundle (admin seed / pass4SymmKey / etc.) ----

resource "aws_secretsmanager_secret" "env" {
  count = local.has_secrets ? 1 : 0
  name  = "${local.name_prefix}/env-secrets"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-secrets"
    "Veltrix:PlanKey" = "foundation/secrets"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- BYOL license file (stored as a secret; validated post-apply) ---------

resource "aws_secretsmanager_secret" "license" {
  count = local.has_license_file ? 1 : 0
  name  = "${local.name_prefix}/byol-license"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-license"
    "Veltrix:PlanKey" = "foundation/license-file"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- TLS certificate (web + inter-node) -----------------------------------

resource "aws_acm_certificate" "env" {
  # Issued in-account only for dns_mode = managed. In delegated mode the worker
  # provisions + cross-account-validates the cert and passes certificate_arn.
  count             = local.dns_managed && local.has_tls && var.dns_domain != "" ? 1 : 0
  domain_name       = var.dns_domain
  validation_method = "DNS"

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-cert"
    "Veltrix:PlanKey" = "foundation/tls"
    "Veltrix:Tier"    = "foundation"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# --- Load balancer: the app's web tier + HEC ingress ----------------------
# An ALB needs >= 2 subnets in >= 2 AZs. In dedicated mode local.lb_subnet_ids
# is the created multi-AZ public subnets; in shared/existing it is the per-stack
# subnet plus var.extra_lb_subnet_ids (which MUST cover a second AZ).

resource "aws_lb" "env" {
  count              = local.has_lb ? 1 : 0
  name               = substr("${local.name_prefix}-alb", 0, 32)
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb[0].id]
  subnets            = local.lb_subnet_ids

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-alb"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- ALB target group: the app's web tier ---------------------------------
# Port / protocol / health check all come from the app's load_balancer spec
# (InfraSpec.loadBalancer). TLS terminates at the ALB listener, so the target
# protocol is typically HTTP. Gated on has_lb_spec (plan LB item + a spec).

resource "aws_lb_target_group" "search" {
  count       = local.has_lb_spec ? 1 : 0
  name        = substr("${local.name_prefix}-tg", 0, 32)
  port        = var.load_balancer.target_port
  protocol    = var.load_balancer.target_protocol
  vpc_id      = local.network_id
  target_type = "instance"

  health_check {
    path                = var.load_balancer.health_check_path
    protocol            = var.load_balancer.health_check_protocol != "" ? var.load_balancer.health_check_protocol : var.load_balancer.target_protocol
    port                = "traffic-port"
    matcher             = var.load_balancer.health_check_matcher
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-tg"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# One attachment per web-serving node (the kinds the app named in the LB spec's
# target_kinds). Keyed by plan_key so the set tracks the compute for_each.
resource "aws_lb_target_group_attachment" "search" {
  for_each         = local.has_lb_spec ? local.search_targets : {}
  target_group_arn = aws_lb_target_group.search[0].arn
  target_id        = aws_instance.node[each.key].id
  port             = var.load_balancer.target_port
}

# --- ALB listeners: HTTPS(443) terminate + optional Cognito MFA, HTTP(80)→301 -
# The whole listener chain is gated on has_listener (ALB + TLS cert + domain).

resource "aws_lb_listener" "https" {
  count             = local.has_listener ? 1 : 0
  load_balancer_arn = aws_lb.env[0].arn
  port              = var.load_balancer.listener_port
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = local.listener_cert_arn

  # Optional OIDC/Cognito MFA in front of the app's web UI. When enabled the default
  # action becomes an ordered pair — authenticate-cognito (order 1) THEN forward
  # (order 2). The dynamic block emits the auth action only when configured, so
  # the plain forward-only path stays valid when auth is disabled.
  dynamic "default_action" {
    for_each = local.alb_auth_enabled ? [1] : []
    content {
      type  = "authenticate-cognito"
      order = 1

      authenticate_cognito {
        user_pool_arn       = var.alb_auth.user_pool_arn
        user_pool_client_id = var.alb_auth.user_pool_client_id
        user_pool_domain    = var.alb_auth.user_pool_domain
      }
    }
  }

  default_action {
    type             = "forward"
    order            = local.alb_auth_enabled ? 2 : 1
    target_group_arn = aws_lb_target_group.search[0].arn
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-https"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_lb_listener" "http" {
  count             = local.has_listener ? 1 : 0
  load_balancer_arn = aws_lb.env[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = tostring(var.load_balancer.listener_port)
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-http-redirect"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

# --- WAFv2 web ACL (regional, ALB-scoped) ---------------------------------
# Default allow, with AWS-managed rule groups + an IP rate limit. Managed groups
# use override_action { none {} } so their own block/count verdicts stand (we do
# NOT override them to count). Gated on has_lb (WAFv2 REGIONAL fronts the ALB).

resource "aws_wafv2_web_acl" "env" {
  count = local.has_lb && var.waf_enabled ? 1 : 0
  name  = "${local.name_prefix}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-ip-rep"
      sampled_requests_enabled   = true
    }
  }

  # Volumetric protection: block a source IP over ~2000 requests / 5 min.
  rule {
    name     = "RateLimitPerIP"
    priority = 4

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name_prefix}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name_prefix}-waf"
    sampled_requests_enabled   = true
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-waf"
    "Veltrix:PlanKey" = "foundation/load-balancer"
    "Veltrix:Tier"    = "foundation"
  })
}

resource "aws_wafv2_web_acl_association" "env" {
  count        = local.has_lb && var.waf_enabled ? 1 : 0
  resource_arn = aws_lb.env[0].arn
  web_acl_arn  = aws_wafv2_web_acl.env[0].arn
}

# --- Public DNS record ----------------------------------------------------
# Created in-account only for dns_mode = managed. delegated => the worker writes
# it cross-account into Veltrix's zone; private-only => no public record.

resource "aws_route53_record" "env" {
  count   = local.dns_managed && local.has_dns && local.has_lb ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.dns_domain
  type    = "A"

  alias {
    name                   = aws_lb.env[0].dns_name
    zone_id                = aws_lb.env[0].zone_id
    evaluate_target_health = true
  }
  # aws_route53_record does not support tags.
}

# --- Private DNS: intra-cluster function FQDNs ----------------------------
# A private hosted zone (associated with the shared VPC) gives every node a
# stable function FQDN (idx1.<domain>, sh1.<domain>, cm1.<domain>, ...). Splunk's
# cluster/SHC config references peers by these names, and the bring-up layer uses
# node_fqdns (see outputs) to build its inventory. The PUBLIC ALB record above is
# unaffected. Either create the zone here (create_private_zone) or reuse a
# caller-supplied one (private_zone_id).

resource "aws_route53_zone" "private" {
  count = local.create_private_zone ? 1 : 0
  name  = var.dns_domain

  vpc {
    vpc_id = local.network_id
  }

  tags = merge(local.base_tags, {
    Name              = "${local.name_prefix}-private-zone"
    "Veltrix:PlanKey" = "foundation/dns"
    "Veltrix:Tier"    = "foundation"
  })
}

# One A record per compute node → its private IP, keyed by plan_key so the set
# tracks the compute for_each. Gated on want_private_dns (plan-time-known) so the
# key set never depends on the not-yet-known created-zone id.
resource "aws_route53_record" "node" {
  for_each = local.want_private_dns ? local.node_fqdns : {}
  zone_id  = local.private_zone_id
  name     = each.value
  type     = "A"
  ttl      = 60
  records  = [aws_instance.node[each.key].private_ip]
}
