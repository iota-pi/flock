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

    const publicUrl = $app.stage === "production"
      ? "https://flock.cross-code.org"
      : `https://${$app.stage}.flock.cross-code.org`;

    const app = new sst.cloudflare.StaticSite("FlockApp", {
      path: ".",
      build: {
        command: "yarn build",
        output: "dist/app",
      },
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
