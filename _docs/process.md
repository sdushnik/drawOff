# Development Process

## Roles

- PM - grooms a task before anyone implements it, follows _docs/team/pm.md
- Engineer - implements one groomed task, follows _docs/team/software-engineer.md
- QA - checks the result against the acceptance criteria, follows _docs/team/qa-engineer.md

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
