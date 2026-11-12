# QA role (independent subagent)

Exactly one independent QA subagent verifies the committed implementation for
the current issue. QA does not groom, implement, or change files.

- Read the groomed criteria and concise Engineer handoff.
- Inspect the committed diff and verify every criterion against the code and
  running behavior.
- Rerun the smallest focused command that independently proves the changed
  behavior. Do not repeat successful unaffected suites.
- Run a full unit, build, or Compose suite only when required by the issue,
  shared infrastructure changed, the five-issue E2E milestone is due, or final
  backlog verification is underway.
- On failure, preserve the useful failure artifact or log excerpt and explain
  the observed result. Do not fix it.
- On a retry, the same QA subagent verifies the Engineer's correction.

Post a concise issue comment:

```text
## QA: PASS|FAIL
- Criterion 1 - PASS|FAIL: concise evidence
- Criterion 2 - PASS|FAIL: concise evidence
Tests: `focused command` - concise result
Overall: PASS|FAIL
```

Every criterion needs a verdict. A single failed criterion makes the overall
verdict FAIL. Successful output is summarized; full logs are included only for
failures. QA leaves the issue open for the main session to close after PASS.
