# Spec Rules

## Purpose
This document defines the structure and process for `spec-<feature-slug>-<status>.md` files to ensure consistency, transparency, and continuous improvement during development. Each explicitly requested or confirmed spec will be fully documented, including planning, execution, review, and retrospective, to make the next spec better.

## Spec Process Opt-In Gate
The specs-and-process workflow is **not** the default for every agent task.

Agents **MUST NOT** create, rename, or update files under `llm-documents/specs-and-process/specs/` unless one of these is true:
- The user explicitly asks to create, plan, design, checklist, or run a spec process.
- The user explicitly asks to work from an existing spec, story, or implementation checklist.
- The agent asks whether to use the spec process and the user confirms.

For ordinary code, docs, bug-fix, refactor, review, or investigation requests, execute the direct task with a lightweight plan and normal verification. Do not create missing spec documents as a prerequisite.

If intent is ambiguous, stop before creating or editing spec artifacts and ask whether the user wants to run the spec process.

All phase gates in this document apply only after this opt-in gate is satisfied.

## File Naming Rules
- **Spec Folder**: Each new spec **MUST** have its own dedicated folder under `llm-documents/specs-and-process/specs/`, named `spec-<feature-slug>/`.
  - Example: `llm-documents/specs-and-process/specs/spec-work-item-priority/`, `llm-documents/specs-and-process/specs/spec-project-type-settings/`, `llm-documents/specs-and-process/specs/spec-report-export/`.
  - `<feature-slug>` **SHOULD** describe the feature or capability, not a sequence number.
  - Use lowercase kebab-case for `<feature-slug>`: `work-item-priority`, `project-type-settings`, `report-export`.
  - Avoid generic or numeric-only names such as `spec-1/`, `spec-2/`, or `spec-misc/`.
  - All files for that spec **MUST** be stored inside this folder.
  - Do **NOT** place spec-specific files directly under `llm-documents/specs-and-process/`, under `rules/`, or inside another spec's folder.
  - Shared process files and reusable templates belong only under `llm-documents/specs-and-process/rules/`.
- File name: `spec-<feature-slug>-<status>.md` where `<status>` is `pending` (not started), `inprocess` (ongoing), `complete` (finished).
- Example: `spec-work-item-priority-pending.md`, `spec-project-type-settings-inprocess.md`, `spec-report-export-complete.md`.
- Update status when changing stages: pending → inprocess when starting, inprocess → complete when review is done.
- **Supplementary Documents**: In addition to the main spec file, each spec **MUST** have the following 3 files (produced in this exact order):
  - `spec-<feature-slug>-detailed-goal.md`: Decomposes spec goals into detailed, clear, and measurable objectives (the "What" and "Why").
  - `spec-<feature-slug>-detailed-design.md`: Technical design document that translates approved detailed goals into architecture, components, data models, error handling, and testing strategy (the "How"). This file is the bridge between requirements and tasks and **MUST** be created before the implementation checklist.
  - `spec-<feature-slug>-implementation-checklist.md`: A detailed technical checklist, breaking down work into specific tasks, identifying affected files, recording execution progress, and separating logic validation from database-backed verification when persistence is involved.
    - **MUST include** a `Dependency Order` section showing which phases depend on others.
    - **MUST include** a `LLM Agent — Skill Activation Per Phase` table listing: which `.agents/skills/*/SKILL.md` to activate and which source files to read before modifying, for each phase.
    - **MUST include** per-phase `Skill` and `Read first` annotations so an LLM agent can execute each phase independently without human guidance.
- **Expected Folder Layout**:
  ```text
  llm-documents/specs-and-process/
    rules/
      spec-rule.md
      spec-template.md
      detailed-goal-template.md
      detailed-design-template.md
      implementation-checklist-template.md
      implementation-guide.md
    specs/
      spec-<feature-slug>/
        spec-<feature-slug>-<status>.md
        spec-<feature-slug>-detailed-goal.md
        spec-<feature-slug>-detailed-design.md
        spec-<feature-slug>-implementation-checklist.md
  ```

## Phase Gate Rules
After the Spec Process Opt-In Gate is satisfied, the spec workflow is strictly **Goals → Design → Implement**. Agents and humans **MUST NOT** skip or merge phases.

