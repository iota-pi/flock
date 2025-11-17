locals {
  standard_tags = {
    Environment = var.environment
    Component   = "vault"
    Application = "flock"
  }
}

resource "aws_lambda_function" "vault" {
  function_name = "flock-vault-${var.environment}"

  handler     = "lambda.handler"
  runtime     = "nodejs22.x"
  memory_size = 512
  timeout     = 5

  s3_bucket = var.code_bucket
  s3_key    = "flock/${var.environment}/${var.git_version}/vault.zip"

  role = aws_iam_role.vault_role.arn

  environment {
    variables = {
      ACCOUNTS_TABLE      = aws_dynamodb_table.vault_accounts_table.name
      ITEMS_TABLE         = aws_dynamodb_table.vault_items_table.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.vault_subscriptions_table.name
    }
  }

  tags = local.standard_tags
}

resource "aws_lambda_function" "vault_migrations" {
  function_name = "flock-vault-migrations-${var.environment}"

  handler     = "lambda.migrationHandler"
  runtime     = "nodejs22.x"
  memory_size = 512
  timeout     = 60

  s3_bucket = var.code_bucket
  s3_key    = "flock/${var.environment}/${var.git_version}/vault.zip"

  role = aws_iam_role.vault_role.arn

  environment {
    variables = {
      ACCOUNTS_TABLE      = aws_dynamodb_table.vault_accounts_table.name
      ITEMS_TABLE         = aws_dynamodb_table.vault_items_table.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.vault_subscriptions_table.name
    }
  }

  tags = local.standard_tags
}

resource "aws_lambda_function" "vault_notifier" {
  function_name = "flock-vault-notifications-${var.environment}"

  handler     = "lambda.notifierHandler"
  runtime     = "nodejs22.x"
  memory_size = 512
  timeout     = 60

  s3_bucket = var.code_bucket
  s3_key    = "flock/${var.environment}/${var.git_version}/vault.zip"

  role = aws_iam_role.vault_role.arn

  environment {
    variables = {
      ACCOUNTS_TABLE      = aws_dynamodb_table.vault_accounts_table.name
      ITEMS_TABLE         = aws_dynamodb_table.vault_items_table.name
      SUBSCRIPTIONS_TABLE = aws_dynamodb_table.vault_subscriptions_table.name
      PROD_APP_URL        = "https://${var.full_domain}"

      GOOGLE_APPLICATION_CREDENTIALS = "gcp-service-credentials.json"
    }
  }

  tags = local.standard_tags
}

resource "aws_iam_role" "vault_role" {
  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_iam_policy" "vault_policy" {
  description = "Lambda policy to allow writing to DynamoDB and logging"

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PutLogs",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": ["arn:aws:logs:*:*:*"]
    },
    {
      "Sid": "ReadWriteCreateTable",
      "Effect": "Allow",
      "Action": [
          "dynamodb:BatchGetItem",
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:BatchWriteItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:CreateTable"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/${aws_dynamodb_table.vault_accounts_table.name}",
        "arn:aws:dynamodb:*:*:table/${aws_dynamodb_table.vault_items_table.name}",
        "arn:aws:dynamodb:*:*:table/${aws_dynamodb_table.vault_subscriptions_table.name}"
      ]
    }
  ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "vault_policy_attach" {
  role       = aws_iam_role.vault_role.name
  policy_arn = aws_iam_policy.vault_policy.arn
}


resource "aws_cloudwatch_log_group" "lambda_logs" {
  name              = "/aws/lambda/${aws_lambda_function.vault.function_name}"
  retention_in_days = 14
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
  function_name = aws_lambda_function.vault.function_name
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
  uri  = aws_lambda_function.vault.invoke_arn
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
  uri  = aws_lambda_function.vault.invoke_arn
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
  rule  = aws_cloudwatch_event_rule.notifier_trigger.name
  arn   = aws_lambda_function.vault_notifier.arn
}

resource "aws_lambda_permission" "allow_cloudwatch_to_call_notifier" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.vault_notifier.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.notifier_trigger.arn
}
