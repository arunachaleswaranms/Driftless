# Driftless Planning Documents

## Master baseline

[Driftless_Master_Project_Plan_v0.1.docx](Driftless_Master_Project_Plan_v0.1.docx) is the original comprehensive project plan and PRD-style baseline. It is retained as written; it is not the live execution log. Its Phase 0 checklist includes physical Android and real-network evidence. Phase 0 closed its **software-feasibility** gate after independent review, while those physical/network criteria remain open and deferred. The [roadmap](../ROADMAP.md) records this distinction without changing the master baseline.

## Current authoritative records

| Topic | Document |
| --- | --- |
| Current execution status and open debt | [PROJECT_STATE.md](../../PROJECT_STATE.md) |
| Phase progression and exit gates | [ROADMAP.md](../ROADMAP.md) |
| Product purpose, scope, and exclusions | [PROJECT_CHARTER.md](../PROJECT_CHARTER.md) |
| Accepted high-level architecture | [ARCHITECTURE.md](../ARCHITECTURE.md) and [ADRs](../adr/) |
| Conceptual protocol | [PROTOCOL.md](../PROTOCOL.md) |
| Planned media pipeline and Phase 0 observations | [MEDIA_PIPELINE.md](../MEDIA_PIPELINE.md) |
| Security requirements | [SECURITY.md](../SECURITY.md) |
| Test strategy | [TEST_PLAN.md](../TEST_PLAN.md) |
| Product compatibility policy | [COMPATIBILITY.md](../COMPATIBILITY.md) |
| Phase 0 empirical feasibility evidence | [Spike results](../../spikes/phase0/) |
| Phase 1 exit-gate qualification evidence | [PHASE1_QUALIFICATION.md](../PHASE1_QUALIFICATION.md) |
| Phase 2 physical/network qualification evidence and deferred gaps | [PHASE2_QUALIFICATION.md](../PHASE2_QUALIFICATION.md) |
| Deployment boundary (HTTPS/WSS, TURN) | [DEPLOYMENT.md](../DEPLOYMENT.md) |

The master plan remains the historical baseline. Accepted architecture decisions live in the ADRs; current execution state lives in `PROJECT_STATE.md`; detailed phase progression lives in `ROADMAP.md`; and observed Phase 0 results live with the spikes. A controlled spike result does not establish product compatibility or close deferred physical and network qualification.

Phase 2 implementation is MERGED / COMPLETE at `2dd7dea8798bcfc742c8902e853cef69c053eecd`; its physical/network qualification is DEFERRED / NOT CLOSED and the literal physical exit gate is NOT PASSED. Phase 3 — Local Sync Mode is IN PROGRESS on `phase/3-local-sync`. Phase 3A implements identity/readiness; 3B–3D are NOT STARTED and the Phase 3 exit gate is NOT PASSED. The deferred Phase 2 gates remain mandatory before final product/release qualification and must not be inferred from later software milestones.
