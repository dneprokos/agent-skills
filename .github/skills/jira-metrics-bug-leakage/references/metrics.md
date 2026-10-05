# Leakage metrics — definitions and pitfalls

## The core pair

Let **C** be defects whose detection phase is `Development` (caught before
release) and **E** be those whose phase is `Production` (escaped). Defects with
no phase set are **U** and belong to neither.

```
classified      = C + E
leakage rate    = E / (C + E)
containment     = C / (C + E)  =  1 − leakage
```

Containment rate is also called **Defect Detection Effectiveness (DDE)** or
**Defect Removal Efficiency (DRE)**. Same number, different literature.

`U` is never folded into either side. Assigning it would move the headline
without evidence — and which way it moved would depend on an arbitrary choice
rather than on the defects.

## Severity weighting

Raw leakage treats an escaped typo as an escaped data-loss bug. The weighted
form does not:

```
weighted leakage = Σ w(e) for e in E  ÷  Σ w(d) for d in C ∪ E
```

with `w` from `config.priorityWeights` (Highest 5, High 4, Medium 3, Low 2,
Lowest 1). Report both. The gap between them is the interesting part:

| Relationship | Reading |
|---|---|
| weighted ≈ raw | what escapes looks like what is caught |
| weighted > raw | the serious defects are the ones escaping — the raw number understates the problem |
| weighted < raw | escapes are mostly minor; the raw number overstates it |

## Time slicing

Bugs are bucketed by the month they were **created**, i.e. raised in Jira. Two
consequences:

- A defect introduced long ago and found today lands in today's bucket. Leakage
  is a property of *detection*, not of *injection*.
- A month with three bugs has a rate that swings by 33 points per bug. The
  report suppresses the trend below two months and flags small samples, but the
  per-month rows can still be noisy — read the counts.

A more stable alternative when there is enough history: a rolling three-month
window, or bucketing by release rather than by month. Neither is implemented;
both are reasonable extensions.

## Ageing

For escaped defects that are still open:

```
age = today − created          (days, floored)
```

For escaped defects that are resolved:

```
time to fix = resolutiondate − created
```

`resolved` is read from Jira's **status category** (`done`), not from the status
name, so a workflow with custom status names still classifies correctly.

Median rather than mean throughout: one defect open for a year would drag a mean
somewhere no individual defect actually sits.

## Area attribution

A defect counts **once**, under the first label in `config.areaLabels` that it
carries. Config order is the tie-breaker, not label order on the issue.

The alternative — counting a defect in every area it touches — makes the column
totals exceed the defect count and inflates whichever area tends to co-occur
with others. If a defect genuinely spans two areas, that is a labelling
decision, not something the metric should silently split.

## Targets

`config.targets` sets the bands:

| Band | Condition |
|---|---|
| on target | rate ≤ `leakageRate` (20%) |
| above target | rate ≤ `warnAt` (30%) |
| well above target | rate > `warnAt` |

These are defaults, not industry law. Set them from your own history: the useful
target is a step down from where you are, not a number copied from a paper.

## How this metric gets gamed

Worth knowing before anyone is measured on it:

1. **Not setting the field on production reports.** Leakage falls, containment
   rises, nothing improved. The unclassified count is the tell, which is why it
   sits on the dashboard next to the headline rather than in a footnote.
2. **Filing production issues as support tickets** rather than bugs. They leave
   the denominator entirely. Watch the total bug count as well as the rate.
3. **Splitting one escaped defect into several caught follow-ups.** The single
   escape stays, the denominator grows, the rate falls.
4. **Filing speculative "found in development" bugs** to pad the denominator.
   Rising bug counts with a falling severity mix is the signature.

None of these are hypothetical failure modes of the maths — they are what
happens when a process metric is used as a personal one. Report leakage as a
property of the pipeline, and it stays honest.

## Related measures worth adding later

| Metric | Why |
|---|---|
| Phase containment across more than two phases | unit / integration / staging / production tells you *which* net has the hole, not just that one does |
| Defect density | defects per unit of change; separates "more bugs" from "more code" |
| Mean time to detect | how long an escaped defect lived in production before anyone noticed |
| Escaped-defect reopen rate | whether production fixes are holding |

All four need data this project does not yet record. Leakage is the one that
needs a single field.
