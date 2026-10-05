---
ticket: LINT-001
revision: 1
---

# Test Design — Lint Fixture: a classified design with no requirement gaps

# Summary

Scenarios: 3  |  Automatable: 3  |  Manual only: 0
Levels: Component 1, E2E API 1, E2E UI 1
Requirements: FR 2/2, AC 1/1 covered
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
Suggested Level: Component
Assigned Level: Component
Level Rationale: Rendering behaviour over a stubbed list response — factor 1, the bug lives in one template.
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

## SCN-003: The owner reaches the admin panel after signing in
Requirement: AC-1
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
Notes: API coverage: not needed — sign-in and the panel fetch are session mechanics for this journey; the admin-list authorization contract is covered by SCN-002.

# Traceability Matrix

| Requirement | Scenarios |
|---|---|
| FR-1.1 | SCN-001 |
| FR-1.2 | SCN-002 |
| AC-1 | SCN-003 |

# Coverage Matrix

| Category | Scenarios |
|---|---|
| Happy path | SCN-001, SCN-003 |
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
| Oracles | the admin list rendering | SCN-001 |
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
| E2E UI | 1 | SCN-003 |

Scenarios: 3 total, 3 assigned, 0 unassigned.
Multi-level scenarios: — none
Overridden suggestions: — none
E2E tests implied: E2E API 1, E2E UI 1.
E2E journeys: — none
Demoted by the minimum-set pass: — none
Folded by the minimum-set pass: — none

## Handed Off As Follow-Up Work

Scenarios at levels not implemented in this repository. Kept here for traceability.

| Scenario | Assigned Level | Requirement |
|---|---|---|
| SCN-001 | Component | FR-1.1 |
