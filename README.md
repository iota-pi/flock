# Flock

Flock is Pastoral Relationship Management (PRM) software. Our prayer is that
Flock will help you to care diligently for the flock of God that is among you.

## Intent

Flock is intended as a tool to help you to care for and serve your people.
As such it designed to be used by multiple users, or to share data between
users.

Because Flock is a personal tool, the data you enter should not belong to your
organisation or church.

## Security

Any data you enter is stored encrypted using "client-side encryption"
(sometimes also referred to as end-to-end encryption). Practically speaking,
this means that there is no way for anyone (including you) to read or recover
your data without your password (and the account ID generated when you create
your account).

As such, the security of Flock can only be as good as your own online security.
We **strongly** recommend using a password manager to create and remember a
strong password and your account ID.

Similarly, leaving your laptop unattended and unlocked while logged in to Flock
would be unwise.

## Disclaimer

Flock is free software, provided as-is, with no guarantee of data retention,
security, or availability. By choosing to use Flock, you agree that the
creators and contributors shall not be liable for any damages or losses
related to or resulting from the use of Flock.

# Development

This repository is for the development of Flock, if you would like to use Flock,
please go to [flock.cross-code.org](https://flock.cross-code.org/).

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

* `app` contains the front-end code written with React & Typescript
* `vault` contains the storage and API code written with Typescript
* `infra` contains IAC (Infrastructure As Code) using Terraform
* `deploy` contains bash scripts to deploy the infrastructure
  (credentials required)
