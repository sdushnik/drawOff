# Development Process

## Roles

- PM - grooms a task before anyone implements it, follows _docs/team/pm.md
- Engineer - implements one groomed task, follows _docs/team/software-engineer.md
- QA - checks the result against the acceptance criteria, follows _docs/team/qa-engineer.md

## Orchestrator

The main session is the orchestrator. It launches the PM, the engineer
and QA as subagents. It does not groom, implement or test itself.

## Lifecycle

1. Select the next open issue whose documented prerequisite issues are complete; prefer the earliest backlog issue among those ready to start.
2. PM grooms the issue.
3. After PM grooming is complete, the Engineer implements that issue.
4. After the Engineer finishes and reports the implementation, QA verifies it.
5. On FAIL, send QA's comment to the Engineer, who corrects the implementation; then QA verifies it again.
6. On PASS, the orchestrator closes the issue.
7. Repeat until the backlog is empty or every remaining issue is blocked by an incomplete prerequisite.

## Rules

- Do not skip step 2
- Do not start the Engineer until PM grooming is complete; do not start QA until the Engineer reports completion. PM → Engineer → QA is a strictly sequential handoff, not parallel work.
- Before selecting an issue, inspect its documented dependencies. Do not start an issue while a required prerequisite is incomplete; if no issue is ready, report the blockers rather than skipping dependencies.
- The engineer does not close the issue
- QA does not fix the code, only outputs PASS or FAIL
- QA's issue comment must check every Acceptance Criterion individually, state PASS or FAIL for each, and include the exact tests/commands run and their results. QA outputs the overall PASS/FAIL verdict only after checking every criterion against the running implementation.
- The orchestrator closes the issue only after QA outputs PASS

## Work one task at a time

- Choose one task from `_docs/tasks.md` or one GitHub issue and work only on its scope.
- Before starting, read the task's goal and description, the relevant product behavior in `_docs/plan.md`, and the applicable acceptance criteria.
- If the task is ambiguous or conflicts with the plan, resolve the scope before implementation; do not silently make product decisions.
- Avoid bundling unrelated cleanup or starting another task before the current task is complete.

## Implement and verify

- Make the smallest complete change that satisfies the task and preserves confirmed product decisions.
- Add or update focused tests for changed behavior. Run the relevant tests and build checks before considering the task done.
- Check the diff for unrelated changes, errors, and accidental secrets. Report any validation that could not be completed.
- Update the specification or other directly related documentation when behavior or implementation guidance changes.

## Commit regularly

- Commit each completed task in a focused commit; do not wait to accumulate several unrelated tasks.
- Before committing, confirm the task's acceptance criteria are met, required checks pass, and only intended files are included.
- Use a concise commit message that describes the change. Do not commit credentials, secrets, or local environment files.

## Complete the task

- Mark the corresponding backlog task or GitHub issue complete only after implementation and verification are done.
- Summarize what changed, the tests/checks run, and the commit or issue status. Call out any remaining limitations explicitly.

## Context Handoff

Each role must produce a concise handoff for the next role.

### PM Handoff
- Groomed issue
- Goal
- Acceptance criteria
- Out of scope
- Constraints
- Relevant documentation and files
- Related E2E issue references

### Engineer Handoff
- Implementation summary
- Files changed
- Tests executed and results
- Commit hash
- Known limitations

### QA Handoff
- Every acceptance criterion checked individually
- PASS or FAIL for each criterion
- Exact test commands and results
- Missing test coverage
- Overall PASS or FAIL verdict

The next role must use the previous handoff
instead of repeating completed analysis.

Do not skip independent verification.
