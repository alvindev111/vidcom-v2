Spec Editing Experience — Deep Post-Implementation Review

Audit date: 2026-08-20
Repository: alvindev111/vidcom-v2
Branch reviewed: feat-editor
Source identity reviewed: d2deb571847fcc105aca402ffa1707a8ec77482d
Comparison base: main@57f602f57cefda11a505240a87da641475a00a90
Review mode: post-implementation audit; static source review plus verification of the evidence already recorded in the checklist and CI configuration
Roles: Specs Manager (SM) · Product Owner (PO) · Developer/Security Reviewer (Dev)

Remediation status: CLOSED 2026-08-21 — Goals v8, Design v13 and checklist P12–P18 completed.
Production evidence source: `03a2df5659552ad9638d05888f08b3a0fba38f2f`. Historical S0–P11 evidence
and this audit-time NO-GO remain intact; §14 records the evidence-backed disposition that supersedes it.

1. Executive decision

Audit-time decision: NO-GO for merge/release under the claim that all editing-experience edge cases and security concerns are closed.

The implementation is broad and the execution evidence is substantially better than a normal feature branch: the branch has centralized contracts, real-filesystem integration tests, real-browser tests, MCP contract matrices, packaged smoke tests, cross-platform CI, source-identity evidence, and measured preview refresh latency. The final checklist is therefore not “fake green”.

However, this deeper review expands the acceptance surface beyond the checklist’s known paths and finds defects at trust boundaries, filesystem ownership boundaries, large-file serving, package lifecycle, and draft synchronization. The most important issue is architectural: authored project/catalog JavaScript is executed inside the same trusted browser origin that owns the authenticated UI session.

Finding count

Class

Count

Merge/release meaning

Critical

1

Must be fixed before merge

High

4

Must be fixed before merge or explicitly split behind an unavailable feature flag

Medium

7

Must be fixed before release; several should be fixed before merge because they affect data integrity

Low

1

Protocol correctness/hardening

Governance / coverage gaps

3

Evidence or repository policy is insufficient to claim release readiness

Immediate blockers

C-01 — Preview trust-boundary collapse: untrusted project/catalog script runs with the browser session’s same-origin authority.

H-01 — Incomplete mutation capture can relocate an external entry without restoring it.

H-02 — Internal symlink aliases can cause rename/delete to operate on the symlink target.

H-03 — Path containment is vulnerable to parent-component replacement after validation.

H-04 — A one-byte Range read can still buffer, hash, and copy an entire 500 MB asset.

This document is an independent review artifact. It intentionally does not rename the completed spec, alter historical checklist evidence, or modify production code.

2. Review scope and method

The review followed AGENTS.md and the always-on steering documents, especially:

03-architecture-ddd.md

04-api-design.md

05-mcp-tool-design.md

06-validation.md

07-data-and-storage.md

09-security.md

10-testing.md

11-code-style.md

13-mcp-protocol-compatibility.md

The review did not stop at “does every checklist item have a test?”. It traced capabilities and ownership across:

browser → preview host → authored runtime → authenticated API;

route/MCP → Core use case → WriteAuthority → filesystem capture/publish → journal/recovery;

external editor/watcher races;

catalog network materialization → integrity verification → cache pin → plan/approval/execute;

large upload and large asset-read lifecycles;

draft conflict state → hook projection → visible UI;

SSE and PTY producer → slow consumer;

source test scripts → GitHub workflow → branch policy.

Finding taxonomy

CONFIRMED: the source path itself demonstrates the defect; a regression test is still required before closure.

COVERAGE GAP: no contradictory defect is claimed, but current evidence does not prove the property.

RISK ACCEPTANCE: behavior is real, but severity depends on an explicit product/threat-model decision.

3. Expanded quality criteria

#

Criterion

Status

Review result

1

Requirement traceability R1–R12

Partial

Functional matrix is strong; R1/R4/R5/R7/R8/R9/R11/R12 have deeper gaps below

2

DDD/import boundaries

Pass

Contracts/Core/Adapter/Server separation is generally respected

3

Single write authority

Partial

Main application paths use WriteAuthority; capture/path races weaken its failure invariant

4

Preconditions and exact intent

Pass

Hash/revision/grant binding is generally well designed