Each transition requires explicit confirmation from the user/stakeholder:
- **Goals → Design**: Stop after producing `spec-<feature-slug>-detailed-goal.md`. Present a concise summary of goals, scope, acceptance criteria, data/persistence scope, open questions, and deferred items. Wait for explicit confirmation before creating or editing `detailed-design.md`.
- **Design → Implement**: Stop after producing `spec-<feature-slug>-detailed-design.md`. Present a concise summary of architecture, Mermaid flows, components, database/table design, API contracts, risks, and testing strategy. Wait for explicit confirmation before creating or editing `implementation-checklist.md` or writing production code.
- **Checklist → Code Execution**: Stop after producing `spec-<feature-slug>-implementation-checklist.md`. Present phase order, task coverage, affected files, test plan, and unresolved risks. Wait for explicit confirmation before implementing any code.

Confirmation must be explicit, for example: "approved", "confirm", "go to design", "go to implementation", or an equivalent clear instruction. If the user asks for "full planning" or "do everything", still complete only the current phase and request confirmation before moving to the next phase.

If a phase output is not detailed enough, revise that same phase document until confirmed. Do **NOT** compensate by moving to the next phase.

## Spec File Structure
Each `spec-<feature-slug>-<status>.md` file must follow this structure for easy tracking and improvement:

### 1. Spec Goal
- The overall goal of the spec, concise and measurable.
- Example: "Establish core foundation to support CRUD work items."

### 2. Spec Stories
- List of user stories in standard format: "As a [role], I want [feature] so that [benefit]."
- Each story should have implicit or explicit acceptance criteria.

### 3. Spec Planning
- **Start and End Date**: Exact timing.
- **Capacity**: Estimated available effort (e.g., story points or hours).
- **Testing Strategy**: For every backend story, define how logic will be tested and, when the story touches persistence, how the project's real datastore will be used in tests to verify writes, reads, transactions, and constraints. For VidCom this is **SQLite in application-data plus the real filesystem** in a temp directory — never a mock of `node:fs` or an in-memory stand-in for the datastore.
- **Risks Identified**: Potential risks and mitigation plans.
- **Commitments**: What the team commits to completing.

### 4. During Spec
- **Daily Standups Summary**: Summary of daily issues, progress.
- **Impediments**: Issues arisen and how to resolve them.
- **Adjustments**: Changes in scope or plan if needed.

### 5. Spec Review
- **Completed Stories**: List of completed stories with demo evidence.
- **Demo Outcomes**: Demo results for stakeholders.
- **Feedback**: Feedback from users/stakeholders, acceptance.

### 6. Spec Retrospective
- **What Went Well**: Good points, successes.
- **What Didn't Go Well**: Issues, errors.
- **Improvements**: Suggestions for improvement for the next spec (e.g., better estimation, communication).

### 7. Next Spec Adjustments
- **Process Changes**: Process changes based on retrospective.
- **Carry-over Items**: Unfinished stories, reasons.
- **Lessons Learned**: Key lessons to apply.

## LLM Workflow & Instructions
> [!IMPORTANT]
> This section is specifically for LLM Agents (like Claude, ChatGPT, Gemini) to understand how to interact with this documentation system.

### 1. Context Loading Protocol
When you are asked to work on a spec or an active spec-backed task, you **MUST** follow this reading order to build your context:
1.  **Read `llm-documents/specs-and-process/rules/spec-rule.md`** (This file): To understand the rules and your role.
2.  **Read `llm-documents/specs-and-process/rules/spec-template.md`**: To understand the structure of the main spec file.
3.  **Read the specific Spec File** (e.g., `llm-documents/specs-and-process/specs/spec-[feature-slug]/spec-[feature-slug]-pending.md`): To get the high-level goals and stories.
4.  **Read `llm-documents/specs-and-process/rules/detailed-goal-template.md`**: To understand how to break down goals.
5.  **Read `llm-documents/specs-and-process/rules/detailed-design-template.md`**: To understand how to produce the technical design document that sits between goals and tasks.
6.  **Read `llm-documents/specs-and-process/rules/implementation-checklist-template.md`**: To understand how to create technical tasks.
7.  **Read `llm-documents/specs-and-process/rules/implementation-guide.md`**: To understand how to EXECUTE an existing checklist (per-task loop, quality gates, design-drift handling, anti-patterns). Required before starting any task.

