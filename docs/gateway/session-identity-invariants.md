# Session Identity Invariants

These invariants are intended to catch gaps across `sessions.bootstrap`, `presence.init`,
`sessions.reset`, `transcript.read`, and related gateway session flows.

## Core invariants

- Real runtime session ids are never flattened. If the runtime reports `session_id = sess-live-main`,
  no flow may reinterpret that as `agent:main:sess-live-main` or collapse it to
  `agent:main:main`.
- Canonical session key and runtime session id stay distinct. A canonical store key identifies the
  store row; a runtime session id identifies the live runtime/transcript session.
- Accepted identity must be consumable everywhere. If one gateway method accepts
  `session_identity`, every session-targeting method must be able to resolve that same identity to
  the same logical session.
- Identity round-trips losslessly. If a method returns `session_identity`, a later method can feed
  it back unchanged and still target the same logical session.
- Agent scoping is strict. A runtime session id only resolves within its owning `agent_id`; there
  is no fallback to the default agent and no cross-agent match.
- One logical live session maps to one canonical row. Repeated bootstrap, presence, reset, and
  transcript operations must not create sibling rows for the same live session under different key
  shapes.
- Canonicalization is idempotent. Repeating the same operation should touch the same row instead of
  migrating identity or forking state.
- Live-session targeting beats filename heuristics. For the current live session, store identity
  must be sufficient to locate the logical session even before a transcript file exists.

## Lifecycle invariants

- Bootstrapping a live runtime id creates or touches the canonical row only. It never creates a
  synthetic row derived from the runtime session id.
- Reset against a live runtime id mutates the active canonical session. It must not reset a newly
  canonicalized fake key while leaving the active session untouched.
- Transcript reads for an idle but valid live session succeed with `entries: []`, not
  `session not found`.
- `No transcript yet` and `unknown session` are different states. The former is a successful empty
  read; the latter is an error.
- `lookup_type = context_id` and `lookup_type = session_id` agree when they refer to the same
  logical session.
- Reset, delete, compact, resolve, and read flows all preserve the real session identity rule and
  do not reintroduce `agent:<id>:main` flattening as observable truth.

## Store and transcript invariants

- The session store is the source of truth for canonical targeting and session existence.
- Transcript file presence is optional for a valid session, especially immediately after bootstrap
  or reconnect.
- If a store row references a runtime session id, transcript lookup for that live session still
  succeeds even if the `.jsonl` file does not exist yet.
- Legacy aliases may exist internally during migration, but externally visible targeting converges
  to one canonical row and one session identity.

## Test matrix

- `bootstrap(real snapshot id) -> transcript.read before any write => ok + empty entries`
- `bootstrap(real snapshot id) -> reset(using session_identity.session_id) => active canonical row reset, no synthetic row created`
- `presence.init(real snapshot id) -> transcript.read(context_id) => same live session`
- `context_id` and `session_id` lookups resolve the same logical session when aimed at the current
  session
- Non-default agent variants of all of the above
- Repeated bootstrap, presence, and reset cycles do not create extra rows or change resolved
  identity

## Review heuristic

When a schema or method starts accepting a richer identity shape, treat that as an integration
change, not a local validation change. The invariant to verify is that every downstream session
operation preserves the same logical session across identity forms, agent scope, and empty
transcript states.
