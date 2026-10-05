# spec-lint fixtures

Two trees, both shaped like the repository, because every rule in `scripts/spec-lint.mjs` is scoped
by path prefix: a spec is a file under `tests/api/` or `tests/ui/`, and a page object is a file under
`pages/`. A fixture that did not live at those paths would exercise nothing. `--root` points the
script at one of these trees instead of the repository.

- `clean/` — every rule satisfied. A run over it that reports anything is a false positive, which is
  the failure mode a linter cannot survive: nobody keeps running a check that cries wolf.
- `violations/` — one file per rule, each carrying exactly the defect it is named for and nothing
  else, so a test asserting one code proves that code fires *and* that no other rule fired on the
  same file.

The files are not compiled and not run — `tsconfig.json` does not reach this directory, and the
script reads text. They import from module specifiers that resolve in the real repository so they
read as the code they stand in for.