### 2. Autonomous Planning Protocol
If you are asked to "Plan Spec [Feature Name]" or "Break down stories for Spec [Feature Name]", follow these steps:

**Step 1: Analyze & Create Detailed Goals**
- Read the `Spec Stories` in the main spec file.
- Create `llm-documents/specs-and-process/specs/spec-[feature-slug]/spec-[feature-slug]-detailed-goal.md` based on the template.
- **CRITICAL**: You must link back to the main spec file in the header.
- Break down each story into specific technical requirements (Frontend/Backend) and Acceptance Criteria.
- **PHASE GATE**: Stop here. Summarize the detailed goals and ask for explicit confirmation before starting Step 2. Do not create `detailed-design.md` yet.

**Step 2: Create Detail Design Document**
- Read the `spec-[feature-slug]-detailed-goal.md` you just created.
- Create `llm-documents/specs-and-process/specs/spec-[feature-slug]/spec-[feature-slug]-detailed-design.md` based on `detailed-design-template.md`.
- **CRITICAL**: You must link back to the `detailed-goal` file in the header.
- Follow the 7-step Design Phase process: Requirements Analysis → Research → Architecture → Components/Interfaces → Data Models → Error Handling → Testing Strategy.
- Document every material technology/architecture choice using the Decision Record pattern (Context / Options / Decision / Rationale / Implications).
- Include component diagrams (Mermaid) when helpful and map each design element back to a specific detailed goal for traceability.
- Complete the Quality Checklist at the end of the template (Completeness, Clarity, Feasibility, Traceability) before moving on.
- **PHASE GATE**: Stop here. Summarize the design and ask for explicit confirmation before starting Step 3. Do not create `implementation-checklist.md` or write code yet.

**Step 3: Create Implementation Checklist**
- Read both the `detailed-goal` and `detailed-design` files you created.
- Create `llm-documents/specs-and-process/specs/spec-[feature-slug]/spec-[feature-slug]-implementation-checklist.md` based on the template.
- **CRITICAL**: You must link back to both the `detailed-goal` file and the `detailed-design` file.
- Convert every "Requirement", "Acceptance Criteria", and designed component/interface/data model into a check-box task.
- Group tasks by Frontend/Backend/Database and align phase boundaries with the component boundaries defined in the design document.
- **PHASE GATE**: Stop here. Summarize the implementation plan and ask for explicit confirmation before writing code.

**Step 4: Update Main Spec File**
- Update the `Spec Planning` section of `spec-[feature-slug]-pending.md` with the estimated capacity and links to the three supplementary files (`detailed-goal`, `detailed-design`, `implementation-checklist`).

### 3. Execution Protocol
When you are asked to "Implement Task Y" or "Work on Story Z" in an active, approved spec:
1.  **Load the Execution Playbook**: Read `llm-documents/specs-and-process/rules/implementation-guide.md` — the per-task loop, quality gates, design-drift rule, and anti-patterns defined there are mandatory during execution.
2.  **Check Approval Gates**: Confirm the detailed goals, detailed design, and implementation checklist are all explicitly approved. If any gate is `Pending Confirmation` or `Needs Revision`, STOP and ask for confirmation or revise the current phase.
3.  **Check the Checklist**: Open `spec-[feature-slug]-implementation-checklist.md`. Find the phase you are about to implement.
4.  **Activate Skills**: Read the `Skill` annotation for that phase — open and read the listed `.agents/skills/*/SKILL.md` file(s) before writing any code.
5.  **Read Source Files**: Read the `Read first` annotation for that phase — open and read the listed source files in full (or search the specified function) before modifying anything.
6.  **Mark In-Progress**: Find the relevant task and mark it as `[/]` (if supported) or note that you are working on it.
7.  **Execute**: Write the code following the Per-Task Execution Loop in `implementation-guide.md` (Analyze → Prepare → Implement → Validate → Log).
8.  **Update Log**: Append an entry to the `Execution Log` section in the checklist file using the log format from the guide.
9.  **Mark Complete**: Mark the task as `[x]` only after all quality gates from `implementation-guide.md` Sec 4 pass.
10. **Honour Design Drift**: If reality diverges from `detailed-design.md`, follow `implementation-guide.md` Sec 6 — update the design document BEFORE resuming implementation.

