# Spec [Feature Name] Implementation Checklist

> **References**:
> - [Detailed Goals](./spec-[feature-slug]-detailed-goal.md)
> - [Detail Design](./spec-[feature-slug]-detailed-design.md)
>
> **Audit Reference**: The Detailed Goal file contains audit findings, in-scope goals, and deferred items.

> [!NOTE]
> This file has two parts:
> - **Part A — Skeleton**: Copy the structure below into `spec-<feature-slug>-implementation-checklist.md` and fill in the placeholders.
> - **Part B — Author Guidance**: How to identify, structure, sequence, and write tasks (process, patterns, pitfalls). Read once before authoring; do not copy into the spec file.

---

# PART A — Skeleton (copy into `spec-<feature-slug>-implementation-checklist.md`)

## Context

> [!NOTE]
> This checklist is the central source of truth for the LLM Agent during execution. All tasks must be tracked here.
> For persistence-bound backend work, the checklist is not complete until it includes both logic coverage and verification against a real PostgreSQL test database.

This document breaks down the features of Spec [Feature Name] into actionable tasks, tracing every task back to a detailed goal (the "What") and a design element (the "How").

## Approval Gate

> Do not write production code until this section is explicitly confirmed.

- **Status**: [Pending Confirmation | Approved | Needs Revision]
- **Confirmed by**: [name / role / user]
- **Confirmation date**: [YYYY-MM-DD]
- **Notes / required revisions before code execution**: [...]

## Sequencing Strategy

**Chosen strategy**: [Foundation-First | Feature-Slice | Risk-First | Hybrid] — see Part B for definitions.

**Rationale**: [One or two sentences explaining why this strategy fits the spec.]

## Dependency Order

```
[Describe dependency graph between phases/goals here]
Example:
Phase 1 (Schema) ──→ Phase 2 (Service) ──→ Phase 3 (API)
Phase 4 (Frontend) depends on Phase 3
```

**Recommended execution order**: [1 → 2 → 3 → ...]

**Parallelizable phases**: [List any phases that can run concurrently after their prerequisites, or "None" if strictly sequential.]

---

## LLM Agent — Skill Activation Per Phase

> [!IMPORTANT]
> Before implementing each phase, you MUST activate the corresponding skills and read the relevant source files.

| Phase | Skills to activate | Source files to read BEFORE modifying |
|-------|---------------------|--------------------------------------|
| 1: [Phase Name] | `.agents/skills/[skill-name]/SKILL.md` | `[path/to/file.ts]` (FULL or search `functionName`) |
| 2: [Phase Name] | `.agents/skills/[skill-name]/SKILL.md` | `[path/to/file.ts]`, `[path/to/other.ts]` |
| 3: [Phase Name] | `.agents/skills/[skill-a]/SKILL.md`, `.agents/skills/[skill-b]/SKILL.md` | `[path/to/file.ts]` (FULL) |

**Coding rules (read once before starting)**:
- `llm-documents/backend-docs/coding-rules.md` — [relevant patterns]
- `llm-documents/backend-docs/ai-coding-rules.md` — [if there are AI layer changes]
- `llm-documents/frontend-docs/coding-rules.md` — [if there are frontend changes]

---

## Task Status Legend

- `[ ]` — Not started
- `[/]` — In progress
- `[x]` — Complete (implemented, tested, validated)
- `[!]` — Blocked (add a note explaining the blocker)

---

## Phase 1: [Phase/Goal Name]

