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
      },
      primaryIndex: { hashKey: "account" },
      transform: {
        table: (args) => {
          args.name = `FlockAccounts_${stage}`;
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
        },
      },
    });
    // Nothing reads or writes this since the sync log replaced it. It stays for repairs until its
    // rows expire (docs/sync-log-plan.md), and no function links to it.
    new sst.aws.Dynamo("FlockSyncMessages", {
      fields: {
        syncId: "string",
        cursor: "number",
        account: "string",
      },
      primaryIndex: { hashKey: "syncId", rangeKey: "cursor" },
      globalIndexes: {
        AccountCursorIndex: { hashKey: "account", rangeKey: "cursor" },
      },
      transform: {
        table: (args) => {
          args.name = `FlockSyncMessages_${stage}`;
          args.ttl = {
            attributeName: "expiresAt",
            enabled: true,
          };
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
    // -----------------------------------------------------------------
    // Vault API Lambda + Function URL
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
      url: {
        cors: false,
      },
      environment: {
        ACCOUNTS_TABLE: accountsTable.name,
        ITEMS_TABLE: itemsTable.name,
        SYNC_LOG_TABLE: syncLogTable.name,
        SENTRY_DSN: deployment?.sentryDsn ?? "",
        UNKNOWN_ACCOUNT_SECRET: unknownAccountSecret.value,
      },
      link: [accountsTable, itemsTable, syncLogTable, unknownAccountSecret],
    });
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
      link: [accountsTable, itemsTable, syncLogTable],
    });
    // -----------------------------------------------------------------
    // Push Notifications (Queue + Worker)
    // -----------------------------------------------------------------
    const vapidSubject = new sst.Secret("VAPID_SUBJECT");
    const vapidPublicKey = new sst.Secret("VAPID_PUBLIC_KEY");
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
        VAPID_SUBJECT: vapidSubject.value,
        VAPID_PUBLIC_KEY: vapidPublicKey.value,
        VAPID_PRIVATE_KEY: vapidPrivateKey.value,
      },
      link: [accountsTable, vapidSubject, vapidPublicKey, vapidPrivateKey],
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
        link: [accountsTable, pushNotificationsQueue],
      },
    });
    // -----------------------------------------------------------------
    // AWS Backup for DynamoDB tables (prod only)
    // -----------------------------------------------------------------
    if (isProd) {
      const backupVault = new aws.backup.Vault("FlockBackupVault", {
        name: `flock_dynamo_backup_vault_${stage}`,
      });
      const backupPlan = new aws.backup.Plan("FlockBackupPlan", {
        name: `flock_dynamo_backup_plan_${stage}`,
        rules: [
          {
            ruleName: `flock_dynamo_weekly_backup_plan_${stage}`,
            targetVaultName: backupVault.name,
            // Backup at ~2am (AEST) on Sunday morning each week (UTC)
            schedule: "cron(0 4 ? * SAT *)",
            lifecycle: {
              deleteAfter: 30,
            },
          },
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
            DEPLOY_CHECK: $resolve([vaultApi.url, vapidPublicKey.value]).apply(
              ([url, vapidKey]) => {
                const endpoint = url.replace(/\/$/, "");
                if (endpoint !== deployment?.vaultEndpoint) {
                  throw new Error(`src/deployments.ts has the wrong API for ${domain}: it should be ${endpoint}`);
                }
                if (vapidKey !== deployment.vapidPublicKey) {
                  throw new Error(`src/deployments.ts has the wrong VAPID public key for ${domain}`);
                }
                return "passed";
              },
            ),
          },
        });
    return {
      appUrl: app?.url,
      vaultEndpoint: vaultApi.url,
      migrationsLambda: migrationsLambda.name,
    };
  },
});
