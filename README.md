# Flock

Flock is Pastoral Relationship Management software (PRM). Our prayer is that
Flock will help you to care diligently for the flock of God that is among you.

## Set up

Requirements:
1. Node & Yarn
1. Docker & Docker Compose

```shell script
cd app
yarn install
cd ../vault
yarn install
docker-compose up -d
yarn docker:initdb
```

## Run development server
```shell script
cd app
yarn start
```

## Repo Anatomy

The repository has two main subdirectories:
1. `app` contains the front-end code written with React & Typescript
2. `vault` contains the storage and API code written with Typescript
