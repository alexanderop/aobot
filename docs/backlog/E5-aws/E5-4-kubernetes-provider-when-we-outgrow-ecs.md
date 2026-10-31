---
id: E5-4
title: Kubernetes provider (when we outgrow ECS)
description: As the platform team, we run computers on EKS with suspend and resume, when ECS tasks become too slow or too costly.
epic: E5
status: todo
depends_on: [E5-3]
estimate: 5d
---

# E5-4 · Kubernetes provider (when we outgrow ECS)

**Story:** As the platform team, we run computers on EKS with suspend and resume, when ECS tasks become too slow or too costly.

## Scope

In:

- `k8s` provider using `kubernetes-sigs/agent-sandbox`
- IMDSv2 with hop limit 1 on nodes, NetworkPolicy enforced by the VPC CNI
- Passes the full contract suite

Out:

- Do this only when ECS limits us. It is optional.

## Demo

1. Set `COMPUTER_PROVIDER=k8s`.
2. Run the E1 and E3 demos against EKS.

## Layers

infra · server

## Audit

Same as local.

## Telemetry

Same as local.

## Tests

- Tier 3: the full contract suite against `k8s`.

## Reference

OpenBot `charts/openbot/README.md`.
