---
ticket: LINT-005
revision: 1
---

# Test Design — Lint Fixture: requirement gaps beside E2E and handed-off work

# Summary

Scenarios: 4  |  Automatable: 4  |  Manual only: 0
Levels: Unit 1, E2E API 1, E2E UI 1, Requirement Gap 1
Requirements: FR 4/4, AC 0/0 covered
Techniques: EP 4/4, BVA n/a, DT n/a, ST n/a

# Scenarios

## SCN-001: The owner reaches the admin panel after signing in
Requirement: FR-1.1
Category: Happy path
Technique: Equivalence Partitioning
Coverage Item: EP-1
Priority: High
Preconditions: An owner account exists.
Action: The owner signs in and navigates to the admin panel.
Expected: The admin panel is reached and lists the existing admin accounts.
Suggested Level: E2E UI
Assigned Level: E2E UI
Level Rationale: A journey across routes with a real session — factor 3, no stub reproduces it.
Automation Suitability: High
Notes: API coverage: not needed — UI navigation and rendering only; no independent backend contract selected.

## SCN-002: A visitor is refused the admin list
Requirement: FR-1.2
Category: Permission / authorization
Technique: Equivalence Partitioning
Coverage Item: EP-2
Priority: High
Preconditions: No session is established.
Action: A visitor requests the admin list.
Expected: The request is refused and no admin data is returned.
Suggested Level: E2E API
Assigned Level: E2E API
Level Rationale: An authorization boundary is only real at the public surface — factor 1.
Automation Suitability: High
Notes: —

## SCN-003: An e-mail address missing its domain is rejected
Requirement: FR-1.3
Category: Validation rules
Technique: Equivalence Partitioning
Coverage Item: EP-3
Priority: Medium
Preconditions: The owner is creating an admin account.
Action: The owner submits an e-mail address with no domain part.
Expected: The address is rejected and no account is created.
Suggested Level: E2E API
Assigned Level: Unit
Level Rationale: A self-contained format predicate — factor 1, the bug lives in one comparator.
Automation Suitability: High
Notes: —

## SCN-004: The panel after a delete that the server refuses
Requirement: FR-1.4
Category: Error handling
Technique: Equivalence Partitioning
Coverage Item: EP-4
Priority: Medium
Preconditions: An admin account exists and the delete is refused by the server.
Action: The owner deletes the admin account.
Expected: Not assertable — the requirements do not state what the panel shows once a delete is refused.
Suggested Level: E2E UI
Assigned Level: Requirement Gap
Level Rationale: Requirement gap — the scenario records missing expected behavior, so it is not executable coverage until the oracle is specified.
Automation Suitability: High
Notes: unknown: what the panel shows once a delete is refused — not assertable; API coverage: not needed — the backend refusal only sets up the unspecified UI outcome.

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-1.1 | SCN-001 |
| FR-1.2 | SCN-002 |
| FR-1.3 | SCN-003 |
| FR-1.4 | SCN-004 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-001 |
| Negative path | _Not applicable — no scenario in this fixture carries it._ |
| Boundary | _Not applicable — no scenario in this fixture carries it._ |
| Validation rules | SCN-003 |
| Error handling | SCN-004 |
| Permission / authorization | SCN-002 |
| Data | _Not applicable — no scenario in this fixture carries it._ |
| Integration | _Not applicable — no scenario in this fixture carries it._ |
| Retry / timeout | _Not applicable — no scenario in this fixture carries it._ |
| State transition | _Not applicable — no scenario in this fixture carries it._ |
| Non-functional | _Not applicable — no scenario in this fixture carries it._ |
| Regression impact | _Not applicable — no scenario in this fixture carries it._ |

# Technique Coverage Matrix

| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |
|---|---|---|---|---|---|
| Equivalence Partitioning | 4 | 4 | 0 | 100% | — |
| Boundary Value Analysis | 0 | 0 | 0 | — | — |
| Decision Table Testing | 0 | 0 | 0 | — | — |
| State Transition Testing | 0 | 0 | 0 | — | — |

# Coverage Gaps

- SCN-004 — the requirements do not state the panel's behaviour once a delete is refused. The scenario is recorded for traceability and carries no assertable outcome.

# Approved Assumptions

_None._

# Test Basis Research

| Aspect | Findings | Feeds |
|---|---|---|
| Actors & roles | owner, visitor | EP-1, EP-2 |
| Entities & states | — none stated | — |
| Inputs | e-mail address, the delete outcome | EP-3, EP-4 |
| Limits | — none stated | — |
| Oracles | the admin panel rendering | SCN-001 |
| Permissions | the admin list is owner-only | SCN-002 |
| Dependencies | — none stated | — |
| Data lifetime | — none stated | — |
| Domain terms | — none stated | — |
| Unknowns | the panel's behaviour once a delete is refused | SCN-004, # Coverage Gaps |

# Test Basis Analysis

## Equivalence Partitions

| Id | Parameter | Partition | Valid |
|---|---|---|---|
| EP-1 | role | owner | yes |
| EP-2 | role | visitor | no |
| EP-3 | e-mail address | no domain part | no |
| EP-4 | delete outcome | refused by the server | no |

## Boundary Values

_Not applicable — this fixture states no ordered limit._

## Decision Tables

_Not applicable — this fixture states no multi-condition rule._

## State Transitions

_Not applicable — this fixture states no entity state model._

# Level Assignment Summary

_Levels assigned by the classification step. Suggested Level lines above are the original proposals and are preserved deliberately._

| Level | Count | Scenarios |
|---|---|---|
| Unit | 1 | SCN-003 |
| Component | 0 | — |
| Integration | 0 | — |
| E2E API | 1 | SCN-002 |
| E2E UI | 1 | SCN-001 |
| Requirement Gap | 1 | SCN-004 |

Scenarios: 4 total, 4 assigned, 0 unassigned.
Executable coverage: 3 scenario(s) at a testing level; 1 recorded as Requirement Gap and excluded from every E2E figure.
Multi-level scenarios: — none
Overridden suggestions: SCN-003 (E2E API -> Unit), SCN-004 (E2E UI -> Requirement Gap)
E2E tests implied: E2E API 1, E2E UI 1.
E2E journeys: — none
Demoted by the minimum-set pass: — none
Folded by the minimum-set pass: — none

## Handed Off As Follow-Up Work

Scenarios at levels not implemented in this repository. Kept here for traceability.

| Scenario | Assigned Level | Requirement |
|---|---|---|
| SCN-003 | Unit | FR-1.3 |

## Blocked / Requirement Gaps

Scenarios whose `Expected:` records a missing or unassertable oracle. Not automation work and not coverage at any level — the requirement has to be specified before a level applies.

| Scenario | Requirement | Expected |
|---|---|---|
| SCN-004 | FR-1.4 | Not assertable — the requirements do not state what the panel shows once a delete is refused. |
