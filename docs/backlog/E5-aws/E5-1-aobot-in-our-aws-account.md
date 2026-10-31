---
id: E5-1
title: aobot in our AWS account
epic: E5
status: todo
depends_on: [E3-1, E0-2]
estimate: 5d
---

# E5-1 · aobot in our AWS account

**Story:** As a colleague, I point the desktop app at the company URL and chat with Bots running in our AWS account.

## Scope

In:

- Infrastructure as code (tool chosen in this ticket)
- Server on ECS Fargate behind an ALB with HTTPS
- RDS Postgres with pgvector, private subnets
- Secrets in AWS Secrets Manager, read through `Config`
- `AGENT_RUNTIME=api` only; `acp` is refused here
- Model provider chosen in this ticket. `effect/ai` has no Bedrock provider: either a provider's API key in
  Secrets Manager, Bedrock's OpenAI-compatible endpoint through `openai-compat` (check it works with the
  task's IAM role), or a small Bedrock provider of our own
- Migrations run as a release step before the new tasks start, never at server start-up
- Telemetry to the AWS OpenTelemetry collector
- `sslmode` on `DATABASE_URL` turns on TLS; an unknown mode stops start-up

Out:

- Computers on AWS (E5-2); until then, chat without computer tools

## Demo

1. Point the desktop app at the AWS URL and sign in.
2. Chat with a Bot.
3. The trace shows up in the AWS tracing backend.

## Layers

infra · server

## Audit

None new.

## Telemetry

Same spans as local, in the AWS backend.

## Tests

- Tier 4: the E0-1 demo against the AWS URL, run from CI after deploy.
- Tier 2: `sslmode=require` gives a TLS connection; `sslmode=bogus` fails at boot.

## Reference

- OpenBot `docs/deployment.md` § AWS.
- OpenBot #746 (`sslmode` sent to Postgres as a parameter, unencrypted on RDS).
