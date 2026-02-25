---
title: "HEARTBEAT.md Template"
summary: "Workspace template for HEARTBEAT.md"
read_when:
  - Bootstrapping a workspace manually
---

# HEARTBEAT.md

## Canonical Heartbeat Loop

1. Emit Process A telemetry payload (liveness, token pressure, runtime ref).
2. Emit Process B delivery payload (lane, task, lifecycle state, proof delta).
3. Emit Process C verification payload when lane requires artifacts.
4. Run strategic compact check and apply cooldown guidance.
5. Escalate only actionable deltas (new blocker, stale state, failed verification).

## Runtime Rules

- Default cadence: 15 minutes.
- Release-critical lanes: 10 minutes.
- Research/spec lanes: 30 minutes.
- Active implementation/release tasks without proof delta for 45 minutes become `stalled`.
- Research/spec tasks without proof delta for 90 minutes become `stalled`.

## Delivery Validation

- `schema_version` and `process_id` are required.
- `task_state=active|proof_submitted` requires `proof_type`, `proof_ref`, `delta_summary`.
- Invalid Process B payloads must be retried next heartbeat with NAK reason codes resolved.
