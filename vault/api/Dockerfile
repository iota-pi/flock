FROM node:20

RUN mkdir -p /flock/vault
WORKDIR /flock/vault
RUN corepack enable
COPY vault/package.json vault/yarn.lock ./
RUN yarn install
