/// <reference path='./.sst/platform/config.d.ts' />
const PROD = "production";
export default $config({
  app(input) {
    const isDev = process.env.SST_DEV === "true";
    return {
      name: "flock",
      removal: input?.stage === PROD ? "retain" : "remove",
      protect: [PROD].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "ap-southeast-2",
        },
        ...(isDev
          ? {}
          : {
              cloudflare: { package: "@pulumi/cloudflare", version: "6.18.0" },
            }),
        cloudflare: { package: "@pulumi/cloudflare", version: "6.22.1" },
      },
    };
  },
  async run() {
    const stage = $app.stage;
    const isProd = stage === PROD;
    const isDev = process.env.SST_DEV === "true";
    const domain = isProd
      ? "flock.cross-code.org"
      : `flock-${stage}.cross-code.org`;
    const apiDomain = `api.${domain}`;
    const { DEPLOYMENTS } = await import("./src/deployments");
    const deployment = DEPLOYMENTS[domain];
    if (!isDev && !deployment) {
      throw new Error(`Add ${domain} to src/deployments.ts before deploying it`);
    }
    // -----------------------------------------------------------------
    // DynamoDB Tables
    // -----------------------------------------------------------------
    const accountsTable = new sst.aws.Dynamo("FlockAccounts", {
      deletionProtection: isProd,
      fields: {
        account: "string",
        reminderIndex: "string",
      },
      primaryIndex: { hashKey: "account" },
      // The notifier's index of accounts with reminders on (REMINDER_INDEX in src/vault/flockDriver.ts).
      // After first deploying it, run the indexReminderAccounts migration.
      globalIndexes: {
        ReminderIndex: {
          hashKey: "reminderIndex",
          projection: ["pushSubscriptions", "reminderTime", "reminderTimezone", "snoozeRemindersUntil"],
        },
      },
      transform: {
        table: (args) => {
          args.name = `FlockAccounts_${stage}`;
          // SST turns this on by default; pinned so the table keeps it whatever that default becomes
          args.pointInTimeRecovery = { enabled: true };
        },
      },
    });
    const itemsTable = new sst.aws.Dynamo("FlockItems", {
      deletionProtection: isProd,
      fields: {
        account: "string",
        item: "string",
        modifiedAt: "number",
      },
      primaryIndex: { hashKey: "account", rangeKey: "item" },
      globalIndexes: {
        AccountModifiedIndex: {
          hashKey: "account",
          rangeKey: "modifiedAt",
        },
      },
      transform: {
        table: (args) => {
          args.name = `FlockItems_${stage}`;
          args.pointInTimeRecovery = { enabled: true };
        },
      },
    });
    const syncLogTable = new sst.aws.Dynamo("FlockSyncLog", {
      fields: {
        account: "string",
        seq: "number",
      },
      primaryIndex: { hashKey: "account", rangeKey: "seq" },
      transform: {
        table: (args) => {
          args.name = `FlockSyncLog_${stage}`;
          args.ttl = {
            attributeName: "expiresAt",
            enabled: true,
          };
        },
      },
    });
    // Failed login counts per account ID, whether or not the account exists, and sign-up counts per
    // network (keyed by an HMAC, never an IP address). Rows expire once their window has ended, so
    // nothing here needs keeping: leave it out of backups, so that expired rows don't outlive it.
    const loginThrottleTable = new sst.aws.Dynamo("FlockLoginThrottle", {
      fields: {
        key: "string",
      },
      primaryIndex: { hashKey: "key" },
      transform: {
        table: (args) => {
          args.name = `FlockLoginThrottle_${stage}`;
          args.ttl = {
            attributeName: "expiresAt",
            enabled: true,
          };
          // SST enables point-in-time recovery by default, which would keep expired rows for 35 days
          args.pointInTimeRecovery = { enabled: false };
        },
      },
    });
    // -----------------------------------------------------------------
    // DynamoDB permissions
    // -----------------------------------------------------------------
    // Functions get the table names from their environment, not from links, because linking a table
    // grants dynamodb:* on it. Each function instead gets only the actions it makes, so only the API
    // can delete an item, which it does only to delete a whole account (sync rule 3 in AGENTS.md), and
    // only the migrations can scan. Transactions need
    // no actions of their own: DynamoDB checks each write in them. Add an action here when the code
    // starts making it, or it fails with AccessDenied once deployed (DynamoDB Local doesn't check).
    const dynamoAccess = (
      table: sst.aws.Dynamo,
      actions: string[],
      { indexes = false }: { indexes?: boolean } = {},
    ) => ({
      actions: actions.map(action => `dynamodb:${action}`),
      resources: indexes ? [table.arn, $interpolate`${table.arn}/index/*`] : [table.arn],
    });
    // -----------------------------------------------------------------
    // Vault API Lambda, behind API Gateway on api.<site domain>
    // -----------------------------------------------------------------
    // Derives the salts getSecurityParams makes up for unknown accounts. Never change it.
    const unknownAccountSecret = new sst.Secret("UNKNOWN_ACCOUNT_SECRET");
    const vaultApi = new sst.aws.Function("VaultApi", {
      handler: "src/vault/index.handler",
      runtime: "nodejs24.x",
      memory: "512 MB",
      // Leaves room for a cold start plus DynamoDB retries on a full sync batch, while staying
      // under the client's 30s request timeout
      timeout: "15 seconds",
      // Only for builds from before the API moved to apiDomain: installed apps keep calling this
      // until they update. Like API Gateway, it reports the client's own address as `sourceIp`.
      // Remove it once those builds are gone.
      url: {
        cors: false,
      },
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
        ITEMS_TABLE: itemsTable.name,
        SYNC_LOG_TABLE: syncLogTable.name,
        LOGIN_THROTTLE_TABLE: loginThrottleTable.name,
        SENTRY_DSN: deployment?.sentryDsn ?? "",
        // The only browser origin the API answers CORS for (src/vault/api/index.ts). `sst dev`
        // serves the app from localhost, so it allows that too.
        SITE_ORIGIN: `https://${domain}`,
        ALLOW_LOCALHOST_ORIGINS: isDev ? "true" : "",
      },
      link: [unknownAccountSecret],
      permissions: [
        // DeleteItem and BatchWriteItem are for deleting an account
        dynamoAccess(accountsTable, ["GetItem", "PutItem", "UpdateItem", "DeleteItem"]),
        dynamoAccess(itemsTable, ["Query", "BatchGetItem", "UpdateItem", "BatchWriteItem"]),
        // The head row's update and the message puts in each append's transaction
        dynamoAccess(syncLogTable, ["GetItem", "Query", "PutItem", "UpdateItem", "BatchWriteItem"]),
        dynamoAccess(loginThrottleTable, ["GetItem", "UpdateItem"]),
      ],
    });
    // The sign-up limit counts by `request.ip`, which is the event's `requestContext.http.sourceIp`:
    // the address that connected to API Gateway. Keep it that way:
    // - The DNS record must not be proxied. Through Cloudflare's proxy, every request would come
    //   from a Cloudflare address, so all sign-ups would share a few limits.
    // - Don't put CloudFront or another proxy in front, or trust X-Forwarded-For: the API stays
    //   reachable without the proxy, so a client could send any address it liked.
    const vaultApiGateway = new sst.aws.ApiGatewayV2("VaultApiGateway", {
      domain: isDev ? undefined : {
        name: apiDomain,
        dns: sst.cloudflare.dns({ proxy: false }),
      },
      // The server answers CORS itself (src/vault/api/index.ts). API Gateway's would replace it.
      cors: false,
      transform: {
        api: (args) => {
          // SST turns `cors: false` into an empty CORS configuration, not none. With any
          // configuration, API Gateway drops the server's CORS headers and answers with its own,
          // and an empty one allows no origins, so browsers couldn't call the API at all.
          args.corsConfiguration = undefined;
          // Only apiDomain serves the API (and the Function URL, until it goes)
          args.disableExecuteApiEndpoint = !isDev;
        },
        stage: (args) => {
          // SST's default access log format records each client's IP address and user agent, which
          // nothing else keeps (the throttle only holds an HMAC of the network).
          args.accessLogSettings = $output(args.accessLogSettings).apply(settings => settings && {
            ...settings,
            format: JSON.stringify({
              requestId: "$context.requestId",
              requestTime: "$context.requestTime",
              httpMethod: "$context.httpMethod",
              path: "$context.path",
              status: "$context.status",
              responseLatency: "$context.responseLatency",
              integrationLatency: "$context.integrationLatency",
              integrationStatus: "$context.integrationStatus",
              integrationErrorMessage: "$context.integrationErrorMessage",
              responseLength: "$context.responseLength",
            }),
          });
        },
      },
    });
    vaultApiGateway.route("$default", vaultApi.arn);
    // -----------------------------------------------------------------
    // Migrations Lambda (invoked manually or via CI)
    // -----------------------------------------------------------------
    const migrationsLambda = new sst.aws.Function("VaultMigrations", {
      handler: "src/vault/index.migrationHandler",
      runtime: "nodejs24.x",
      memory: "512 MB",
      timeout: "60 seconds",
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
        ITEMS_TABLE: itemsTable.name,
        SYNC_LOG_TABLE: syncLogTable.name,
      },
      permissions: [
        dynamoAccess(accountsTable, ["Scan", "UpdateItem"]),
        dynamoAccess(itemsTable, ["Scan", "Query", "UpdateItem"]),
      ],
    });
    // -----------------------------------------------------------------
    // Push Notifications (Queue + Worker)
    // -----------------------------------------------------------------
    // Only stages whose site has a VAPID key in src/deployments.ts send reminders. The others
    // (staging) have no notifier and no VAPID secrets, so production's private key stays out of them.
    if (isProd && !deployment?.vapidPublicKey) {
      throw new Error("Production must send reminders: give it a VAPID public key in src/deployments.ts");
    }
    const pushEnabled = isDev || Boolean(deployment?.vapidPublicKey);
    const vapidPublicKey = pushEnabled ? new sst.Secret("VAPID_PUBLIC_KEY") : undefined;
    if (vapidPublicKey) {
      const vapidSubject = new sst.Secret("VAPID_SUBJECT");
      const vapidPrivateKey = new sst.Secret("VAPID_PRIVATE_KEY");
      const pushNotificationsDLQ = new sst.aws.Queue("PushNotificationsDLQ");
      const pushNotificationsQueue = new sst.aws.Queue("PushNotificationsQueue", {
        dlq: {
          queue: pushNotificationsDLQ.arn,
          retry: 3,
        },
        // AWS recommends at least 6x the subscriber's timeout
        visibilityTimeout: "360 seconds",
      });
      pushNotificationsQueue.subscribe({
        handler: "src/vault/notifier/worker.handler",
        runtime: "nodejs24.x",
        memory: "512 MB",
        timeout: "60 seconds",
        environment: {
          ACCOUNTS_TABLE: accountsTable.name,
        },
        link: [vapidSubject, vapidPublicKey, vapidPrivateKey],
        permissions: [dynamoAccess(accountsTable, ["GetItem", "UpdateItem"])],
      }, {
        // The worker reports which records failed, so only those are retried
        batch: { partialResponses: true },
      });
      const cronMinutes = "15";
      new sst.aws.Cron("NotifierSchedule", {
        schedule: `cron(0/${cronMinutes} * ? * * *)`,
        function: {
          handler: "src/vault/notifier/enqueuer.handler",
          runtime: "nodejs24.x",
          memory: "512 MB",
          timeout: "60 seconds",
          environment: {
            ACCOUNTS_TABLE: accountsTable.name,
            PUSH_NOTIFICATIONS_QUEUE_URL: pushNotificationsQueue.url,
            NOTIFIER_CRON_INTERVAL_MINUTES: cronMinutes,
          },
          link: [pushNotificationsQueue],
          // Reads only ReminderIndex
          permissions: [dynamoAccess(accountsTable, ["Query"], { indexes: true })],
        },
      });
    }
    // -----------------------------------------------------------------
    // AWS Backup for DynamoDB tables (prod only)
    // -----------------------------------------------------------------
    if (isProd) {
      const backupVault = new aws.backup.Vault("FlockBackupVault", {
        name: `flock_dynamo_backup_vault_${stage}`,
      });
      // Nobody, whatever their IAM permissions, can delete a backup or shorten how long it's kept.
      // Backups still expire on their lifecycle. To delete one by hand, remove this policy first.
      new aws.backup.VaultPolicy("FlockBackupVaultPolicy", {
        backupVaultName: backupVault.name,
        policy: $jsonStringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "DenyBackupDeletion",
              Effect: "Deny",
              Principal: { AWS: "*" },
              Action: [
                "backup:DeleteRecoveryPoint",
                "backup:UpdateRecoveryPointLifecycle",
                "backup:DeleteBackupVault",
              ],
              // A vault policy only applies to its own vault, so this means every backup in it
              Resource: "*",
            },
          ],
        }),
      });
      const backupPlan = new aws.backup.Plan("FlockBackupPlan", {
        name: `flock_dynamo_backup_plan_${stage}`,
        // Point-in-time recovery (35 days) covers the recent past, so this only keeps a monthly
        // backup for the year before it
        rules: [
          {
            ruleName: `flock_dynamo_monthly_backup_${stage}`,
            targetVaultName: backupVault.name,
            // Backup at ~3am (AEST) on the 1st of each month (UTC)
            schedule: "cron(0 5 1 * ? *)",
            lifecycle: {
              deleteAfter: 365,
            },
          },
        ],
      });
      const backupRole = new aws.iam.Role("FlockBackupRole", {
        name: `flock_dynamo_backup_role_${stage}`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Action: ["sts:AssumeRole"],
              Effect: "Allow",
              Principal: {
                Service: ["backup.amazonaws.com"],
              },
            },
          ],
        }),
      });
      new aws.iam.RolePolicyAttachment("FlockBackupPolicyAttachment", {
        policyArn:
          "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
        role: backupRole.name,
      });
      new aws.backup.Selection("FlockBackupSelection", {
        iamRoleArn: backupRole.arn,
        name: `flock_dynamo_backup_selection_${stage}`,
        planId: backupPlan.id,
        resources: [accountsTable.arn, itemsTable.arn],
      });
    }
    // -----------------------------------------------------------------
    // Frontend (Cloudflare Workers static assets)
    // -----------------------------------------------------------------
    // Every stage ships the same build, whose _headers lets pages connect to production's API.
    // Narrow it to this stage's API and Sentry before the upload (withConnectSources in
    // src/deployments.ts). Commands that upload nothing, such as `sst remove`, may have no build.
    const headersPath = "dist/app/_headers";
    const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
    if (!isDev && existsSync("dist/app")) {
      const { withConnectSources } = await import("./src/deployments");
      writeFileSync(headersPath, withConnectSources(readFileSync(headersPath, "utf8"), deployment!));
    }
    const app = isDev
      ? undefined
      : new sst.cloudflare.StaticSiteV2("FlockApp", {
          path: "dist/app",
          domain,
          notFound: "single-page-application",
          // Answers requests for missing files with a 404 rather than the app shell (src/site/router.ts)
          transform: {
            server: { handler: "src/site/router.ts" },
          },
          environment: {
            // Nothing reads this variable. It's here because the site waits for its environment, so
            // a failed check stops the upload, and the API deploys before the site, which clients
            // rely on. The site is built beforehand, without deploy credentials
            // (.github/workflows/deploy.yml), so it only knows these values from src/deployments.ts.
            DEPLOY_CHECK: $resolve([vaultApiGateway.url, vapidPublicKey?.value ?? ""]).apply(
              ([url, vapidKey]) => {
                const endpoint = url.replace(/\/$/, "");
                if (endpoint !== deployment?.vaultEndpoint) {
                  throw new Error(`src/deployments.ts has the wrong API for ${domain}: it should be ${endpoint}`);
                }
                if (vapidKey !== (deployment.vapidPublicKey ?? "")) {
                  throw new Error(`src/deployments.ts has the wrong VAPID public key for ${domain}`);
                }
                return "passed";
              },
            ),
          },
        });
    return {
      appUrl: app?.url,
      vaultEndpoint: vaultApiGateway.url,
      legacyVaultEndpoint: vaultApi.url,
      migrationsLambda: migrationsLambda.name,
    };
  },
});
