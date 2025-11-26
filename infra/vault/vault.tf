locals {
  standard_tags = {
    Environment = var.environment
    Component   = "vault"
    Application = "flock"
  }

  lambda_runtime = "nodejs22.x"
  lambda_zip     = "${path.module}/../../dist/vault/lambda.zip"
}

# Main Vault API Lambda
module "vault_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.1"

  function_name = "flock-vault-${var.environment}"
  description   = "Flock Vault API"
  handler       = "lambda.handler"
  runtime       = local.lambda_runtime
  memory_size   = 512
  timeout       = 5

  create_package         = false
  local_existing_package = local.lambda_zip

  environment_variables = {
    ACCOUNTS_TABLE      = aws_dynamodb_table.vault_accounts_table.name
    ITEMS_TABLE         = aws_dynamodb_table.vault_items_table.name
    SUBSCRIPTIONS_TABLE = aws_dynamodb_table.vault_subscriptions_table.name
  }

  attach_policy_json            = true
  policy_json                   = data.aws_iam_policy_document.vault_policy.json
  attach_cloudwatch_logs_policy = false

  tags = local.standard_tags
}

# Migrations Lambda
module "vault_migrations_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.1"

  function_name = "flock-vault-migrations-${var.environment}"
  description   = "Flock Vault Migrations"
  handler       = "lambda.migrationHandler"
  runtime       = local.lambda_runtime
  memory_size   = 512
  timeout       = 60

  create_package         = false
  local_existing_package = local.lambda_zip

  environment_variables = {
    ACCOUNTS_TABLE      = aws_dynamodb_table.vault_accounts_table.name
    ITEMS_TABLE         = aws_dynamodb_table.vault_items_table.name
    SUBSCRIPTIONS_TABLE = aws_dynamodb_table.vault_subscriptions_table.name
  }

  attach_policy_json            = true
  policy_json                   = data.aws_iam_policy_document.vault_policy.json
  attach_cloudwatch_logs_policy = false

  tags = local.standard_tags
}

# Notifier Lambda
module "vault_notifier_lambda" {
  source  = "terraform-aws-modules/lambda/aws"
  version = "~> 8.1"

  function_name = "flock-vault-notifications-${var.environment}"
  description   = "Flock Vault Push Notifications"
  handler       = "lambda.notifierHandler"
  runtime       = local.lambda_runtime
  memory_size   = 512
  timeout       = 60

  create_package         = false
  local_existing_package = local.lambda_zip

  environment_variables = {
    ACCOUNTS_TABLE                 = aws_dynamodb_table.vault_accounts_table.name
    ITEMS_TABLE                    = aws_dynamodb_table.vault_items_table.name
    SUBSCRIPTIONS_TABLE            = aws_dynamodb_table.vault_subscriptions_table.name
    PROD_APP_URL                   = "https://${var.full_domain}"
    GOOGLE_APPLICATION_CREDENTIALS = "gcp-service-credentials.json"
  }

  attach_policy_json            = true
  policy_json                   = data.aws_iam_policy_document.vault_policy.json
  attach_cloudwatch_logs_policy = false

  allowed_triggers = {
    CloudWatchSchedule = {
      principal  = "events.amazonaws.com"
      source_arn = aws_cloudwatch_event_rule.notifier_trigger.arn
    }
  }

  tags = local.standard_tags
}

# IAM Policy Document
data "aws_iam_policy_document" "vault_policy" {
  statement {
    sid    = "PutLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["arn:aws:logs:*:*:*"]
  }

  statement {
    sid    = "ReadWriteCreateTable"
    effect = "Allow"
    actions = [
      "dynamodb:BatchGetItem",
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:BatchWriteItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:CreateTable"
    ]
    resources = [
      aws_dynamodb_table.vault_accounts_table.arn,
      aws_dynamodb_table.vault_items_table.arn,
      aws_dynamodb_table.vault_subscriptions_table.arn
    ]
  }
}


