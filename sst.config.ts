/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "flock",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
    };
  },
  async run() {
    // Frontend deployed via Cloudflare Pages
    // Backend (Lambda, DynamoDB, API Gateway) remains managed by Terraform in infra/vault/

    // VAULT_ENDPOINT is passed from Terraform output via CI/CD
    const vaultEndpoint = process.env.VAULT_ENDPOINT || "http://localhost:4000";

    const domain = $app.stage === "production"
      ? "flock.cross-code.org"
      : `${$app.stage}.flock.cross-code.org`;
    const publicUrl = `https://${domain}`;

    const app = new sst.cloudflare.StaticSite("FlockApp", {
      path: ".",
      build: {
        command: "yarn build",
        output: "dist/app",
      },
      domain,
      environment: {
        VITE_VAULT_ENDPOINT: vaultEndpoint,
        VITE_PUBLIC_URL: publicUrl,
      },
    });

    return {
      appUrl: app.url,
    };
  },
});
