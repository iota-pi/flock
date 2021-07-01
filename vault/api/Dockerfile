FROM node:14

RUN mkdir -p /flock/vault
WORKDIR /flock/vault
COPY package*.json ./
RUN yarn install