5

Crash recovery and atomicity

Partial

Journal flow is strong; a pre-capture failure after rename is not owned by recovery

6

Filesystem containment and symlink safety

Fail

H-01, H-02 and H-03

7

Browser trust isolation

Fail

C-01

8

Loopback Host/CORS/session perimeter

Pass in normal model

Correct against unrelated websites; not a defense against same-origin preview code

9

HTTP contract/status behavior

Partial

Range handling conflates malformed/unsatisfiable with no Range

10

MCP/HTTP schema parity

Pass

Shared contracts and contract matrices are a strong point

11

Destructive approval/audit

Pass

Daemon-issued grant and journal/audit integration are present

12

Large-file memory bounds

Fail

Upload ingress is streamed; asset Range egress is not

13

Resource growth bounds

Partial

File tree, receipt dedupe and slow stream consumers need bounds

14

Cancellation/backpressure

Partial

Upload cancellation is strong; SSE/PTY output lacks explicit backpressure

15

Catalog integrity/lifecycle

Partial

Download bounds are strong; pin release and binary-target reinstall are defective

16

External-edit conflict UX

Partial

Dirty conflicts work; clean external deletion is hidden

17

Frame-grid/timeline invariants

Partial

UI and Core can accept sub-frame timing in several paths

18

Accessibility and keyboard evidence

Not proven

Useful ARIA/keyboard work exists, but no automated accessibility gate

19

Observability/audit durability

Pass

Mutation and tool audit are tied into the datastore transaction

20

Cross-platform packaged behavior

Pass

Existing evidence covers Linux/macOS/Windows and packaged runtime

21

CI enforcement/governance

Fail

Workflows exist, but branch protection and required checks are disabled

22

Dependency/supply-chain scanning

Not proven

No repository gate for SCA, CodeQL or secret scanning was found

23

Long-running soak behavior

Not proven

No evidence for high receipt counts, slow consumers, huge trees or repeated invalid installs

4. Areas that are implemented well

4.1 Central write path and transaction design

packages/core/src/service/write-authority.ts and packages/adapter/src/db/journal.ts provide a serious mutation foundation:

precondition validation;

second validation under the process mutex;

ordered composite steps;

capture before publish;

journal begin/commit/abort/rollback;

revision, event outbox and audit persistence;

approval reserve/consume/invalidate;

recovery and orphan handling;

mutation receipts generated after commit.

No editing route reviewed deliberately writes project content through a second application-level authority.

4.2 Upload ingress

packages/core/src/usecase/ingest-asset.ts, the staging adapter, and the dedicated HTTP/1.1 listener implement several important properties correctly:

raw bounded streaming instead of buffering a 500 MB request;

abort propagation;

magic-byte/type validation;

staged publish;

deterministic collision handling;

cleanup on failure.

H-04 is specifically an egress/read problem; it does not negate the quality of the upload path.

4.3 Catalog network boundary

The catalog adapter has meaningful controls:

HTTPS-only;

fixed upstream host/path model;

public-address DNS validation;

redirect checks;

pinned Git revision;

per-file, package, closure and cache bounds;

staged verification before publication.

The remaining catalog findings concern lifecycle and reinstall planning, not the absence of all security controls.

4.4 Contract and packaged evidence

The branch contains centralized Zod contracts, dual-era MCP tests, browser tests, source-identity checks, real SQLite/temp-filesystem tests, and strict packaged smoke tests. The R4.1c gate was initially left blocked rather than treating skipped tests as proof, then closed only after real browser measurements existed. That process behavior is correct.

5. Confirmed findings

C-01 — Critical — Authored preview code has the authenticated UI’s origin authority

Classification: CONFIRMED
Affected requirements: R4, R7, R9; indirectly every privileged browser capability
Primary files:

src/components/studio/hyperframes-player-environment.ts

src/preview-host/entry.ts

public/preview-host.html

packages/adapter/src/hyperframes/document.ts

packages/server/src/routes/project-reads.ts

packages/server/src/routes/system.ts

packages/server/src/routes/agent-terminal.ts

Observation

The preview environment explicitly states that the host page is same-origin and then reads through frame.contentDocument, the player iframe’s contentDocument, and contentWindow.__vidcomHealth. The outer host iframe is created without a sandbox.

