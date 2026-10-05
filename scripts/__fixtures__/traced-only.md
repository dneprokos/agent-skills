---
ticket: LINT-007
revision: 1
---

# Test Design — Lint Fixture: traced-only coverage items

# Summary

Scenarios: 3  |  Automatable: 2  |  Manual only: 1
Levels: _pending classification._
Requirements: FR 3/3, AC 0/0 covered
Techniques: EP 2/4 (1 traced-only), BVA n/a, DT n/a, ST n/a

# Scenarios

## SCN-001: The panel after a delete that the server refuses
Requirement: FR-1.1
Category: Error handling
Technique: Equivalence Partitioning
Coverage Item: EP-1, EP-2
Priority: Medium
Preconditions: An admin account exists and the delete is refused by the server.
Action: The owner deletes the admin account.
Expected: Not assertable — the requirements do not state what the panel shows once a delete is refused.
Suggested Level: E2E UI
Automation Suitability: Manual only
Notes: unknown: what the panel shows once a delete is refused — not assertable; API coverage: not needed — the backend refusal only sets up the unspecified UI outcome.

## SCN-002: The owner reaches the admin panel after signing in
Requirement: FR-1.2
Category: Happy path
Technique: Equivalence Partitioning
Coverage Item: EP-2
Priority: High
Preconditions: An owner account exists.
Action: The owner signs in and navigates to the admin panel.
Expected: The admin panel is reached and lists the existing admin accounts.
Suggested Level: E2E UI
Automation Suitability: High
Notes: API coverage: not needed — UI navigation and rendering only; no independent backend contract selected.

## SCN-003: A signed-out visitor is refused the admin panel
Requirement: FR-1.3
Category: Permission / authorization
Technique: Equivalence Partitioning
Coverage Item: EP-3
Priority: High
Preconditions: No session exists.
Action: A signed-out visitor opens the admin panel.
Expected: The sign-in page is shown and no admin account is listed.
Suggested Level: E2E UI
Automation Suitability: High
Notes: API coverage: not needed — UI authorization rendering only; no independent backend contract selected.

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-1.1 | SCN-001 |
| FR-1.2 | SCN-002 |
| FR-1.3 | SCN-003 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-002 |
| Negative path | _Not applicable — no scenario in this fixture carries it._ |
| Boundary | _Not applicable — no scenario in this fixture carries it._ |
| Validation rules | _Not applicable — no scenario in this fixture carries it._ |
| Error handling | SCN-001 |
| Permission / authorization | SCN-003 |
| Data | _Not applicable — no scenario in this fixture carries it._ |
| Integration | _Not applicable — no scenario in this fixture carries it._ |
| Retry / timeout | _Not applicable — no scenario in this fixture carries it._ |
| State transition | _Not applicable — no scenario in this fixture carries it._ |
| Non-functional | _Not applicable — no scenario in this fixture carries it._ |
| Regression impact | _Not applicable — no scenario in this fixture carries it._ |

# Technique Coverage Matrix

| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |
|---|---|---|---|---|---|
| Equivalence Partitioning | 4 | 2 | 1 | 50% | EP-4 |
| Boundary Value Analysis | 0 | 0 | 0 | — | — |
| Decision Table Testing | 0 | 0 | 0 | — | — |
| State Transition Testing | 0 | 0 | 0 | — | — |

# Coverage Gaps

- SCN-001 — the requirements do not state the panel's behaviour once a delete is refused. The scenario is recorded for traceability and carries no assertable outcome.
- EP-1 is cited only by SCN-001, which asserts nothing, so the partition is traced rather than exercised. EP-2 is cited by SCN-002 as well, so it is genuinely exercised.
- EP-4 is declared and cited by no scenario at all — the signed-in non-owner role has no scenario in this fixture.

# Approved Assumptions

_None._

# Test Basis Research

| Aspect | Findings | Feeds |
|---|---|---|
| Actors & roles | owner, signed-out visitor, signed-in non-owner | EP-2, EP-3, EP-4 |
| Entities & states | — none stated | — |
| Inputs | the delete outcome | EP-1 |
| Limits | — none stated | — |
| Oracles | the admin panel rendering | SCN-002, SCN-003 |
| Permissions | the admin panel is owner-only | EP-3, EP-4 |
| Dependencies | — none stated | — |
| Data lifetime | — none stated | — |
| Domain terms | — none stated | — |
| Unknowns | the panel's behaviour once a delete is refused | SCN-001, # Coverage Gaps |

# Test Basis Analysis

## Equivalence Partitions

| Id | Parameter | Partition | Valid |
|---|---|---|---|
| EP-1 | delete outcome | refused by the server | no |
| EP-2 | role | owner | yes |
| EP-3 | role | signed-out visitor | no |
| EP-4 | role | signed-in non-owner | no |

## Boundary Values

_Not applicable — this fixture states no ordered limit._

## Decision Tables

_Not applicable — this fixture states no multi-condition rule._

## State Transitions

_Not applicable — this fixture states no entity state model._
