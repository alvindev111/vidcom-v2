# Implementation Guide

> **Audience**: LLM Agents (and humans) actually executing tasks in `spec-<feature-slug>-implementation-checklist.md`.
>
> **Scope**: How to execute a checklist that already exists. For how to WRITE the checklist, see Part B of `implementation-checklist-template.md`.
> Do not use this guide to bootstrap specs for ordinary tasks. If no approved checklist exists and the user did not explicitly request the spec process, ask before creating or editing any spec artifacts.
>
> **Related rules**:
> - [Spec Rule](./spec-rule.md) — the process that produced the checklist
> - [Detailed Goal Template](./detailed-goal-template.md) — the "What"
> - [Detail Design Template](./detailed-design-template.md) — the "How"
> - [Implementation Checklist Template](./implementation-checklist-template.md) — the "Tasks"

---

## 0. TL;DR — The Loop

For every task in the checklist:

```
Analyze → Prepare → Implement → Validate → Log → Mark complete
   ↑                                                    │
   └──────────────── next task ─────────────────────────┘
```

One task at a time. Fully complete before moving on. Update `detailed-design.md` if reality diverges from design.

---

## 1. Before Touching Any Code

### 1.1 Verify the spec is executable

Open the checklist and confirm:
- [ ] Implementation checklist Approval Gate is `Approved`
- [ ] Header links to BOTH `detailed-goal.md` and `detailed-design.md`
- [ ] Sequencing Strategy is stated (Foundation-First / Feature-Slice / Risk-First / Hybrid)
- [ ] Dependency Order is diagrammed
- [ ] LLM Agent — Skill Activation Per Phase table is filled
- [ ] Every phase has `Skill`, `Read first`, `Design reference` annotations
- [ ] Every sub-task carries `_Requirements: [Goal ID]_ — _Design: [Sec X.Y]_`
- [ ] Requirements Coverage Matrix is filled
- [ ] Persistence-bound phases have BOTH logic tests AND real-PostgreSQL tests

If any box above is empty, the checklist is not ready. STOP and either fill the gap or escalate — do not start coding a partially-specified plan.

If there is no checklist because the user asked for a direct code/doc change, do not create one automatically. Execute the direct task normally, or ask whether the user wants to start the spec process when the scope needs formal planning.

### 1.2 Environment prep

- Dev server / database / workers are running.
- Test framework works on the current branch (run a known-passing test once to confirm).
- Branch is clean and named for the spec (e.g., `spec-<feature-slug>/<short-topic>`).
- Shell commands go through `rtk` (per workspace rules).

### 1.3 Pick the next task

Rules of order:
1. Respect `Dependency Order`. Don't start a task whose prerequisites are `[ ]` or `[/]`.
2. Within a phase, go top-down unless the checklist marks items as parallel.
3. Only ONE task at a time is `[/]`.

---

## 2. The Per-Task Execution Loop

### Phase 1 — Analyze

Read, then decide.

- [ ] Re-read the task text plus its `_Requirements_` entries in `detailed-goal.md` and `_Design_` entries in `detailed-design.md`.
- [ ] Open every file listed in the phase's `Read first` and read it at the resolution called for (FULL vs. `search functionX`).
- [ ] Activate the phase's `Skill` file(s) — read the SKILL.md section(s) mentioned.
- [ ] Confirm all prerequisite tasks show `[x]`.
- [ ] Note any ambiguity. If the task cannot be implemented from the spec, STOP — clarifying the spec is more valuable than guessing (see Sec 5).

### Phase 2 — Prepare

- [ ] Flip the task status to `[/]` in the checklist.
- [ ] Plan the implementation in 3–6 bullets (files, functions, shape of the change). If the plan exceeds ~4h of work, split the task and log the split in the Execution Log.
- [ ] For persistence-bound tasks: plan the DB-backed tests BEFORE writing production code.

### Phase 3 — Implement

Default style: test first when the task is testable, incremental commits, small diffs.

- [ ] Write the failing test (when the task includes test sub-items).
- [ ] Implement the minimum code to pass.
- [ ] Refactor for clarity — naming, single-purpose functions, no dead code.
- [ ] Follow existing project conventions (Elysia controller pattern, Drizzle schemas, service as abstract class with static methods, workspace scoping). When in doubt, mirror the closest existing module rather than inventing a new pattern.
- [ ] Keep the diff within the task's declared `Files affected`. If you must touch a file not listed, record it in the Execution Log and either update `Files affected` or stop and re-scope.

### Phase 4 — Validate

Before flipping to `[x]`:

- [ ] All new and existing unit tests pass.
- [ ] For persistence-bound work, all real-PostgreSQL-backed tests pass: round-trip, transactions, constraints, workspace isolation.
- [ ] Acceptance criteria for the phase are re-checked.
- [ ] Typecheck / lint / build passes on the changed files.
- [ ] No debug logs, `console.log`, commented-out code, or stray test fixtures left behind.
- [ ] Secrets are referenced by env key, never echoed.

### Phase 5 — Log and commit

- [ ] Append one entry to `Execution Log` in the checklist (date, phase/task, files, summary, decisions, blockers). Use the skeleton's log format.
- [ ] Commit with a message that references the phase/task: `Phase 3.6: add DB-backed round-trip test for Foo`.
- [ ] Flip task status to `[x]`.
- [ ] Update `Files Changed Summary` at the bottom of the checklist if this task introduced or removed files.

---

## 3. Working Modes

### 3.1 Test-Driven (preferred for logic-heavy tasks)
1. Read the acceptance criterion.
2. Write a failing test naming the behavior.
3. Implement minimal passing code.
4. Refactor.
5. Repeat for edge cases listed in the phase.

### 3.2 Incremental (preferred for wide, shallow changes)
1. Implement the simplest end-to-end path first.
2. Add one concern per commit (validation, errors, edge cases).
3. Validate after each increment.
4. Document non-obvious decisions inline and in the Execution Log.

### 3.3 Spike-then-rewrite (only when the design itself needs probing)
1. Build a throwaway prototype in a scratch branch.
2. Capture findings in the Execution Log AND as updates to `detailed-design.md` Sec 10 (Decision Records).
3. Delete the prototype.
4. Execute the now-clarified task on the real branch.

---

## 4. Quality Gates

### Before marking `[/]`
- [ ] I can explain in one sentence what this task produces and why.
- [ ] I know which requirement and which design section it implements.
- [ ] I have a test plan (unit + DB if applicable).

### During implementation
- [ ] Naming is descriptive and matches the codebase.
- [ ] Error paths are handled, not swallowed.
- [ ] No `any` / untyped escape hatches unless existing code uses them.
- [ ] Workspace isolation is enforced wherever rows are read or written.

### Before marking `[x]`
- [ ] Tests green (`rtk <test cmd>`).
- [ ] Typecheck / lint / build green on changed files.
- [ ] Acceptance criteria for this task re-read and satisfied.
- [ ] Execution Log entry written.
- [ ] Commit pushed.

---

## 5. Handling Unknowns and Challenges

### 5.1 Requirements ambiguity
**Signal**: Multiple plausible interpretations of the task.
**Response**:
1. Check `detailed-goal.md` and `detailed-design.md` for resolving context.
2. If still unclear, DO NOT guess. Post the ambiguity in the Execution Log with the options considered, and block the task (`[!]`).
3. For AI-agent execution: surface the question to the user; don't invent behavior.

### 5.2 Technical complexity larger than expected
**Signal**: Estimated 1–4h, already ~4h in with no end in sight.
**Response**:
1. Stop coding. Re-read the design.
2. If the design anticipated this complexity, split the task into sub-tasks and update the checklist before resuming.
3. If the design did not anticipate it, the design is wrong — go to Sec 6 (Design Drift).

### 5.3 Integration issues
**Signal**: New code fights the existing shape of the codebase.
**Response**:
1. Re-read `detailed-design.md` Sec 5 (Components and Interfaces) — most integration pain is a missed interface.
2. Prefer adapters over editing unrelated modules.
3. If you must modify an existing module outside `Files affected`, stop and re-scope the task; do not silently expand the diff.

### 5.4 Performance concerns
**Signal**: Task meets functional AC but misses NFR targets in `detailed-design.md` Sec 9.1.
**Response**:
1. Mark functional AC complete but keep the phase `[/]`.
2. Profile to locate the bottleneck.
3. Either solve it within the phase (if cheap) or log as a Deferred Item with measurement evidence.

### 5.5 Missing dependency
**Signal**: You need a function/module/config that does not yet exist.
**Response**:
1. Check the checklist — is there an earlier task that should have built it?
2. If yes, finish that task first.
3. If no, add the missing task in the correct phase, propagate `Dependency Order`, and explain in the Execution Log.

### 5.6 Failing pre-existing tests
**Signal**: Tests that were green before your change are red now.
**Response**:
1. Read the failure. Is it your regression or an orthogonal flake?
2. If regression — fix it inside the current task; do not disable.
3. If pre-existing flake — log it, do not disable, escalate.