The preview document is built from project-authored HTML/JavaScript. In preview mode the builder injects the health collector, but the existing injectRuntimeAssetGuardDocument() CSP/bootstrap helper is not applied to this path. The preview, runtime, assets, system API, project write API and agent terminal API are served by the same loopback origin.

All non-MCP API routes rely on the browser session cookie. The cookie is HttpOnly and SameSite, which is correct against unrelated sites, but a script already executing on the same origin does not need to read the cookie: browser requests automatically carry it.

Capability chain

An imported project, compromised catalog package, or remote script referenced by authored HTML can attempt to:

read /api/v1/projects and project source;

generate a valid ULID and attach a studio session;

issue source or entity mutations with the current hash/revision;

prepare and execute destructive operations;

read UI-only filesystem roots/entries;

start an agent terminal and send input;

send project data to an external endpoint because the preview has no restrictive CSP.

The exact impact of agent-terminal input depends on the spawned CLI’s authority, but quota/resource consumption and access to browser-only capabilities are already material.

Why existing perimeter controls do not close it

Host-header checks, DNS-rebinding protection, strict CORS and SameSite cookies defend against code on another origin. They do not defend against code that the application itself runs on its trusted origin.

A second listener on the same hostname but another port is also insufficient by itself, because cookies are not port-scoped.

Required remediation

Create a distinct preview security principal:

Prefer an opaque sandbox (sandbox="allow-scripts" without allow-same-origin) or a dedicated host that exposes no privileged API and receives no UI cookie.

Replace direct DOM access with a minimal postMessage protocol:

exact source window;

random nonce;

strict message schema;

explicit message types;

bounded payloads.

Give preview only a short-lived, project-scoped, read-only capability for approved runtime/assets.

Add a preview CSP such as:

default-src 'none';

connect-src 'none' unless a narrowly approved proxy is required;

form-action 'none';

base-uri 'none';

explicit script/style/image/media/font sources.

Add Origin/Fetch-Metadata or anti-CSRF validation to privileged write/system/terminal endpoints as defense in depth.

Treat catalog/project HTML as untrusted executable content in the threat model.

Closure evidence

A real-browser malicious-preview test must prove that authored script cannot:

read project listings/source;

attach a studio session;

write/delete a project file;

enumerate filesystem roots;

start or write to an agent terminal;

beacon data to an arbitrary network origin.

The test must run in test:browser-session and be required on pull requests.

H-01 — High — A failed capture can move an external entry and never restore it

Classification: CONFIRMED
Affected requirements: R3, R5, R8, R11; global mutation safety
Primary files:

packages/adapter/src/fs/mutation-capture.ts

packages/core/src/service/write-authority.ts

tests/adapter/directory-mutation-capture.test.ts

Observation

For an expected file, captureForMutation() renames the target to a rollback path and then hashes the rollback file. If the entry changed to a directory or symlink after validation:

rename(target, rollbackPath) can succeed;

hashRegularFile(rollbackPath) throws;

captureForMutation() has no local finally that restores the renamed entry;

WriteAuthority never pushed this incomplete capture into its captures array;

outer rollback restores only earlier captures.

The bytes may remain in a hidden rollback slot, but the user-visible entry disappears from its original path. This violates the core invariant that a rejected mutation must not alter another actor’s work.

Required remediation

Make capture locally exception-safe once rename succeeds.

If the original target is still absent, rename the rollback slot back.

If a new target appeared, do not overwrite it; quarantine the rollback entry, mark recovery required, and return a typed conflict.

Ensure every post-rename failure path has deterministic ownership.

Closure tests

Use real filesystem tests with a deterministic barrier between rename and hash:

expected file becomes a directory;

expected file becomes a symlink;

expected-absent target becomes a directory;

hash/open fails after rename;

a new target appears before restoration;

no orphan rollback slot on ordinary failure;

external entry remains at the original path.

H-02 — High — CRUD on an internal symlink alias can mutate the target instead of the alias

Classification: CONFIRMED
Affected requirements: R5 file manager
Primary files:

packages/adapter/src/fs/resolve.ts

packages/adapter/src/fs/workspace-fs.ts

packages/core/src/usecase/entry-crud.ts