**Addresses**: [Detailed Goal section / Story # — brief description]
**Design reference**: [Sec X.Y of `spec-[feature-slug]-detailed-design.md` — component/interface this phase implements]
**Files affected**: `[file1.ts]`, `[file2.ts]`
**Prerequisite**: [None / Phase X must complete first]
**Skill**: Activate `.agents/skills/[skill-name]/SKILL.md` — see section `<section-name>` for [what to look for]
**Read first**: `[path/to/file.ts]` ([FULL / search `functionName`] — understand `functionA()`, `functionB()`)

**Tasks**:
- [ ] 1.1 [Task title — verb-first, specific]
  - [Concrete implementation detail — what file, what function, what logic]
  - [Key functionality to implement]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_
- [ ] 1.2 [Task title]
  - [Implementation detail]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_
- [ ] 1.3 Add unit tests
  - [What to test — happy path + edge cases]
  - _Requirements: [Goal ID(s)]_

**Acceptance Criteria**:
- [ ] [Criterion 1 — observable, testable]
- [ ] [Criterion 2]

**Deliverables Created / Modified**:
- `[path/to/file.ts]` — [brief description of changes]

---

## Phase 2: [Phase/Goal Name]

**Addresses**: [Detailed Goal section / Story # — brief description]
**Design reference**: [Sec X.Y of `spec-[feature-slug]-detailed-design.md`]
**Files affected**: `[file1.ts]`
**Prerequisite**: [None / Phase X]
**Skill**: Activate `.agents/skills/[skill-name]/SKILL.md` — see `<section-name>` for [what to look for]
**Read first**: `[path/to/file.ts]` (FULL — understand `functionA()`, `functionB()`)

**Tasks**:
- [ ] 2.1 [Task title]
  - [Implementation detail]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_
- [ ] 2.2 [Task title]
  - [Implementation detail]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_
- [ ] 2.3 Add unit tests
  - [What to test]
  - _Requirements: [Goal ID(s)]_

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

**Deliverables Created / Modified**:
- `[path/to/file.ts]` — [brief description]

---

## Phase 3: [Phase/Goal Name] (persistence-bound — example)

**Addresses**: [Detailed Goal section / Story # — brief description]
**Design reference**: [Sec X.Y and Sec Y.Z of `spec-[feature-slug]-detailed-design.md`]
**Files affected**: `[file1.ts]`, `[file2.ts]`, `[file3.ts]`
**Prerequisite**: [Phase X (reason)]
**Skills**:
  - `.agents/skills/[skill-a]/SKILL.md` — see `<section-name>` for [what to look for]
  - `.agents/skills/[skill-b]/SKILL.md` — see `<section-name>` for [what to look for]
**Read first**:
  - `[path/to/file1.ts]` (FULL — understand `functionA()`)
  - `[path/to/file2.ts]` (search `functionB` — understand flow)
  - `llm-documents/backend-docs/[relevant-doc].md` — [relevant pattern]

**Tasks — File 1: `[path/to/file1.ts]`**:
- [ ] 3.1 [Task title]
  - [Implementation detail]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_
- [ ] 3.2 [Task title]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_

**Tasks — File 2: `[path/to/file2.ts]`**:
- [ ] 3.3 [Task title]
  - _Requirements: [Goal ID(s)]_ — _Design: [Design Sec ref]_

**Tasks — Logic Tests (no DB)**:
- [ ] 3.4 Unit test pure logic for [scenario]
- [ ] 3.5 Unit test backward-compat scenario

**Tasks — Real PostgreSQL Test DB**:
- [ ] 3.6 Integration test: write → read round-trip for [entity]
- [ ] 3.7 Integration test: transaction rollback on [error condition]
- [ ] 3.8 Integration test: unique / FK / check constraint enforcement
- [ ] 3.9 Integration test: workspace isolation — rows from workspace A not visible to workspace B

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]
- [ ] All logic tests and DB-backed tests pass in CI

**Deliverables Created / Modified**:
- `[path/to/file.ts]` — [brief description]

---

## Files Changed Summary

| File | Phase(s) | Changes |
|------|----------|---------|
| `[path/to/file.ts]` | 1, 2 | [Brief description] |
| `[path/to/file.ts]` | 3 | [Brief description] |

**Total estimated changes**: [~N lines across M files]

---

## Requirements Coverage Matrix

| Detailed Goal / Requirement | Covered by Phase/Task(s) | Verified by Test(s) |
|-----------------------------|--------------------------|---------------------|
| [Goal ID] | 1.1, 2.3 | 1.3 unit, 3.6 integration |
| [Goal ID] | 3.2 | 3.4, 3.9 |

> Every detailed goal MUST appear in this matrix, mapped to at least one task and one test.

---

## Deferred Items Reference (Spec N+)

| # | Issue | Effort | Dependency |
|---|--------|--------|------------|
| D1 | [Description] | [N SP] | [What it depends on] |
| D2 | [Description] | [N SP] | [What it depends on] |

Resolution details: see the "Deferred Items" section in [Detailed Goals](./spec-[feature-slug]-detailed-goal.md) and Sec 13 of [Detail Design](./spec-[feature-slug]-detailed-design.md).

---

## Execution Log

> [!NOTE]
> Append one entry per work session. Each entry: date, phase/task touched, files modified, notable decisions, blockers encountered.

_To be updated during implementation._

Format:
```
YYYY-MM-DD — Phase X, Task X.Y
  - Files: [path/to/file.ts], [path/to/other.ts]
  - Summary: [what was done]
  - Decisions: [any deviation from design — update detailed-design.md if material]
  - Blockers: [if any]
```

---

# PART B — Author Guidance (do NOT copy into the spec file)

## Overview

The Implementation Planning Phase transforms the approved design into a structured implementation plan of discrete, actionable coding tasks. It is the bridge between planning (Goals + Design) and execution, breaking complex system designs into manageable steps that can be executed incrementally by developers or AI coding agents.

As the third phase of the Goals → Design → Implement workflow, this phase ensures that careful planning translates into systematic, trackable implementation progress.

## Purpose and Goals

The tasks phase serves to:
- Convert design components into specific coding activities
- Sequence tasks for optimal development flow and early validation
- Create clear, actionable prompts for implementation
- Establish dependencies and build order between tasks
- Enable incremental progress with testable milestones
- Provide a roadmap for systematic feature development

## Step-by-Step Process

### Step 1: Design Analysis and Task Identification

**Objective**: Break down the design into implementable components.

**Process**:
1. **Review Design Components**: Walk the detailed-design file section by section; list every component, interface, data model, and contract.
2. **Map to Code Artifacts**: Determine which files, classes, functions need to be created or modified.
3. **Identify Dependencies**: What must be built before what.
4. **Consider Testing Requirements**: Plan for unit, integration (real PostgreSQL), and E2E coverage alongside implementation.
5. **Sequence for Early Validation**: Order tasks to validate core functionality quickly.

**Task Identification Guidelines**:
- Focus on concrete coding activities (writing, modifying, testing code).
- Each task should produce working, testable code.
- Tasks should build incrementally on previous work.
- Avoid tasks that can't be completed by a coding agent (e.g., "deploy to prod", "get user feedback").

### Step 2: Task Structuring and Hierarchy

**Principles**:
1. **Two-Level Maximum**: Phase (top level) + numbered sub-tasks. Avoid deeper nesting.
2. **Logical Grouping**: Group related sub-tasks under one phase.
3. **Sequential Dependencies**: Order so each builds on previous work.
4. **Testable Increments**: Each sub-task results in testable functionality.

**Hierarchy pattern (already baked into skeleton)**:
```
Phase 1: [Epic / Major Component]
  - [ ] 1.1 [Specific implementation task]
  - [ ] 1.2 [Specific implementation task]

Phase 2: [Next Epic]
  - [ ] 2.1 [Specific implementation task]
```

### Step 3: Task Definition and Specification

Every sub-task MUST include:
1. **Clear Objective** — what specific code to write or modify.
2. **Implementation Details** — specific files, components, functions.
3. **Requirements Traceability** — `_Requirements: [Goal ID]_`.
4. **Design Traceability** — `_Design: [Sec X.Y]_` linking back to the detailed-design document.
5. **Acceptance Criteria** — implicit per task, explicit at phase level.
6. **Testing Expectations** — every phase has at least one test sub-task.

**Good task example**:
```markdown
- [ ] 2.1 Create User model with validation
  - Implement User class with email, password, name, createdAt fields
  - Add email validation (RFC 5322) and password strength (8+ chars, mixed case, digits)
  - _Requirements: 1.2, 2.1_ — _Design: Sec 6.1_
```

**Poor task example**:
```markdown
- [ ] 2.1 Build user stuff
  - Make user things work
  - _Requirements: 1.2_
```

### Step 4: Dependency Management and Sequencing

**Dependency types**:

1. **Technical dependencies** — code components that must exist first (DB model before service that uses it, middleware before protected endpoint).
2. **Logical dependencies** — features that build conceptually on others (password reset after authentication).
3. **Data dependencies** — tasks requiring specific data/state to exist (dashboard needs seeded users).

**Sequencing strategies** (declare the chosen one in skeleton):

- **Foundation-First** — interfaces → models → data access → services → API → integration. Best for: new projects, complex interdependencies.
- **Feature-Slice** — end-to-end vertical slices, feature by feature. Best for: MVPs, user-facing apps.
- **Risk-First** — most uncertain/complex parts first. Best for: high-uncertainty projects, POCs.
- **Hybrid** — minimal foundation → high-risk/high-value slice → expand. Best for: most real-world specs.

**Handling circular dependencies**:
- **Interface extraction** — define `IService` first, then implementations.
- **Layered approach** — build a minimal base, then enhance each side in turn.
- **Event-driven decoupling** — use an event bus between the two services.

### Step 5: Task Validation and Refinement

**Quality criteria**:
1. **Actionable** — executable without more clarification.
2. **Specific** — names the file/function/component.
3. **Testable** — produces code that can be validated.
4. **Incremental** — builds on prior tasks without big complexity jumps.
5. **Complete** — covers every design element that requires implementation.

**Validation questions**:
- Can a developer start coding immediately from this description?
- Does this task produce working, testable code?
- Is the requirement it implements clearly identified?
- Does it build logically on previous tasks?
- Is the scope appropriate (not too big, not too small)?

## Task Categories and Patterns

Use these as a mental checklist when breaking down a phase.

### Foundation Tasks
**Purpose**: Establish core structure and interfaces.
**Examples**: project/directory setup, core interfaces, base utilities, test framework config.

### Data Layer Tasks
**Purpose**: Data models and persistence.
**Examples**: Drizzle schemas, migrations, repository/query functions, DB access tests.

### Business Logic Tasks
**Purpose**: Core feature functionality.
**Examples**: service classes (Elysia service pattern), workflow logic, business-rule validation.

### API / Interface Tasks
**Purpose**: External endpoints and contracts.
**Examples**: Elysia controllers, request/response models (Elysia.t / zod), error handling, API integration tests.

### Integration Tasks
**Purpose**: Wire components together.
**Examples**: DI wiring, plugin registration, frontend ↔ backend integration, E2E tests.

## Task Scope Guidelines

**Appropriate scope**:
- Completable in 1–4 hours of focused work.
- Produces working, testable code.
- Has clear completion criteria.
- Builds incrementally.

**Too large**: "Implement complete user management system."
**Too small**: "Add semicolon to line 42."
**Just right**: "Create User model with validation methods."

## Requirements and Design Traceability

Every task MUST carry:
- `_Requirements: [Goal ID(s)]_` — links to the detailed-goal file.
- `_Design: [Sec X.Y]_` — links to the detailed-design file.

The Requirements Coverage Matrix at the bottom of the skeleton MUST be filled in. Every detailed goal appears at least once; every task either maps to a goal or is removed.

## Persistence Verification (project rule)

When a phase touches persistence, the checklist is not complete until it contains BOTH:
1. **Logic tests** — unit tests for pure logic with no DB.
2. **Real PostgreSQL test-DB tests** — write/read round-trips, transactions, constraints, workspace isolation.

This is non-negotiable per `spec-rule.md`.

## Common Task Planning Pitfalls

### Pitfall 1: Tasks Too Abstract
**Problem**: "Implement user management."
**Solution**: "Create User model with email validation and password hashing."

### Pitfall 2: Missing Dependencies
**Problem**: Tasks that can't be completed because prerequisites aren't built.
**Solution**: Sequence tasks so each builds on completed work; make the Dependency Order section explicit.

### Pitfall 3: Non-Coding Tasks
**Problem**: "Deploy to production", "Get user feedback".
**Solution**: Keep tasks scoped to coding, testing, and implementation only. Operational items go in the main spec file.

### Pitfall 4: Monolithic Tasks
**Problem**: Tasks that try to implement entire features at once.
**Solution**: Break into smaller, incremental steps (1–4h each).

### Pitfall 5: Missing Test Tasks
**Problem**: Only implementation tasks, no tests.
**Solution**: Every phase MUST include test sub-task(s); persistence-bound phases MUST include DB-backed tests.

### Pitfall 6: Missing Traceability
**Problem**: Tasks with no `_Requirements_` / `_Design_` reference, or goals with no covering task.
**Solution**: Fill the Requirements Coverage Matrix and refuse to start execution until gaps are closed.

## Planning Quality Checklist

Before locking the checklist, verify:

**Completeness**:
- [ ] All detailed-design components are covered by implementation tasks
- [ ] All detailed goals are addressed by one or more tasks (matrix complete)
- [ ] Testing tasks are included for all major functionality
- [ ] Integration tasks connect all components

**Clarity**:
- [ ] Each task has a clear, specific objective
- [ ] Task descriptions specify files/components to create
- [ ] Requirements and Design references are included for each task
- [ ] Completion criteria are implicit or explicit

**Sequencing**:
- [ ] Tasks respect dependencies
- [ ] Early tasks establish foundation for later work
- [ ] Core functionality before optional features
- [ ] Integration tasks come after component implementation

**Feasibility**:
- [ ] Each task is appropriately scoped (1–4h)
- [ ] Tasks can be executed by a coding agent
- [ ] No tasks require external/manual processes
- [ ] Task complexity increases gradually

**Project-specific**:
- [ ] Every phase has Skill activation listed
- [ ] Every phase has Read first source files listed
- [ ] Persistence-bound phases have both logic and DB-backed test tasks
- [ ] Workspace isolation is covered where applicable
- [ ] Approval Gate is present and remains `Pending Confirmation` until the user/stakeholder explicitly approves code execution

## Task Execution Guidance

### Preparing for Implementation

Before starting any phase:
- [ ] Implementation checklist Approval Gate is `Approved`
- [ ] Detailed Goal and Detail Design files reviewed
- [ ] Skill(s) for this phase activated
- [ ] Read first source files read
- [ ] Prior phases marked complete
- [ ] Local dev + test environment working

### Execution Flow (Per Task)

**Phase 1: Task Analysis**
1. Read task details thoroughly.
2. Review `_Requirements_` and `_Design_` references.
3. Check dependencies — all prerequisite tasks `[x]`?
4. Plan implementation approach.
5. Identify success criteria.

**Phase 2: Implementation**
1. Mark task `[/]` (in progress).
2. Write failing tests first when applicable.
3. Implement incrementally.
4. Test continuously.
5. Document non-obvious decisions inline.

**Phase 3: Validation and Completion**
1. Run all tests (logic + DB where applicable).
2. Verify against `_Requirements_`.
3. Check integration with existing components.
4. Review code quality, remove debug code.
5. Append an Execution Log entry.
6. Mark task `[x]`.

### Handling Issues During Execution

**Unclear requirements**: Re-read detailed-goal + detailed-design; if still unclear, STOP and clarify — do not guess.

**Missing dependency**: If a prerequisite is truly missing, either complete it first or add the missing task and adjust sequence. Log the change.

**Tests failing**: Understand root cause before patching. If the design is wrong, update `detailed-design.md` AND the checklist — do not silently diverge.

**Scope creep**: Stick to the task. If extra work emerges, record it in Deferred Items; do not expand the current task.

**Design drift**: If implementation reveals the design is wrong, STOP, update `detailed-design.md`, then update the affected tasks before resuming. The three files (goal / design / checklist) MUST stay in sync.

### Task Status Management

**Statuses** (match Task Status Legend in skeleton):
- `[ ]` Not started
- `[/]` In progress — one task at a time ideally
- `[x]` Complete — all acceptance criteria met, tests passing
- `[!]` Blocked — add a note with the blocker

**Update discipline**:
- Flip to `[/]` BEFORE starting work.
- Flip to `[x]` only when acceptance criteria + tests all pass.
- Never flip multiple tasks to `[x]` at once without running tests.

### Documentation During Execution

**Execution Log entries** — one per work session (see skeleton format). Each entry records:
- Date
- Phase/Task touched
- Files modified
- Summary of what was done
- Decisions deviating from design (trigger update to `detailed-design.md`)
- Blockers

**Commit messages** — reference phase/task IDs (e.g., "Phase 3.6: add DB-backed round-trip test for Foo") so history traces to the checklist.

## Adapting the Process

**Small specs**: Combine related sub-tasks; keep phases to 2–3.
**Large specs**: Maintain strict phase boundaries; over-communicate dependencies.
**Team specs**: Use parallelizable phases, assign owners, enforce consistent coding standards across authors.

## Integration with Spec Workflow

**From Detailed Goals**: every task traces to a goal via `_Requirements_`.
**From Detail Design**: every task traces to a design element via `_Design_`. Phase boundaries mirror component boundaries.
**Back to Design**: if execution reveals design gaps, update `detailed-design.md` before changing tasks.
**To Spec Review**: the Files Changed Summary and Execution Log provide the demo evidence and retrospective input.
