# `docs/automation/` — the shared references

Everything in this folder is **read at run time by a step of the QA workflow**, from disk, by path.
None of it is documentation about the workflow; it is the workflow's own working knowledge, kept
outside the step that uses it.

## Why a folder of documents at all

**Because a skill is invisible to a subagent.** Every agent file declares an explicit `tools:` list,
and none of them includes `Skill`. A step that needs shared knowledge can `Read` a file or carry the
text inline — there is no third option. So anything two steps must agree on lives here as a document.

**Because two inline copies drift, and nothing reports it.** The etalons exist because that already
happened: the review step's calibration block used a request form the implementing step's own
instructions banned. The review was grading against a shape its counterpart was forbidden to write,
and neither file was wrong on its own terms. One file, two readers, is the fix — *the rule a
document is written against and the rule it is reviewed against must be the same words.*

**Not to save tokens.** A subagent starts cold and pays the same for a `Read` as for an inline block.
What extraction buys is agreement, plus the ability to load a long reference **only on the runs that
need it** (below).

## The three kinds

| Folder | What it is | How it is read |
|---|---|---|
| `etalons/` | a **form to copy** — the house shape of a spec, with a compliant example and a counter-example | unconditionally, by both steps of a stream |
| `contracts/` | a **process rule for a run** — how a second run is scoped, how a verdict is reached, what an artifact must contain | on the run it governs |
| `references/` | **knowledge read on demand** at one named step — how to read an API surface, how to explore a browser, how to model a test basis, what shape a document takes, how a level is assigned | at the anchored step, conditionally |

```
docs/automation/
  etalons/
    api-spec-etalon.md               the house form for an API spec
    ui-spec-etalon.md                the house form for a UI spec and its page object
  contracts/
    e2e-stream-scope.md              what a stream implements, folds, skips and counts as a test
    revision-contract.md             mode resolution and revision scoping for a second run
    review-verdict-contract.md       narrowing, finding ids, severity, verdict
    implementation-report.md         the report shape the two streams hand over
    slack-bug-intake.md              which bug fields a chat reporter owns, and which are defaulted
    triage-verdict-contract.md       duplicate-or-new, the confidence bands, what a zero result means
  references/
    api-surface-reading.md           how far each stream may use the `# API Surface` section
    browser-exploration.md           browsing the running app: sessions, locator tiers, mechanics
    test-basis-modelling.md          the four ISTQB black-box techniques
    test-design-document-shape.md    the test design document, section by section
    level-assignment.md              the level rubric and the E2E minimum-set pass
```

## Who reads what

Stated by role, never by agent — see the rule at the bottom.

| Document | Read by |
|---|---|
| `etalons/api-spec-etalon.md` | the API stream's implementing step **and** its review step |
| `etalons/ui-spec-etalon.md` | the UI stream's implementing step **and** its review step |
| `contracts/e2e-stream-scope.md` | both streams — the implementing step at selection, the review step at its coverage pass |
| `contracts/revision-contract.md` | both streams' implementing steps, on a revision |
| `contracts/review-verdict-contract.md` | both streams' review steps |
| `contracts/implementation-report.md` | both streams — written by the implementing step, parsed by the review step |
| `contracts/slack-bug-intake.md` | a triage run's drafting step **and** its responding step |
| `contracts/triage-verdict-contract.md` | a triage run's duplicate-search step **and** the routing that acts on it |
| `references/api-surface-reading.md` | all four Phase 2 steps |
| `references/browser-exploration.md` | any step that drives a browser |
| `references/test-basis-modelling.md` | a design step that will **derive** a scenario |
| `references/test-design-document-shape.md` | a design step writing or rewriting the whole document |
| `references/level-assignment.md` | a design step that will **assign** a level — the rubric, the eight factors and the E2E minimum-set pass |

An etalon is read by **both** halves of a stream on purpose. A reference is read by whoever reaches
the step that needs it.

## Conditional reads, and why they matter

The last two references used to sit inline in a 725-line agent body, loaded in full on every
invocation — including a revision correcting a single line, and a two-scenario re-run that cost
208 seconds. They are now read only by a run that derives scenarios, or writes the whole document.

Each extraction ships with two things, and needs both:

1. an anchored `Read` at the step that needs it, and
2. a `Must not` against working from memory.

A reference an agent forgets to read is worse than a long prompt: the rule stops applying instead of
merely being verbose.

## Rules for anything added here

- **No file in this folder may name an agent.** Speak in stream and step terms, or the
  no-sibling-names rule leaks in through the back door. Slug prefixes in finding ids (`[API-C1]`,
  `[UI-M2]`) name streams, not agents, and are fine.
- **One file, not two.** If two steps need the same rule, that is one document read twice — never a
  copy in each body.
- **A document, not a skill.** Skills are unreachable from a subagent's tool grant.
- **The files on disk outrank the prose.** Where an etalon and the repository disagree, the
  repository is right and the difference is not a finding.
- Moving a file here means rewriting every path that points at it — agent bodies included, where a
  stale path fails only at run time, several delegations in.
