# Modelling the test basis — the four ISTQB black-box techniques

The mechanics of the four techniques, ISTQB CTFL v4.0 §4.2. Read this **whenever new scenarios will be
derived** — a first run, a full rewrite, or a revision that appends scenarios for a further batch of
requirements or in answer to a finding.

A revision that only edits fields named by an approval does not derive anything and does not need this
file. That is the whole reason it is a separate file: deriving a model and correcting a line somebody
else pointed at are different jobs, and the second was paying for the first on every run.

Coverage item ids are global, sequential, zero-padded to two digits, and permanent: scenarios cite
them, so an id is never renumbered and never reused, in this run or in any later revision.

Walk the four in order. A technique that genuinely does not apply gets an explicit one-line note saying
why — never a silent omission.

---

## Equivalence Partitioning — `EP-NN` (§4.2.1)

For every data element the requirements name — inputs, outputs, configuration items, internal values,
time-related values, interface parameters — divide the data into partitions whose elements the test
object is expected to process the same way.

- Every partition is either **valid** or **invalid**. A parameter with valid partitions and no invalid
  one is almost always an oversight; if it is genuinely correct, the reason goes in the row.
- Partitions must not overlap and must not be empty.
- The coverage item is the partition. 100% coverage means every partition — **including every invalid
  partition** — is exercised by at least one scenario.
- When an operation takes more than one parameter, target **Each Choice** coverage: each partition of
  each parameter appears in at least one scenario. Do **not** enumerate combinations here; combinations
  are what the decision table is for.

## Boundary Value Analysis — `BV-NN` (§4.2.2)

For every **ordered** partition with a numeric or length limit stated in the requirements, take the
minimum and maximum values of the partition as boundary values.

- **3-value BVA is the default**: the boundary and both of its neighbours. Use it unless a neighbour is
  infeasible.
- **2-value BVA** — the boundary and its closest neighbour in the adjacent partition — is permitted
  only when a neighbour cannot exist (a length below 0, for instance), and the row must name which
  neighbour is infeasible and why. This is not a stylistic preference: where a requirement says "at
  least 6", 2-value exercises 5 and 6 only, and an implementation that wrote `> 6` instead of `>= 6`
  passes; the third value catches it.
- Every value written must follow from a limit the requirements state. An unstated upper bound is a
  `# Coverage Gaps` entry, never an invented number.
- The coverage item is each individual value. 100% coverage means every listed value is exercised.

## Decision Table Testing — `DT-NN`, rules `DT-NN/RN` (§4.2.3)

Required whenever an outcome depends on **two or more conditions** — the common shape here being
authorization AND uniqueness AND field validity resolving to different status codes.

- Rows are the conditions, then the resulting actions. Columns are the rules — one unique combination
  of conditions each.
- Notation: `T` the condition is satisfied, `F` it is not, `—` its value is irrelevant to the outcome,
  `N/A` it is infeasible for that rule. For actions, `X` means the action occurs; blank means it does
  not.
- Start from the full table, then delete columns holding infeasible combinations and state underneath
  the table which ones were removed and why. Merging columns whose conditions do not affect the outcome
  is allowed, but it must be recorded — minimizing changes the coverage denominator, so an unrecorded
  merge silently inflates the percentage.
- The coverage item is each **feasible** column. 100% coverage means every one has a scenario.
- The value of this technique is that it exposes gaps and contradictions in the requirements. A
  combination the requirements do not define is a `# Coverage Gaps` entry, not an outcome to decide.

## State Transition Testing — `ST-NN`, transitions `ST-NN/TN` (§4.2.4)

Required whenever the requirements describe entity or session state.

- Emit a **state table**, not a diagram: rows are states, columns are `event [guard condition]`, cells
  hold the target state and any resulting action. An **empty cell is an invalid transition**, and that
  is precisely why the table is required — a diagram hides them.
- Target **all transitions** coverage: exercise every valid transition and *attempt* every invalid one.
  Record the criterion actually achieved when the design falls short — `all states` (weakest),
  `valid transitions` (0-switch), or `all transitions` — and why.
- **At most one invalid transition per scenario.** Two in one scenario risks defect masking, where the
  first defect prevents the second from ever being observed.
- The coverage item is each transition, valid and invalid.
