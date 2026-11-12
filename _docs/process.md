# Development Process

## Roles

- PM - the main session grooms the current issue using `_docs/team/pm.md`.
- Engineer - after grooming, the main session implements the same issue using
  `_docs/team/software-engineer.md`.
- QA - exactly one independent subagent verifies the finished work using
  `_docs/team/qa-engineer.md`.

## One-turn boundary

Process at most one GitHub Issue per user turn. After the issue is closed or a
genuine blocker is reported, stop and return control to the user. Do not select
or begin another backlog issue automatically.

## Lifecycle

1. Select the requested issue, or the earliest ready issue when the user asks
   for the next one, and confirm its prerequisites are complete.
2. The main session acts as PM and grooms the issue before editing files.
3. The main session acts as Engineer and implements only the groomed scope.
4. The Engineer posts a concise implementation comment and leaves the issue
   open.
5. Launch exactly one independent QA subagent after Engineering finishes.
6. QA checks every criterion and posts PASS or FAIL without changing files.
7. On FAIL, the main session corrects the same issue and returns it to the same
   QA subagent. Do not create another QA agent for the retry.
8. On PASS, the main session pushes the focused commit when authorized, posts
   the final evidence, closes the issue, and stops the turn.

## Grooming

- Default to 2-4 representative, user-visible, checkable acceptance criteria.
- Add an edge case only when it is essential to the issue goal or addresses a
  documented privacy, authorization, durability, or data-loss risk.
- Record goal, acceptance criteria, out of scope, and constraints without
  rewriting background already present in linked specifications.
- Do not automatically create follow-up issues for out-of-scope observations.
  Note them concisely and create a follow-up only when the user requests it or
  the current issue cannot be completed safely without tracking it.
- Resolve ambiguity or product conflicts before implementation.

## Implement one issue

- Make the smallest complete change that satisfies the groomed criteria.
- Do not bundle cleanup or behavior belonging to another issue.
- Add or update focused tests for changed behavior.
- Inspect the diff for unrelated changes, accidental secrets, and user-owned
  work before committing.
- Use one focused commit with a concise message and the issue number. Never
  rewrite published history.

## Verification policy

- Engineering runs the smallest targeted checks that prove the change before
  handing off.
- Independent QA reruns the focused verification once against the committed
  implementation and checks every acceptance criterion.
- Do not rerun successful unaffected checks merely to fill a report.
- Run full unit, production-build, or Compose suites only when required by the
  issue, when shared infrastructure changes, after each five completed
  `e2e-test` issues since the previous milestone, or at final backlog
  verification.
- For successful commands, report the command and a short result such as test
  counts. Preserve full logs and failure artifacts only when a command fails.

## Concise handoffs

Do not restate the issue body. Provide only information needed by the next
stage:

- PM: changed or clarified criteria, scope boundaries, and material decisions.
- Engineer: changed files, focused command results, commit hash, and blockers.
- QA: criterion-by-criterion PASS/FAIL, focused command result, and overall
  verdict.

The next stage uses the issue and previous handoff instead of repeating the
same discovery. Independent QA still verifies the running implementation and
does not accept an Engineer claim as evidence by itself.
