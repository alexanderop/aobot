---
id: E5-3
title: Computers cannot reach AWS credentials
epic: E5
status: todo
depends_on: [E5-2]
estimate: 2d
---

# E5-3 · Computers cannot reach AWS credentials

**Story:** As security, I know a Bot's shell cannot take our AWS credentials or reach internal services.

## Scope

In:

- The computer task gets no task role
- Block `169.254.169.254` and `169.254.170.2` from the computer
- Egress through a proxy with an allowlist per Bot
- Security groups: only the server reaches computers
- Until a Bot's network policy has reached its computer, every connection is refused
- The same resolved-address filter as E1-1, so ECS and Docker refuse the same addresses

Out:

- Nothing excluded.

## Demo

1. Ask the Bot to run `curl -m 3 169.254.169.254` and `curl -m 3 169.254.170.2`.
2. Both fail.
3. A site outside the Bot's allowlist fails too.

## Layers

infra · computer

## Audit

The `run` rows, allowed by policy but failing at the network.

## Telemetry

None new.

## Tests

- Tier 3: contract cases for blocked addresses (the docker provider blocks them too).
- Tier 4: the demo against AWS.

## Reference

OpenBot PR #620 and `agent-computer/src/egress.ts`.