Observation

Containment resolution follows an existing symlink and returns the canonical target when that target remains inside the project. The tree reader classifies a symlink Dirent as a normal file because it distinguishes only isDirectory() from “everything else”.

Entry CRUD then resolves and stats the canonical path. A root symlink can therefore appear as a normal regular file. Rename/delete capture and publish against the target, while the API intent, event and UI still name the alias.

Example:

alias.html -> index.html

Deleting or renaming alias.html can move/delete index.html and leave alias.html dangling.

Required remediation

Choose and enforce one policy:

simplest and safest: reject every symlink component and symlink root for authored CRUD; or

represent symlinks explicitly and operate on the directory entry through a secure parent-handle API.

The file tree must not label a symlink as an ordinary editable file.

Closure tests

root alias to internal file;

root alias to internal directory;

parent component symlink;

link to outside project;

rename/delete/create through each link;

event/audit paths match the entry actually mutated;

no target mutation when the alias operation is rejected.

H-03 — High — Parent path components can be replaced after containment validation

Classification: CONFIRMED design weakness; exploit requires a cooperating local process/editor
Affected requirements: R5, R8, R11; all filesystem mutations
Primary files:

packages/adapter/src/fs/resolve.ts

packages/adapter/src/fs/workspace-fs.ts

packages/adapter/src/fs/mutation-capture.ts

Observation

Containment is checked by resolving path strings. Later capture/publish operations use the returned absolute string. The process mutex serializes VidCom mutations, but not an external editor or local process.

For an absent leaf:

VidCom validates /project/assets/new.png;

another process renames /project/assets and creates /project/assets -> /outside;

a later open/write/rename using /project/assets/new.png follows the new parent symlink.

A second precondition check over the leaf does not prove parent-component identity. The same class of problem exists for directory capture, which records existedBefore but not stable directory identity.

Required remediation

State the local adversary/concurrency threat model explicitly.

Reject symlink components at the authored mutation boundary.

Revalidate all parent components immediately before capture and publish.

For a strict guarantee, use descriptor-relative/no-follow operations or a small native secure-path layer; path strings alone cannot make a multi-step transaction race-free.

Track parent identity (dev/ino on POSIX or equivalent file ID) across validation/capture/publish where possible.

Closure tests

Introduce deterministic barriers and replace a parent directory between:

resolve → capture;

capture → publish;

validation pass 1 → validation pass 2.

Assert that no write appears outside the project and that the operation returns a typed conflict/recovery state.

H-04 — High — Range reads buffer, hash and copy the whole asset

Classification: CONFIRMED
Affected requirements: R4 preview, R5 assets, R10 thumbnails, R11 mount/playback
Primary files:

packages/server/src/routes/project-reads.ts

packages/core/src/usecase/project-reads.ts

packages/adapter/src/fs/workspace-fs.ts

Observation

The route calls readAsset() before parsing Range. The adapter uses readFile() and computes SHA-256 over the full byte array. The route then creates additional copies with Uint8Array.from(), and a ranged response also slices/copies the selected portion.

Therefore:

Range: bytes=0-0

can still read and hash a 500 MB file and allocate another full-size response copy.

Repeated media seeks or concurrent previews can exceed the daemon’s memory budget. C-01 also gives malicious preview content an easy local memory-amplification primitive.

Required remediation

Parse and validate Range before reading bytes.

Add statAsset() and openAssetRange(start, end) ports.

Stream from a file handle with backpressure and cancellation.

Do not materialize a full Uint8Array.

Persist the content hash at ingestion or cache it against a watcher-invalidated file identity; do not rehash 500 MB for every seek.

Bound concurrent asset streams.

Closure tests

sparse 500 MB file;

bytes=0-0, suffix, middle and end ranges;

8–20 concurrent range consumers;

cancellation halfway through;

strict RSS delta;

no full-file read instrumentation;

valid ETag behavior retained.

M-01 — Medium — File-tree and recursive entry operations have no total growth bound

Classification: CONFIRMED resource-bound gap
Affected requirements: R5
Primary files:

packages/adapter/src/fs/workspace-fs.ts

packages/core/src/usecase/entry-crud.ts

src/components/studio/file-explorer.tsx