If the user asks for an ordinary code/doc change and does not mention a spec, story, or checklist, do not create spec files automatically. Execute the direct task normally, or ask whether to start the spec process if the scope is too broad or ambiguous.

## Planning and Documentation Process
Run this process only after the Spec Process Opt-In Gate is satisfied.

1.  **Create Spec Folder and Pending File**: Based on `spec-rule.md`, create `specs/spec-<feature-slug>/`, then create `spec-<feature-slug>-pending.md` inside it with initial User Stories.
2.  **Decompose Goals**: Create `spec-<feature-slug>-detailed-goal.md` inside the spec folder to clarify each sub-goal, scope, and detailed requirements.
    - **Confirm before continuing**: Do not start detail design until the user/stakeholder approves the detailed goals.
3.  **Produce Detail Design**:
    - Based on `detailed-goal`, conduct research and create `spec-<feature-slug>-detailed-design.md` inside the spec folder using `detailed-design-template.md`.
    - This file translates approved goals into system architecture, components and interfaces, data models, error handling strategy, and testing strategy.
    - Every material technology/architecture decision **MUST** be recorded using the Decision Record pattern (Context / Options / Decision / Rationale / Implications).
    - The document **MUST** demonstrate full traceability: every detailed goal is addressed by at least one design element, and every design element maps back to a goal.
    - The Quality Checklist at the end of the template **MUST** be completed before moving on.
    - **Confirm before continuing**: Do not create the implementation checklist or write code until the user/stakeholder approves the detailed design.
4.  **Build Technical Checklist**:
    - Based on `detailed-goal` AND `detailed-design`, analyze current source code.
    - Create `spec-<feature-slug>-implementation-checklist.md` inside the spec folder using `implementation-checklist-template.md`.
    - This file must decompose work into specific tasks, specifying files/components to modify, technology used, and Acceptance Criteria for each task.
    - Phase boundaries and component responsibilities **MUST** be consistent with the components and interfaces defined in `detailed-design`.
    - **MUST include** a `Dependency Order` diagram showing phase dependencies.
    - **MUST include** a `LLM Agent — Skill Activation Per Phase` table: for each phase, list which `.agents/skills/*/SKILL.md` to activate and which source files to read before modifying.
    - **MUST include** per-phase `Skill` and `Read first` annotations directly on each phase header.
    - For persistence-bound work, split validation into explicit logic-test and real-database-test tasks.
    - **Confirm before continuing**: Do not implement code until the user/stakeholder approves the implementation checklist.
5.  **Update Spec Planning**: Based on the checklist, estimate Story Points and fill in the `Spec Planning` section of `spec-<feature-slug>-pending.md`, including links to `detailed-goal`, `detailed-design`, and `implementation-checklist`.
6.  **Record Execution Process**: During the spec, `implementation-checklist.md` must be continuously updated to record technical decisions, files created/modified (`Deliverables Created`), status of each task, and the logic/database tests added or updated. If design decisions change during execution, update `detailed-design.md` alongside the checklist to keep them in sync.

## Post-Spec Process
1. Complete execution and record sections 4-6 immediately after spec end.
2. Discuss retrospective with the team to fill section 7.
3. Use insights to plan the next spec better.
4. Commit and share the file with stakeholders.

## Benefits
- Transparency: Everyone knows progress and issues.
- Improvement: Retrospective helps avoid repeating errors.
- Documentation: Spec history for future reference.

## Templates Reference
To ensure consistency, please use the following template files:
- **Spec Template**: [spec-template.md](./spec-template.md)
- **Detailed Goal Template**: [detailed-goal-template.md](./detailed-goal-template.md)
- **Detailed Design Template**: [detailed-design-template.md](./detailed-design-template.md)
- **Implementation Checklist Template**: [implementation-checklist-template.md](./implementation-checklist-template.md)
- **Implementation Guide (execution playbook)**: [implementation-guide.md](./implementation-guide.md)