### 5.7 Blocked by environment / external system
**Signal**: Task cannot proceed because of infra, access, or a third-party issue.
**Response**:
1. Mark the task `[!]` with a one-line blocker description in the Execution Log.
2. Move to the next non-dependent task.
3. Do not fake the integration; use real adapters and mark the verification sub-task blocked instead.

---

## 6. Design Drift — When Reality Diverges from `detailed-design.md`

This is the single most important rule in this guide.

**If, during execution, you realize the design is wrong or incomplete**:

1. STOP the current task.
2. Edit `detailed-design.md`:
   - Update the affected Sec (components, data models, contracts, etc.).
   - Add or revise a Decision Record in Sec 10 explaining Context / Options / Decision / Rationale / Implications.
3. Propagate to `spec-<feature-slug>-implementation-checklist.md`:
   - Adjust phase boundaries, `Files affected`, or task sequence.
   - Update the Requirements Coverage Matrix.
4. Log the drift in the Execution Log with a pointer to the updated Sec.
5. Only then resume implementation.

The three files (goal / design / checklist) MUST stay in sync. A checklist that no longer reflects the design is worse than no checklist at all.

---

## 7. Progress Tracking

### 7.1 Task status discipline

| Symbol | Meaning | When to set |
|--------|---------|-------------|
| `[ ]` | Not started | Initial state |
| `[/]` | In progress | You have started implementing |
| `[x]` | Complete | All AC met, tests green, log written, commit pushed |
| `[!]` | Blocked | External blocker; log the reason |

Exactly one task per author should be `[/]` at any time.

### 7.2 Execution Log — minimum content

One entry per work session. Format (already in the checklist skeleton):

```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts], [path/to/other.ts]
  - Summary: [what was done]
  - Decisions: [any deviation from design — and where detailed-design.md was updated]
  - Blockers: [if any]
```

### 7.3 Communication to the main spec file

- Completed stories get moved to the `Spec Review` section of `spec-<feature-slug>-inprocess.md` (or `complete.md` at spec end).
- Material impediments are surfaced in `During Spec → Impediments`.
- Scope changes are reflected in `During Spec → Adjustments`.

---

## 8. Acceptable Deviations

You MAY deviate from the checklist without escalation when:
- You found a cleaner implementation that satisfies the same acceptance criteria.
- You can reuse an existing helper instead of creating a new one.
- You discovered a smaller diff that achieves the same behavior.

You MUST escalate (pause + update design + log) when:
- The interface contracts in `detailed-design.md` Sec 5 or Sec 7 change.
- The data model in Sec 6 changes.
- A Decision Record in Sec 10 is invalidated.
- A detailed goal becomes unachievable as scoped.
- Workspace isolation, authentication, or authorization boundaries are affected.

---

## 9. End-of-Phase / End-of-Spec Hygiene

### End of a phase
- [ ] All tasks in the phase `[x]`.
- [ ] Phase-level Acceptance Criteria re-verified.
- [ ] `Files Changed Summary` updated for files added by this phase.
- [ ] Any Deferred Items discovered during the phase are in the Deferred Items table.

### End of the spec
- [ ] Every phase `[x]` or explicitly deferred with a note.
- [ ] Requirements Coverage Matrix audited: every goal has an `[x]` task and a green test.
- [ ] `detailed-design.md` matches what actually shipped.
- [ ] Execution Log contains entries for every work session.
- [ ] Rename `spec-<feature-slug>-inprocess.md` → `spec-<feature-slug>-complete.md` and fill Sections 4–6 (During Spec, Review, Retrospective).

---

## 10. Quick Checklists (copy into PR descriptions)

### Per-task PR checklist
- [ ] Task(s) referenced in commit message(s)
- [ ] Tests added/updated (unit + DB where applicable)
- [ ] All tests green
- [ ] Typecheck / lint / build green
- [ ] Execution Log updated
- [ ] `detailed-design.md` updated if behavior diverged from design
- [ ] No secrets, debug logs, or commented-out code

### Per-phase PR checklist
- [ ] All sub-tasks `[x]`
- [ ] Phase Acceptance Criteria met
- [ ] Workspace isolation verified (if persistence-bound)
- [ ] Files Changed Summary updated
- [ ] Deferred Items captured

---

## 11. Anti-Patterns

Do NOT:
- Start a task whose `Skill` / `Read first` haven't been loaded.
- Keep multiple tasks `[/]` at once.
- Mark a task `[x]` with failing or skipped tests.
- Silently edit files outside `Files affected`.
- Disable a pre-existing test to "unblock" a new one.
- Fake a DB-backed test with a mock when the checklist requires real-PostgreSQL verification.
- Let `implementation-checklist.md` and `detailed-design.md` diverge.
- Batch up many tasks into one giant commit at the end of the day.