packages/contracts/src/dto.ts

Observation

readTree() recursively expands directories with no maximum nodes, depth, per-directory entries, elapsed time or response bytes. The ignore list excludes node_modules, .git and .hyperframes, but not .vidcom. The UI recursively renders the complete returned tree. Recursive delete planning has a concurrency cap, but no total node/depth/plan-size limit.

A “200 files pass” test proves one sample size; it does not establish a production bound.

Impact

promise fan-out and memory growth;

huge JSON response/schema parse;

huge React tree;

exposure of internal .vidcom state names;

oversized delete plan, backup, journal and approval binding.

Required remediation

exclude .vidcom and other internal/protected roots from the user tree;

define hard limits for node count, depth, entries per directory and serialized plan bytes;

use lazy/paginated directory reads;

return deterministic 413/422 with a machine-readable reason;

virtualize large UI lists.

M-02 — Medium — Catalog cache pins leak on normal planner errors

Classification: CONFIRMED
Affected requirements: R7, R9
Primary file: packages/core/src/usecase/catalog-install.ts

Observation

After materialize() succeeds, planInstall() owns release(). It calls release() only in a catch for thrown exceptions. Direct return err(...) branches for integrity failure, parse failure and planner rejection bypass that catch. prepareCatalogInstall() and executeCatalogInstall() immediately return when planInstall() is not OK, so no later finally releases the pin.

Repeated distinct invalid packages can remain pinned until daemon restart and defeat cache eviction.

Required remediation

Use explicit ownership transfer:

planInstall() releases in finally unless it successfully transfers the pin in PlannedInstall;

callers always release the transferred pin in their own finally.

Closure tests

Assert zero retained pins after:

integrity mismatch;

parse failure;

policy rejection;

unsupported mount;

abort;

thrown adapter error;

prepare and execute failure.

M-03 — Medium — Catalog packages with binary files fail reinstall/reuse planning

Classification: CONFIRMED
Affected requirements: R7, R9
Primary files:

packages/core/src/usecase/catalog-install.ts

packages/core/src/domain/path-policy.ts

packages/core/src/domain/plan-catalog-install.ts

Observation

readHashOf() resolves every package target using read-source. That policy accepts source extensions such as HTML/CSS/JS/JSON/SVG but rejects PNG, video, audio and font extensions.

On first install the binary target is absent, so installation can succeed. On reinstall, the existing binary hash is read as null, which the planner interprets as absent. It can produce a create action; WriteAuthority then discovers the file already exists and rejects the mutation.

Required remediation

Add a package-target hash operation that reads any allowed authored package file without exposing it as a browser-served asset.

Never convert “path rejected/unreadable” into “absent”.

Keep purpose validation and target hashing consistent with the write plan.

Closure tests

A package containing HTML + PNG + WOFF2 must pass:

first create;

identical reuse;

replace;

skip;

same version/different bytes rejection;

external binary edit between prepare and execute.

M-04 — Medium — A clean file deleted outside the app becomes a hidden stale tab

Classification: CONFIRMED
Affected requirement: R8
Primary files:

src/lib/studio/draft-store.ts

src/components/studio/use-source-files.ts

src/components/studio/editor-panel.tsx

Observation

The reducer correctly represents deletion as incoming content: null. The hook’s silent-refresh effect intentionally skips incoming === null. Later, the hook hides the conflict projection whenever entry.draft === base.code.

For a clean open file deleted externally:

stale text remains visible;

no “deleted outside” conflict UI is exposed;

the file is not dirty;

unsaved-exit protection does not count it;

save is disabled internally and returns without visible feedback.

The reducer test covers deletion with a dirty draft, not the clean-hook projection.

Required remediation

Model source conflict independently from editor dirtiness. Choose a product behavior:

auto-close and show a durable notice; or

show “deleted outside” with Recreate/Close actions even when the draft was clean.

Closure tests

Real hook/browser cases:

clean file deleted;

dirty file deleted;

parent directory renamed/deleted;

deletion during save;

delete followed by recreate;

stream gap followed by deleted refetch.

M-05 — Medium — Frame-grid alignment is not authoritative

Classification: CONFIRMED behavior; final severity depends on product decision
Affected requirements: R1, R12
Primary files:

