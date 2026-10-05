---
ticket: LINT-006
revision: 1
---

# Test Design — Lint Fixture: Requirement Gap where only a test level belongs

# Summary

Scenarios: 2  |  Automatable: 2  |  Manual only: 0
Levels: Component 1, E2E API 1
Requirements: FR 2/2, AC 0/0 covered
Techniques: EP 2/2, BVA n/a, DT n/a, ST n/a

# Scenarios

## SCN-001: Admin row renders its three columns
Requirement: FR-1.1
Category: Happy path
Technique: Equivalence Partitioning
Coverage Item: EP-1
Priority: High
Preconditions: One admin account exists.
Action: The owner opens the admin panel.
Expected: The admin row shows the name, the e-mail address and the role.
Suggested Level: Requirement Gap
Assigned Level: Component
Level Rationale: The suggestion is the defect here — `Suggested Level:` takes a test level and nothing else.
Automation Suitability: High
Notes: —

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

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-1.1 | SCN-001 |
| FR-1.2 | SCN-002 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-001 |
| Negative path | _Not applicable — no scenario in this fixture carries it._ |
| Boundary | _Not applicable — no scenario in this fixture carries it._ |
| Validation rules | _Not applicable — no scenario in this fixture carries it._ |
| Error handling | _Not applicable — no scenario in this fixture carries it._ |
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
| Actors & roles | owner, visitor | EP-1, EP-2 |
| Entities & states | — none stated | — |
| Inputs | role | EP-1, EP-2 |
| Limits | — none stated | — |
| Oracles | the admin row rendering | SCN-001 |
| Permissions | the admin list is owner-only | SCN-002 |
| Dependencies | — none stated | — |
| Data lifetime | — none stated | — |
| Domain terms | — none stated | — |
| Unknowns | — none stated | — |

# Test Basis Analysis

## Equivalence Partitions

| Id | Parameter | Partition | Valid |
|---|---|---|---|
| EP-1 | role | owner | yes |
| EP-2 | role | visitor | no |

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
| E2E API | 1 | SCN-002 |
| E2E UI | 0 | — |

Scenarios: 2 total, 2 assigned, 0 unassigned.
Multi-level scenarios: — none
Overridden suggestions: SCN-001 (Requirement Gap -> Component)
E2E tests implied: E2E API 1, E2E UI 0.
E2E journeys: — none
Demoted by the minimum-set pass: — none
Folded by the minimum-set pass: — none

## Handed Off As Follow-Up Work

Scenarios at levels not implemented in this repository. Kept here for traceability.

| Scenario | Assigned Level | Requirement |
|---|---|---|
| SCN-001 | Component | FR-1.1 |