resource "aws_dynamodb_table" "vault_accounts_table" {
  name         = "FlockAccounts_${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "account"

  attribute {
    name = "account"
    type = "S"
  }

  tags = local.standard_tags
}

resource "aws_dynamodb_table" "vault_items_table" {
  name         = "FlockItems_${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "account"
  range_key    = "item"

  attribute {
    name = "account"
    type = "S"
  }

  attribute {
    name = "item"
    type = "S"
  }

  tags = local.standard_tags
}

resource "aws_dynamodb_table" "vault_subscriptions_table" {
  name         = "FlockSubscriptions_${var.environment}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  range_key    = "account"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "account"
    type = "S"
  }

  tags = local.standard_tags
}


resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.vault_lambda.lambda_function_name
  principal     = "apigateway.amazonaws.com"

  # The "/*/*" portion grants access from any method on any resource
  # within the API Gateway REST API.
  source_arn = "${aws_api_gateway_rest_api.vault_gateway.execution_arn}/*/*"
}


resource "aws_api_gateway_rest_api" "vault_gateway" {
  name        = "flock_vault_gateway_${var.environment}"
  description = "Flock gateway for Vault API"
}

resource "aws_api_gateway_resource" "vault_proxy" {
  rest_api_id = aws_api_gateway_rest_api.vault_gateway.id
  parent_id   = aws_api_gateway_rest_api.vault_gateway.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "vault_proxy_method" {
  rest_api_id   = aws_api_gateway_rest_api.vault_gateway.id
  resource_id   = aws_api_gateway_resource.vault_proxy.id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "vault_lambda" {
  rest_api_id = aws_api_gateway_rest_api.vault_gateway.id
  resource_id = aws_api_gateway_method.vault_proxy_method.resource_id
  http_method = aws_api_gateway_method.vault_proxy_method.http_method

  integration_http_method = "POST"

  type = "AWS_PROXY"
  uri  = module.vault_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_method" "vault_proxy_method_root" {
  rest_api_id   = aws_api_gateway_rest_api.vault_gateway.id
  resource_id   = aws_api_gateway_rest_api.vault_gateway.root_resource_id
  http_method   = "ANY"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "vault_lambda_root" {
  rest_api_id = aws_api_gateway_rest_api.vault_gateway.id
  resource_id = aws_api_gateway_method.vault_proxy_method_root.resource_id
  http_method = aws_api_gateway_method.vault_proxy_method_root.http_method

  integration_http_method = "POST"

  type = "AWS_PROXY"
  uri  = module.vault_lambda.lambda_function_invoke_arn
}

resource "aws_api_gateway_deployment" "vault_deployment" {
  rest_api_id = aws_api_gateway_rest_api.vault_gateway.id

  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.vault_proxy.id,
      aws_api_gateway_method.vault_proxy_method.id,
      aws_api_gateway_method.vault_proxy_method_root.id,
      aws_api_gateway_integration.vault_lambda.id,
      aws_api_gateway_integration.vault_lambda_root.id,
      aws_cloudwatch_log_group.debugging.id,
      1,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "vault_stage" {
  stage_name    = var.environment
  rest_api_id   = aws_api_gateway_rest_api.vault_gateway.id
  deployment_id = aws_api_gateway_deployment.vault_deployment.id
}


resource "aws_cloudwatch_log_group" "debugging" {
  name = "API-Gateway-Execution-Logs_${aws_api_gateway_rest_api.vault_gateway.id}/${var.environment}"

  retention_in_days = 7
}

output "invoke_url" {
  value = aws_api_gateway_stage.vault_stage.invoke_url
}

resource "aws_cloudwatch_event_rule" "notifier_trigger" {
  schedule_expression = "cron(0 * * * ? *)"

  description = "Run notifier each hour"
  tags        = local.standard_tags
}

resource "aws_cloudwatch_event_target" "notifier_target" {
  rule = aws_cloudwatch_event_rule.notifier_trigger.name
  arn  = module.vault_notifier_lambda.lambda_function_arn
}
