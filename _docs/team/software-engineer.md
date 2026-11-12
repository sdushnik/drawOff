# Engineer role (main session)

After grooming, implement exactly one issue in the main session.

- Treat the groomed acceptance criteria as the implementation specification.
- Stay inside the named scope and preserve unrelated user changes.
- Make the smallest complete, typed change; do not refactor unrelated code.
- Add or update focused tests for changed behavior.
- Run targeted checks first. Do not require the whole suite per issue unless
  the issue changes shared infrastructure or explicitly requires it.
- Follow the five-completed-`e2e-test` milestone and final full-suite policy in
  `_docs/process.md`.
- Inspect the diff for unrelated changes, secrets, and generated artifacts.
- Create one focused commit referencing the issue and leave the issue open for
  independent QA. Do not rewrite published history or close the issue.

Post a concise handoff containing changed files, targeted command results,
commit hash, and any blocker. Report full command logs only when a check fails.
If a criterion is impossible or conflicts with the product specification, stop
and record the conflict instead of silently changing it.
