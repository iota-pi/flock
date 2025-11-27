locals {
  environment = terraform.workspace == "default" ? "production" : terraform.workspace
  env_prefix  = local.environment == "production" ? "" : "${local.environment}."
  full_domain = "${local.env_prefix}flock.cross-code.org"
}

module "vault" {
  source = "./vault"

  environment = local.environment
  full_domain = local.full_domain
}
