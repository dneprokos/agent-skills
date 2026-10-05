---
ticket: LINT-002
revision: 1
---

# Test Design — Lint Fixture: Manual only at a level below E2E

# Summary

Scenarios: 2  |  Automatable: 1  |  Manual only: 1
Levels: Component 1, E2E UI 1
Requirements: FR 2/2, AC 0/0 covered
Techniques: EP 2/2, BVA n/a, DT n/a, ST n/a

# Scenarios

## SCN-001: A long display name is truncated in the admin row
Requirement: FR-1.1
Category: Data
Technique: Equivalence Partitioning
Coverage Item: EP-1
Priority: Medium
Preconditions: An admin account whose display name exceeds the column width exists.
Action: The owner opens the admin panel.
Expected: The row shows the display name truncated, with the full value available on hover.
Suggested Level: Component
Assigned Level: Component
Level Rationale: Display behaviour over a stubbed row; manual-only because the current setup cannot create the required data safely, not because this requires E2E.
Automation Suitability: Manual only
Notes: The oversized account cannot be seeded through any available route, so the data has to be arranged by hand.

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
Assigned Level: E2E UI
Level Rationale: A journey across routes with a real session — factor 3, no stub reproduces it.
Automation Suitability: High
Notes: API coverage: not needed — UI navigation and rendering only; no independent backend contract selected.

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-1.1 | SCN-001 |
| FR-1.2 | SCN-002 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-002 |
| Negative path | _Not applicable — no scenario in this fixture carries it._ |
| Boundary | _Not applicable — no scenario in this fixture carries it._ |
| Validation rules | _Not applicable — no scenario in this fixture carries it._ |
| Error handling | _Not applicable — no scenario in this fixture carries it._ |
| Permission / authorization | _Not applicable — no scenario in this fixture carries it._ |
| Data | SCN-001 |
| Integration | _Not applicable — no scenario in this fixture carries it._ |
| Retry / timeout | _Not applicable — no scenario in this fixture carries it._ |
| State transition | _Not applicable — no scenario in this fixture carries it._ |
| Non-functional | _Not applicable — no scenario in this fixture carries it._ |
| Regression impact | _Not applicable — no scenario in this fixture carries it._ |

# Technique Coverage Matrix

| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |
|---|---|---|---|---|---|
| Equivalence Partitioning | 2 | 2 | 0 | 100% | — |
| Boundary Value Analysis | 0 | 0 | 0 | — | — |
| Decision Table Testing | 0 | 0 | 0 | — | — |
| State Transition Testing | 0 | 0 | 0 | — | — |

# Coverage Gaps

_None._

# Approved Assumptions

_None._

# Test Basis Research

| Aspect | Findings | Feeds |
|---|---|---|
| Actors & roles | owner | EP-2 |
| Entities & states | — none stated | — |
| Inputs | display name length | EP-1 |
| Limits | — none stated | — |
| Oracles | the admin row rendering | SCN-001 |
| Permissions | — none stated | — |
| Dependencies | — none stated | — |
| Data lifetime | — none stated | — |
| Domain terms | — none stated | — |
| Unknowns | — none stated | — |

# Test Basis Analysis

## Equivalence Partitions

| Id | Parameter | Partition | Valid |
|---|---|---|---|
| EP-1 | display name | longer than the column width | yes |
| EP-2 | role | owner | yes |

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
| Unit | 0 | — |
| Component | 1 | SCN-001 |
| Integration | 0 | — |
| E2E API | 0 | — |
| E2E UI | 1 | SCN-002 |

Scenarios: 2 total, 2 assigned, 0 unassigned.
Multi-level scenarios: — none
Overridden suggestions: — none
E2E tests implied: E2E API 0, E2E UI 1.
E2E journeys: — none
Demoted by the minimum-set pass: — none
Folded by the minimum-set pass: — none

## Handed Off As Follow-Up Work

Scenarios at levels not implemented in this repository. Kept here for traceability.

| Scenario | Assigned Level | Requirement |
|---|---|---|
| SCN-001 | Component | FR-1.1 |
