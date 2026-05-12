# Runtime Continuity

Runtime continuity prevents governance drift during long-running, multi-turn, or interrupted tasks.

The first governance load is not enough. Agents must periodically re-check whether the current execution is still inside the selected task, risk level, workflow, and validation boundary.

## Drift Signals

Re-check governance when any of these occur:

- the user adds new requirements
- the task changes from review to implementation, bugfix, refactor, or release
- more files or modules become involved than originally expected
- validation fails, becomes unavailable, or reveals a new defect
- fallback or degraded behavior appears
- the worktree changes unexpectedly
- context is compacted, resumed, or interrupted
- the agent has been working across multiple reasoning steps or tool calls
- uncertainty about scope, risk, or loaded governance increases

## Governance Checkpoint

At a checkpoint, answer:

- Is the original task still the current task?
- Has the task class changed?
- Has risk changed?
- Has a new disturbance appeared?
- Is the selected workflow still appropriate?
- Are additional policies, skills, checklists, or state files now required?
- Has scope expanded beyond the user's request?
- Are assumptions, validation gaps, or unresolved questions still visible?
- Is correction required before continuing?

## Checkpoint Triggers

Run a checkpoint:

- before starting file edits on medium or high-risk work
- after each major implementation phase
- after validation failure
- after a user changes or expands the request
- after context resume or compaction
- before final response on medium or high-risk work

## State Expectations

When state maintenance is being used, continuity-relevant changes should be reflected in state:

- `task_state.yaml` for task class, scope, risk, or phase changes
- `context_state.yaml` for new assumptions or unresolved questions
- `risk_state.yaml` for new disturbances or escalation
- `execution_state.yaml` for phase changes or correction requirements
- `verification_state.yaml` for validation gaps

Do not update state performatively. Update it when continuity would otherwise depend on hidden memory.

## Completion Rule

Do not complete a long-running or multi-turn task if the current task, risk level, workflow, validation status, or correction state is unknown.

Report the gap or run a checkpoint first.
