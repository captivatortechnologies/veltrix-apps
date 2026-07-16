# =============================================================================
# AWS environment module — provider/version pinning (OpenTofu-compatible HCL).
#
# OpenTofu resolves providers from registry.opentofu.org by default but the
# canonical `hashicorp/aws` source address is mirrored there, so this block is
# byte-for-byte compatible with both `tofu` and `terraform`. We pin OpenTofu
# >= 1.6.0 (the first stable OpenTofu line) rather than a Terraform version.
# =============================================================================

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
