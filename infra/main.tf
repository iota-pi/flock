locals {
  environment = terraform.workspace == "default" ? "production" : terraform.workspace
}

module "app" {
  source = "./app"

  cloudflare_zone_id = var.cloudflare_zone_id
  environment        = local.environment
  root_domain        = var.root_domain

  providers = {
    aws.us_east_1 = aws.us_east_1
  }
}

module "vault" {
  source = "./vault"

  environment = local.environment
  full_domain = module.app.full_domain
}