src/lib/studio/snap.ts

src/lib/studio/editor-interaction.ts

packages/core/src/usecase/project-writes.ts

packages/core/src/domain/plan-scene-order.ts

Observation

Free drag is rounded to a frame only when snap is disabled. With snap enabled and no candidate, raw time is retained; an arbitrary playhead candidate can also be sub-frame. Existing tests explicitly accept 2.55 seconds at 30 fps, which is 76.5 frames.

Core timing and group-shift planners validate finite/non-negative values but do not validate or normalize against project FPS. Direct HTTP/MCP callers can therefore create new sub-frame timing independent of the UI.

This also conflicts with the architecture rule that content invariants belong in Core, not only in a component reducer.

Required remediation

Decide whether legacy sub-frame authored values are preserved.

Require every new mutation to be frame-aligned in Core.

Normalize snap candidates and unsnapped values consistently.

Return a typed validation error rather than silently changing direct API input unless normalization is the approved contract.

M-06 — Medium — Undo-history receipt dedupe grows for the daemon lifetime

Classification: CONFIRMED long-running resource issue
Affected requirement: R3
Primary file: packages/server/src/service/mutation-history.ts

seenReceiptIds is global to the service lifetime. Undo/redo stacks are bounded to 50 entries, but cleared, detached or evicted receipt IDs are not removed from the set. A long-running daemon retains every observed receipt ID.

Use a bounded LRU or tie dedupe retention to journal/event retention. Add a 100k+ receipt soak test and assert stable heap growth.

M-07 — Medium — SSE and PTY output producers do not honor slow-consumer backpressure

Classification: CONFIRMED design gap
Affected areas: preview synchronization, external-edit events, agent terminal
Primary files:

packages/server/src/routes/events.ts

packages/server/src/routes/agent-terminal.ts

The SSE producer polls batches and calls controller.enqueue() without checking desiredSize or using a pull-driven producer. PTY live output similarly pushes into the response stream. A suspended tab or slow consumer can let the internal queue grow while producers continue.

Use a pull/capacity-aware pump, stop polling/subscriptions immediately on abort, and add slow-consumer RSS tests.

L-01 — Low — Invalid or unsatisfiable Range falls back to full 200

Classification: CONFIRMED protocol bug
Primary file: packages/server/src/routes/project-reads.ts

requestedRange() returns null for both “no Range header” and malformed/unsatisfiable input. assetResponse() interprets null as a full-file response.

Return 416 Range Not Satisfiable with:

Content-Range: bytes */<size>

Test empty suffix, zero suffix, start beyond EOF, reversed bounds, overflow and multi-range input.

6. Governance and evidence gaps

G-01 — Branch protection and required checks are disabled

Classification: GOVERNANCE GAP

The repository exposes substantial CI workflows, but both main and feat-editor report branch protection disabled and no enforced status checks. A green historical run is not equivalent to an enforced merge policy.

Required before release:

protect main;

require static checks and browser-session checks;

require packaged smoke for the release path;

require review for security-boundary changes;

prevent force-push/deletion as appropriate;

use a merge queue or exact-head requirement.

G-02 — No SCA/CodeQL/secret-scanning gate was found

Classification: COVERAGE GAP

No repository workflow or configuration was found for dependency vulnerability scanning, CodeQL/static security analysis, or secret scanning. This review does not claim a known dependency CVE; it states that the repository currently lacks evidence that would find one.

Add at minimum:

OSV or equivalent lockfile scan;

CodeQL for JavaScript/TypeScript;

secret scan;

dependency update policy;

license/provenance checks for release dependencies.

GitHub Actions should be pinned to immutable commit SHAs for release-sensitive workflows rather than only mutable major tags.

G-03 — Accessibility and long-running soak are not release-proven

Classification: COVERAGE GAP

The timeline contains useful ARIA labels and keyboard reorder support. However, no automated accessibility runner was found, and file CRUD still uses window.prompt/window.confirm, which limits focus management, announcement quality and deterministic UI testing.

No soak evidence was found for:

100k+ receipts;

repeatedly invalid catalog installs;

suspended SSE/PTY consumers;

10k-file/deep trees;

many concurrent 500 MB asset ranges/uploads.

These are required to claim the long-running local daemon is resource-safe.

