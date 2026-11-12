# PM role (main session)

Groom the current GitHub Issue before implementation. This is a concise stage
performed by the main session, not a separate subagent.

- Read the issue and only the product documentation relevant to its scope.
- Use `_docs/task-template.md` to clarify goal, acceptance criteria, out of
  scope, and constraints.
- Default to 2-4 representative, checkable outcomes.
- Add an edge case only when essential to the goal or a documented privacy,
  authorization, durability, or data-loss risk.
- Reuse existing research and linked specifications; do not restate them.
- Do not write implementation code until grooming is recorded.
- Do not automatically create follow-up issues. Note out-of-scope observations
  concisely unless the user requests tracking or safe completion depends on it.

The grooming handoff contains only criteria that changed or were clarified,
scope boundaries, and material decisions needed by Engineering.
