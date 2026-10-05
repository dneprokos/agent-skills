# Guide template

Fill this shape in for `<out_dir>/guide.md`. Everything in `<angle brackets>` gets replaced. Delete any
optional section you have nothing real to put in.

The reader is someone using the product, not a tester. Write for them: name controls by their visible
label in **bold**, say where on the screen they are when it isn't obvious, and describe what the reader
should see after a step. Leave out selectors, `e12`-style refs, env var names, URLs to internal state
files, and every sentence about how the guide was produced.

````markdown
# How to <task, as the reader would phrase it>

<One or two sentences: what this guide gets the reader to, and when they would need it.>

## Before you start

- <Access needed, e.g. "An owner account for the portal.">
- <Starting point, e.g. "Open the portal in your browser.">

## Steps

### 1. <First step, imperative — "Open the login page">

<What to do, in one or two sentences.>

![<What the screenshot shows, in words — this is the alt text>](images/01-<name>.png)

*What you should see:* <the one thing in the screenshot that confirms the step worked>.

### 2. <Next step>

1. Enter your email address in **Email Address**.
2. Enter your password in **Password**.

![Login form filled in](images/02-<name>.png)

### 3. <A step with no screenshot>

Click **Login**. <Screens without a visual change get text only — no image.>

<...>

## Result

<What the reader has now, one or two sentences.>

<!-- Optional: only symptoms this run actually hit (an error message it saw, a slow load it waited on). -->
## Troubleshooting

- **<Symptom observed during the run>** — <what fixed it in the run>.
````

Rules the template encodes:

- Several small actions on one screen are one step with a numbered sub-list, and at most one screenshot
  after the last of them. Do not split "type email", "type password" into separate steps with images.
- Credentials are always written as what the reader supplies: "your email address", "your password" —
  never a value, never a variable name.
- A native browser prompt (for example a "Are you sure?" confirm box) cannot be captured. Describe it:
  "Your browser asks you to confirm — click **OK**."
- Image paths are relative to the guide (`images/…`), so the folder can be moved or published as-is.
- If the run was blocked, add this directly under the step it stopped at, and keep the steps before it:

  ```markdown
  > **Blocked at step <N>:** <what was attempted and what the page did instead>. The steps below this
  > point were not recorded.
  ```