7. Requirement re-evaluation

Requirement

Functional result

Deep-review result

R1 — Timeline timing drag

Implemented

Partial: frame-grid authority is incomplete

R2 — Scene reorder

Implemented

Pass: no new blocker found in the reviewed path

R3 — Undo/redo

Implemented

Partial: capture failure invariant and unbounded dedupe

R4 — Preview continuity

Performance evidence passes

Fail security: same-origin authored code

R5 — Upload/file manager

Broadly implemented

Fail/Partial: capture race, symlink alias, TOCTOU, unbounded tree, full-buffer range

R6 — Captions

Implemented with real-browser parity evidence

Pass: no new blocker found

R7 — Templates

Implemented

Partial: inherits preview execution authority and catalog package risks

R8 — Draft/conflict/shortcuts

Implemented

Partial: clean external deletion is hidden

R9 — Catalog install

Implemented

Partial: pin leak, binary reinstall bug, publisher trust remains a risk decision

R10 — Timeline thumbnails

Implemented

Pass with inherited asset-stream concern

R11 — Asset drop/mount

Implemented

Partial: inherits R5 filesystem and asset-serving issues

R12 — Multi-select/group move

Implemented

Partial: direct/UI group shift can be sub-frame

8. Edge-case regression matrix required for closure

Browser security

authored inline script;

authored external script;

imported project from an untrusted source;

installed catalog package with script;

preview tries project read/write;

preview tries system browse;

preview tries terminal start/input;

preview tries external beacon/WebSocket/form navigation;

stale preview capability after project/session close;

two projects cannot reuse each other’s capability.

Filesystem

root symlink and parent symlink;

internal and external symlink target;

parent swapped after resolve;

entry type swapped after validation;

file replaced by directory and reverse;

target appears during rollback;

case-only rename on Windows/macOS;

locked file on Windows;

very deep and very wide trees;

.vidcom and protected files absent from user tree;

no mutation outside project after any failed case.

Large data and streams

500 MB upload cancel at multiple points;

500 MB one-byte Range;

many concurrent ranges;

slow/suspended SSE;

slow/suspended PTY consumer;

client disconnect during response;

explicit listener request/header/idle timeout;

concurrent upload/stream limits.

Catalog

invalid digest after materialization;

parse/planner rejection releases pin;

binary create/reuse/replace/skip;

same version/different bytes;

external edit between prepare and execute;

cache full with pinned and unpinned packages;

repeated invalid installs do not grow disk/pins;

upstream trust/signature policy documented.

Draft/editor

clean and dirty external delete;

parent rename/delete;

rapid event A/B with out-of-order refetch;

save response older than latest event;

file recreated after delete;

frame alignment through UI, HTTP and MCP;

arbitrary/sub-frame playhead and legacy source timing.

9. Remediation gates

P0 — Merge blockers

Isolate authored preview code from the UI session and privileged API.

Add malicious-preview browser tests.

Make mutation capture locally exception-safe.

Reject or safely model symlinks for authored CRUD.

Close parent-component TOCTOU with an approved secure-path design.

Stream ranged asset reads with a measurable RSS bound.

P1 — Release blockers

Bound and hide the project file tree/internal state.

Fix catalog pin ownership on every error path.

Fix binary package reinstall/reuse/replace.

Surface clean external deletion.

Make frame alignment authoritative in Core.

Add 416 Range behavior.

Add backpressure and bounded receipt dedupe.

Add branch protection and required checks.

P2 — Release hardening

SCA/CodeQL/secret scan.

Immutable action pins.

Accessibility automation and first-class dialogs.

Long-running resource soak suite.

Explicit upstream catalog publisher trust/signature policy.

Document listener concurrency/timeouts and test them.

10. Required verification after remediation

Existing gates must remain green:

bun run typecheck
bun run lint
bun run test
bun run test:boundaries
bun run test:golden
bun run test:mcp-catalogue
bun run test:mcp-contract
bun run test:schema-drift
bun run test:spec-paths
bun run test:agent-kit
bun run test:browser-session
bun run build
bun run build:artifact

Additionally, closure requires:

exact-source CI on Linux, macOS and Windows;

real-browser malicious-preview suite on Linux and Windows;

