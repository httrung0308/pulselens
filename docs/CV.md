# PulseLens CV Notes

## One-Line Project Pitch

PulseLens is an AI incident war-room that replays a checkout outage, streams OpenTelemetry-style telemetry, ranks root-cause hypotheses with cited evidence, and generates postmortems.

## Best-Fit Roles

- AI Full-stack Engineer
- Full-stack AI Engineer
- Software Engineer, Observability
- Backend Engineer, Platform
- LLM Application Engineer

## CV Bullets

- Built an AI incident war-room with Next.js, TypeScript, FastAPI, and WebSocket streaming to replay OpenTelemetry-style logs, metrics, and traces.
- Implemented evidence-cited root-cause ranking for a checkout outage, correlating payment latency, checkout 504s, and retry queue amplification.
- Added deterministic mock AI mode, citation coverage metadata, SQLite/Postgres-ready persistence, and a generated postmortem export workflow.

## Interview Talking Points

- Why mock AI exists: reproducible demos without API cost or nondeterministic outputs.
- Why every hypothesis has evidence IDs: avoid unsupported AI claims.
- Why WebSocket is used: backend streams telemetry as the incident replay unfolds.
- Why SQLite by default: local demo should work in one minute.
- Why Postgres/pgvector is prepared: production path for durable telemetry and future semantic evidence search.
- Why CI matters: proves the backend analyzer, frontend types, production build, and Docker Compose config are continuously checked.
