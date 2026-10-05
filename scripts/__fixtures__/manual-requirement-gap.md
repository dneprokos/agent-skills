---
ticket: LINT-003
revision: 1
---

# Test Design — Lint Fixture: Manual only on a requirement gap

# Summary

Scenarios: 2  |  Automatable: 1  |  Manual only: 1
Levels: E2E UI 1, Requirement Gap 1
Requirements: FR 2/2, AC 0/0 covered
Techniques: EP 1/2 (1 traced-only), BVA n/a, DT n/a, ST n/a

# Scenarios

## SCN-001: The panel after a delete that the server refuses
Requirement: FR-1.1
Category: Error handling
Technique: Equivalence Partitioning
Coverage Item: EP-1
Priority: Medium
Preconditions: An admin account exists and the delete is refused by the server.
Action: The owner deletes the admin account.
Expected: Not assertable — the requirements do not state what the panel shows once a delete is refused.
Suggested Level: E2E UI
Assigned Level: Requirement Gap
Level Rationale: Requirement gap — the scenario records missing expected behavior, so it is not executable coverage until the oracle is specified.
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
| Error handling | SCN-001 |
| Permission / authorization | _Not applicable — no scenario in this fixture carries it._ |
| Data | _Not applicable — no scenario in this fixture carries it._ |
| Integration | _Not applicable — no scenario in this fixture carries it._ |
| Retry / timeout | _Not applicable — no scenario in this fixture carries it._ |
| State transition | _Not applicable — no scenario in this fixture carries it._ |
| Non-functional | _Not applicable — no scenario in this fixture carries it._ |
| Regression impact | _Not applicable — no scenario in this fixture carries it._ |

# Technique Coverage Matrix

| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |
|---|---|---|---|---|---|
| Equivalence Partitioning | 2 | 1 | 1 | 50% | — |
| Boundary Value Analysis | 0 | 0 | 0 | — | — |
| Decision Table Testing | 0 | 0 | 0 | — | — |
| State Transition Testing | 0 | 0 | 0 | — | — |

# Coverage Gaps

- SCN-001 — the requirements do not state the panel's behaviour once a delete is refused. The scenario is recorded for traceability and carries no assertable outcome.
- EP-1 is cited only by SCN-001, which asserts nothing, so the partition is traced rather than exercised. It stays uncovered in substance until the refused-delete behaviour is stated.

# Approved Assumptions

_None._

# Test Basis Research

| Aspect | Findings | Feeds |
|---|---|---|
| Actors & roles | owner | EP-2 |
| Entities & states | — none stated | — |
| Inputs | the delete outcome | EP-1 |
| Limits | — none stated | — |
| Oracles | the admin panel rendering | SCN-002 |
| Permissions | — none stated | — |
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
| Component | 0 | — |
| Integration | 0 | — |
| E2E API | 0 | — |
| E2E UI | 1 | SCN-002 |
| Requirement Gap | 1 | SCN-001 |

Scenarios: 2 total, 2 assigned, 0 unassigned.
Executable coverage: 1 scenario(s) at a testing level; 1 recorded as Requirement Gap and excluded from every E2E figure.
Multi-level scenarios: — none
Overridden suggestions: SCN-001 (E2E UI -> Requirement Gap)
E2E tests implied: E2E API 0, E2E UI 1.
E2E journeys: — none
Demoted by the minimum-set pass: — none
Folded by the minimum-set pass: — none

## Handed Off As Follow-Up Work

Scenarios at levels not implemented in this repository. Kept here for traceability.

_None._

## Blocked / Requirement Gaps

Scenarios whose `Expected:` records a missing or unassertable oracle. Not automation work and not coverage at any level — the requirement has to be specified before a level applies.

| Scenario | Requirement | Expected |
|---|---|---|
| SCN-001 | FR-1.1 | Not assertable — the requirements do not state what the panel shows once a delete is refused. |
