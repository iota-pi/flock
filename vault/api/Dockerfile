FROM node:20

RUN mkdir -p /flock/vault
WORKDIR /flock/vault
COPY package*.json yarn*.lock ./
RUN corepack enable
RUN yarn install
