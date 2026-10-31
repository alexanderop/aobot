---
title: E5 · AWS
description: Move from laptop to our AWS account by swapping configuration and providers. Code paths stay the same.
---

# E5 · AWS

Move from laptop to our AWS account by swapping configuration and providers. Code paths stay the same.

**Epic demo:** The desktop app talks to aobot in AWS, Bots run on the chosen model provider, each person's computer is an ECS task, and none can reach AWS credentials.

| Ticket                                                  | Title                                     | Depends on | Estimate |
| ------------------------------------------------------- | ----------------------------------------- | ---------- | -------- |
| [E5-1](E5-1-aobot-in-our-aws-account.md)                | aobot in our AWS account                  | E3-1, E0-2 | 5d       |
| [E5-2](E5-2-computers-as-ecs-tasks.md)                  | Computers as ECS tasks                    | E5-1, E3-3 | 4d       |
| [E5-3](E5-3-computers-cannot-reach-aws-credentials.md)  | Computers cannot reach AWS credentials    | E5-2       | 2d       |
| [E5-4](E5-4-kubernetes-provider-when-we-outgrow-ecs.md) | Kubernetes provider (when we outgrow ECS) | E5-3       | 5d       |