real-filesystem race suite with deterministic barriers;

sparse 500 MB range/RSS suite;

catalog lifecycle/reinstall suite;

slow-consumer and 100k-receipt soak;

strict packaged smoke after the security architecture change;

zero skipped tests for required P0/P1 cases.

A fix is not closed by a unit test that mocks node:fs or by a synthetic DOM player. The defect class must be exercised at the boundary where it exists.

11. Council review

SM

The original implementation process and evidence trail are strong. However, “all checklist boxes are green” is not sufficient once a later audit discovers unmodeled security/data-integrity requirements. Historical evidence should remain intact; remediation should be tracked as a dedicated follow-up security/quality gate.

SM result: process evidence passes; closure claim must be reopened through a follow-up gate.

PO

Most visible editing workflows are present and likely usable. The unresolved issues are not cosmetic:

a project can execute with too much authority;

failed races can relocate user files;

clean external deletion can leave a misleading stale editor;

large media seek can exhaust memory.

These affect trust and data safety, so they are product-quality blockers.

PO result: feature breadth passes; release readiness fails.

Dev / Security

The architecture has strong Core/journal/contract foundations. The critical browser principal and filesystem race classes remain open, and resource bounds are asymmetric between upload and download.

Dev result: NO-GO.

12. Limitations of this audit

This was a static source audit through the repository interface plus review of existing CI/checklist evidence.

The existing exact-source CI was not independently rerun by this reviewer.

OS-specific races were not live-reproduced here; the race findings are derived from deterministic source ownership paths and require the real-filesystem tests listed above.

No external CVE database or malware scan was run, so no claim is made that dependencies are vulnerability-free.

No complete manual visual/accessibility session was performed.

These limitations lower confidence only for properties marked “not proven”. They do not remove the confirmed code-path defects.

13. Final verdict

The branch demonstrates a serious implementation effort and strong verification culture, but it is not yet safe to merge/release as fully closed.

The minimum acceptable next state is:

C-01 and H-01–H-04 fixed;

their boundary-level regression tests required by CI;

P1 items assigned with explicit release gating;

branch protection enforcing the resulting evidence.

Until then:

Editing feature coverage: strong
Checklist execution quality: strong
Edge-case closure: incomplete
Security/data-integrity readiness: failed
Merge/release decision: NO-GO

14. Remediation closure — 2026-08-21

The audit-time NO-GO is superseded for the editing-experience scope. The implementation checklist's
“P18 deep-review closure matrix” maps all 16 findings — C-01, H-01–H-04, M-01–M-07, L-01 and G-01–G-03 —
to production code, boundary tests, exact-source Actions evidence and a final `CLOSED` disposition.

The production source authority is commit `03a2df5659552ad9638d05888f08b3a0fba38f2f`:

- `CI` 32446589563: success for static Linux/macOS/Windows, Browser Linux/Windows, Packaged
  Linux/macOS/Windows and security; downloaded packaged evidence is strict 14/14 at the clean exact SHA.
- `Browser session` 32448369053: success on Linux/Windows; every R4.1c sample is below 500 ms.
- `Packaged smoke` 32448700000: success on all three platform tags; artifacts downloaded and verified.
- `Process supervision gate` 32450453353: success on all jobs; real-render log says
  `TERMINATED_CLEAN` with no survivors.
- `VieNeu real engine` 32450780804: success with engine 3.2.4 and resolved model revision
  `2da0efab622a1722125991736524f080b751ef5b`; downloaded Vietnamese WAV is PCM 44.1 kHz mono,
  3.621769 seconds, SHA-256 `c98000c07f42bfd37b36c1be9ca2a5648f7f3d73cd7d90044327a2f598c14a39`.

GitHub `main` branch protection is active with strict exact-head static three-OS, browser two-OS and
packaged three-OS GitHub Actions contexts; one approval, stale/last-push review protection,
conversation resolution and admin enforcement are required; force-push and deletion are disabled.
PR #4 is consequently blocked pending an independent human approval, which is the intended governance
state rather than an unresolved product or CI defect.

Final council: SM `PASS`; PO `PASS`; Dev/Security `PASS`. The Editing Experience remediation is safe
to close, while the human review required by branch protection remains a separate merge authorization.
