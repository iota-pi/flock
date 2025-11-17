locals {
  env_prefix    = var.environment == "production" ? "" : var.environment
  subdomain     = trim("${local.env_prefix}.flock", ".")
  domain        = trim("${local.subdomain}.${var.root_domain}", ".")
}

# Root domain DNS and SSL Cert
resource "cloudflare_record" "primary_cname" {
  zone_id = var.cloudflare_zone_id
  type    = "CNAME"
  name    = local.subdomain != "" ? local.subdomain : "@"
  content = aws_cloudfront_distribution.s3_distribution.domain_name
}

resource "aws_acm_certificate" "root_cert" {
  domain_name       = local.domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  provider = aws.us_east_1
}

resource "aws_acm_certificate_validation" "root_cert" {
  certificate_arn         = aws_acm_certificate.root_cert.arn
  validation_record_fqdns = [for record in cloudflare_record.root_cert_validation : record.hostname]

  provider = aws.us_east_1
}

resource "cloudflare_record" "root_cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.root_cert.domain_validation_options : dvo.domain_name => {
      name    = dvo.resource_record_name
      content = dvo.resource_record_value
      type    = dvo.resource_record_type
    }
  }

  zone_id = var.cloudflare_zone_id
  name    = each.value.name
  type    = each.value.type
  content = trimsuffix(each.value.content, ".")
}

# Redirect www domain to root domain for production
resource "cloudflare_record" "www_cname" {
  count = local.subdomain == "" ? 1 : 0

  zone_id = var.cloudflare_zone_id
  type    = "CNAME"
  name    = "www"
  value   = aws_cloudfront_distribution.s3_distribution.domain_name
  proxied = true
}

resource "cloudflare_page_rule" "redirect_to_root" {
  count = var.environment == "production" ? 1 : 0

  zone_id  = var.cloudflare_zone_id
  target   = "www.${local.domain}/*"
  priority = 1

  actions {
    forwarding_url {
      url         = "https://${local.domain}"
      status_code = 301
    }
  }
}

output "full_domain" {
  value = local.domain
}
