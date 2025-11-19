FROM node:22

RUN mkdir -p /flock/vault
WORKDIR /flock/vault
RUN corepack enable
COPY vault/.yarnrc.yml vault/package.json vault/yarn.lock ./
RUN yarn install
COPY vault/tsconfig.json vault/vitest.config.ts ./
