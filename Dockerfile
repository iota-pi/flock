FROM node:22

RUN mkdir -p /flock
WORKDIR /flock
RUN corepack enable
COPY .yarnrc.yml package.json yarn.lock ./
RUN yarn install
COPY tsconfig.json vitest.config.ts ./
