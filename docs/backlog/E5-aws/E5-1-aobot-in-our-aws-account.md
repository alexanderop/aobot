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
- Model on Bedrock through the task's IAM role
- Telemetry to the AWS OpenTelemetry collector

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

## Reference

OpenBot `docs/deployment.md` § AWS.
