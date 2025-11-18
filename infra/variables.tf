variable "root_domain" {
  type    = string
  default = "cross-code.org"
}

variable "cloudflare_zone_id" {
  default = "1c8492a5fb75b8646814b0d4dcfe314c"
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "vault_version" {
  type = string
}

variable "code_bucket" {
  type    = string
  default = "crosscode-lambdas"
}
