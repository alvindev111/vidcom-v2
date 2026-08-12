import type { z } from "zod";

import {
  ImportBgmInputSchema,
  ImportBgmOutputSchema,
  InstallBgmInputSchema,
  InstallBgmOutputSchema,
  ListBgmBedsInputSchema,
  ListBgmBedsOutputSchema,
  RecordBgmLicenseInputSchema,
  RecordBgmLicenseOutputSchema,
  SearchBgmInputSchema,
  SearchBgmOutputSchema,
  type ProjectId,
} from "@vidcom/contracts";
import {
  importBgm,
  installBgm,
  listBgmSources,
  ok,
  recordShippedBgmLicense,
  searchBgmSources,
  type BgmDependencies,
} from "@vidcom/core";

import { annotationsForLevel, ToolRegistry } from "./registry";
import type { ToolDefinition } from "./types";

export type BgmToolDependencies = BgmDependencies;

/**
 * Lists the music a project can have without anyone fetching anything.
 *
 * Two lists in one call because a caller choosing music needs both: the built-in
 * recipes always exist, and the library is whatever this machine has imported —
 * asking for them separately would mean an agent that only knows about one.
 */
export function listBgmBedsTool(
  dependencies: BgmToolDependencies,
): ToolDefinition<z.infer<typeof ListBgmBedsInputSchema>, z.infer<typeof ListBgmBedsOutputSchema>> {
  return {
    name: "list_bgm_beds",
    title: "List background music options",
    level: "read",
    description: [
      "Use when choosing background music, before install_bgm, to see the built-in beds and the tracks this machine has imported.",
      "Do not use to read a project's current music; get_project_context returns previewSettings.bgm.",
      "Preconditions: none; the built-in beds are always available offline and need no credential.",
      "Side effects: read-only; nothing is synthesized or written until install_bgm.",
      "Errors/recovery: an empty library is normal on a fresh install — pick a bed id instead; each library entry carries the licence it was imported under, and license.kind=unknown means nobody recorded one.",
    ].join(" "),
    input: ListBgmBedsInputSchema,
    output: ListBgmBedsOutputSchema,
    annotations: annotationsForLevel("read"),
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async () => ok(ListBgmBedsOutputSchema.parse(await listBgmSources(dependencies))),
  };
}

/** Searches keyless remote catalogues and reports each provider's health independently. */
export function searchBgmTool(
  dependencies: BgmToolDependencies,
): ToolDefinition<z.infer<typeof SearchBgmInputSchema>, z.infer<typeof SearchBgmOutputSchema>> {
  return {
    name: "search_bgm",
    title: "Search open background music",
    level: "read",
    description: [
      "Use when the built-in beds are not expressive enough and you need openly licensed music matched to a mood before install_bgm.",
      "Do not use after choosing a track, to fetch arbitrary URLs, or to assume a search result is publication clearance; verify its source link and attribution.",
      "Preconditions: describe the intended mood in plain language; results are restricted to CC0, public-domain, or CC BY sources and vocal-tagged tracks are excluded.",
      "Side effects: calls Openverse and ccMixter but writes nothing; provider failures are isolated and offlineFallbackAvailable remains true.",
      "Errors/recovery: unavailable or empty providers are reported in the output; fall back to list_bgm_beds when every remote source is unavailable.",
    ].join(" "),
    input: SearchBgmInputSchema,
    output: SearchBgmOutputSchema,
    annotations: { ...annotationsForLevel("read"), openWorldHint: true },
    availableInLegacy: true,
    projectIdOf: () => null,
    handler: async (_context, input) => ok(SearchBgmOutputSchema.parse(await searchBgmSources(dependencies, input))),
  };
}

/**
 * Puts music in the project and points preview settings at it.
 *
 * A built-in bed is rendered at the project's own length, so the track ends when
 * the video does instead of being looped or cut at playback.
 */
export function installBgmTool(
  dependencies: BgmToolDependencies,
): ToolDefinition<z.infer<typeof InstallBgmInputSchema>, z.infer<typeof InstallBgmOutputSchema>> {
  return {
    name: "install_bgm",
    title: "Install background music",
    level: "write",
    description: [
      "Use when adding background music, which is the default for every video after its composition has a duration unless the user explicitly requests no music or silence is editorially required: renders a built-in bed, copies a shipped or imported track, or downloads the exact provider result and freezes it locally before attaching it.",
      "Do not use to change only volume or to detach music — that is set_preview_settings — and do not use to add narration or a sound effect.",
      "Preconditions: projectId and expectedRevision come from get_project_context; pass exactly one offline source from list_bgm_beds or providerTrack from search_bgm; verify the provider result's source and attribution before publishing; omit seconds to match the project duration.",
      "Side effects: provider music is first frozen in the machine library with its licence and provenance; then preview-assets/bgm/<name> is written and one revision sets bgm.enabled, track, volume and loop. Re-installing the same name is rejected rather than silently replaced.",
      "Errors/recovery: no_composition means the project has no duration yet, so pass seconds; write_conflict means expectedRevision is stale, so re-read get_project_context; storage_unavailable means this daemon cannot stage assets.",
    ].join(" "),
    input: InstallBgmInputSchema,
    output: InstallBgmOutputSchema,
    annotations: { ...annotationsForLevel("write"), openWorldHint: true },
    availableInLegacy: true,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (context, input) => {
      const installed = await installBgm(dependencies, {
        projectId: input.projectId as ProjectId,
        ...(input.bedId === undefined ? {} : { bedId: input.bedId }),
        ...(input.trackId === undefined ? {} : { trackId: input.trackId }),
        ...(input.libraryEntryId === undefined ? {} : { libraryEntryId: input.libraryEntryId }),
        ...(input.providerTrack === undefined ? {} : { providerTrack: input.providerTrack }),
        ...(input.seconds === undefined ? {} : { seconds: input.seconds }),
        ...(input.volume === undefined ? {} : { volume: input.volume }),
        ...(input.loop === undefined ? {} : { loop: input.loop }),
        expectedRevision: input.expectedRevision,
      }, context.actor, context.writeInvocation);
      return installed.ok ? ok(InstallBgmOutputSchema.parse(installed.value)) : installed;
    },
  };
}

/**
 * Takes a track already in the project into the machine-level library.
 *
 * The licence is stated by the caller because nothing can read it off the audio,
 * and it is recorded so the next project knows what the track may be used for.
 */
export function importBgmTool(
  dependencies: BgmToolDependencies,
): ToolDefinition<z.infer<typeof ImportBgmInputSchema>, z.infer<typeof ImportBgmOutputSchema>> {
  return {
    name: "import_bgm",
    title: "Import a track into the BGM library",
    level: "write",
    description: [
      "Use when a track already inside the project should become reusable by every project on this machine, with the licence it is allowed under recorded alongside it.",
      "Do not use to attach music to a project — that is install_bgm — and do not use for a file outside the project.",
      "Preconditions: projectId comes from list_projects and path is a project-relative mp3, wav, ogg or m4a as listed by list_project_assets; license.kind must be stated, and unknown is the honest value when nobody knows.",
      "Side effects: copies the bytes into the machine's BGM library and appends one ledger entry; the library is content-addressed, so importing the same bytes twice returns alreadyPresent=true and adds nothing.",
      "Errors/recovery: no_file means the path is not in the project; unsupported_media means the extension or the duration could not be read, so re-encode it; asset_not_allowed means the path is outside the project's asset allowlist.",
    ].join(" "),
    input: ImportBgmInputSchema,
    output: ImportBgmOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    // The bytes land in the machine's library, not in the project, so there is no
    // project journal to own this invocation's audit; the registry records it the
    // way it records a read.
    journalOwned: false,
    projectIdOf: (input) => input.projectId as ProjectId,
    handler: async (_context, input) => {
      const imported = await importBgm(dependencies, {
        projectId: input.projectId as ProjectId,
        path: input.path,
        ...(input.name === undefined ? {} : { name: input.name }),
        license: input.license,
      });
      return imported.ok ? ok(ImportBgmOutputSchema.parse(imported.value)) : imported;
    },
  };
}

/**
 * Writes down what a shipped track may be used for.
 *
 * The catalogue ships `unknown` for all four because nothing in the audio or the
 * history records a licence, and guessing one would be worse than the gap. This is
 * how the gap closes: whoever establishes the answer records it, once, for every
 * project on this machine.
 */
export function recordBgmLicenseTool(
  dependencies: BgmToolDependencies,
): ToolDefinition<z.infer<typeof RecordBgmLicenseInputSchema>, z.infer<typeof RecordBgmLicenseOutputSchema>> {
  return {
    name: "record_bgm_license",
    title: "Record a shipped track's licence",
    level: "write",
    description: [
      "Use when the licence of a shipped BGM track has been established and should be recorded, replacing the catalogue's unknown.",
      "Do not use to guess a licence, and do not use for a library entry — an import records its own licence.",
      "Preconditions: trackId comes from list_bgm_beds; license.kind must be the licence that was actually established, and holder plus url are required by attribution licences such as cc-by.",
      "Side effects: writes one entry into this machine's BGM ledger; every project on this install then reports that licence instead of unknown.",
      "Errors/recovery: not_found means the trackId is not a shipped track; recording again replaces the previous answer rather than failing.",
    ].join(" "),
    input: RecordBgmLicenseInputSchema,
    output: RecordBgmLicenseOutputSchema,
    annotations: annotationsForLevel("write"),
    availableInLegacy: true,
    // The ledger is machine-level, so no project journal owns this invocation.
    journalOwned: false,
    projectIdOf: () => null,
    handler: async (_context, input) => {
      const recorded = await recordShippedBgmLicense(dependencies, input);
      return recorded.ok ? ok(RecordBgmLicenseOutputSchema.parse(recorded.value)) : recorded;
    },
  };
}

export function registerBgmTools(registry: ToolRegistry, dependencies: BgmToolDependencies): void {
  registry.register(listBgmBedsTool(dependencies));
  registry.register(searchBgmTool(dependencies));
  registry.register(installBgmTool(dependencies));
  registry.register(importBgmTool(dependencies));
  registry.register(recordBgmLicenseTool(dependencies));
}
