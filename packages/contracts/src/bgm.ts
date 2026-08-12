import { z } from "zod";

import { ContentHashSchema, IdentifierSchema, RelativePathSchema } from "./dto";

/**
 * Background beds VidCom can produce with nothing installed and nothing fetched.
 *
 * A project that has no music yet is the common case, and every other route to a
 * bed has a cost the user did not sign up for: a music service needs an account,
 * a local generator needs a multi-gigabyte model, and a track from the web needs
 * a licence somebody has to read. These five are **synthesized from the recipe
 * below**, so they ship as a few hundred bytes of numbers, carry no licence at
 * all, and render at whatever length the video happens to be.
 *
 * The recipes are the ones the studio's own preview player has been using, so a
 * bed sounds the same whether it is previewed in the browser or rendered here.
 */
export type BgmBedId = "ambient" | "cinematic" | "lofi" | "piano" | "dark";

export const BGM_BED_IDS: readonly BgmBedId[] = ["ambient", "cinematic", "lofi", "piano", "dark"];

/**
 * One bed's harmony, in Hz.
 *
 * Frequencies rather than note names: the synth reads them directly, and a note
 * name would need a tuning convention to mean anything. Four chords of four
 * voices, cycled; `arps` are the sparse top line played over each chord.
 */
export interface BgmBedRecipe {
  /** Four chords, four voices each; the bed cycles them for its whole length. */
  chords: readonly [
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
  ];
  /** Four arpeggio sets, one per chord; the synth walks them one note per period. */
  arps: readonly [
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
    readonly [number, number, number, number],
  ];
}

/**
 * How a track is chosen, not how it sounds.
 *
 * An agent picking music cannot listen, and a one-line role only separates five
 * options. Tempo, vocals, style and the video types a track suits are what turn
 * "pick something" into a decision somebody can check — modelled on the
 * production catalogue this shipped set came from.
 */
export interface BgmSelectionMetadata {
  tempo: "slow" | "medium" | "medium-fast" | "fast";
  hasVocals: boolean;
  /** Instruments and treatment, in a few words. */
  style: string;
  /** What the piece is for: "explainer", "product promo", "vlog"… */
  recommendedFor: readonly string[];
  /** Feeling words; the axis a brief is usually written along. */
  mood: readonly string[];
}

export interface BgmBed {
  id: BgmBedId;
  /** Shown in a picker. */
  label: string;
  /** One line telling an author when this bed is the right choice. */
  role: string;
  selection: BgmSelectionMetadata;
  recipe: BgmBedRecipe;
}

/** Seconds each chord is held before the next one enters. */
export const BGM_CHORD_PERIOD_SECONDS = 8;
/** Seconds between arpeggio notes. */
export const BGM_ARP_PERIOD_SECONDS = 2;
/** Longest bed the synth will render in one call; past this a video wants real music. */
export const BGM_MAX_BED_SECONDS = 600;
/** Shortest bed worth rendering — below this the 4s fade-in never completes. */
export const BGM_MIN_BED_SECONDS = 5;

/**
 * Level a bed sits at under narration.
 *
 * 0.12 linear ≈ −18 dB. Music under a voice is a bed, not a duet; a project with
 * no narration can raise it, which is why this is a default rather than a cap.
 */
export const BGM_BED_DEFAULT_VOLUME = 0.12;

export const BGM_BEDS: readonly BgmBed[] = [
  {
    id: "ambient",
    label: "Ambient",
    role: "Neutral pad for an explainer or a product tour; the safe default.",
    selection: {
      tempo: "slow",
      hasVocals: false,
      style: "Warm synth pad, sparse bell arpeggio",
      recommendedFor: ["explainer", "product tour", "tutorial", "documentation video"],
      mood: ["calm", "neutral", "focused", "professional"],
    },
    recipe: {
      chords: [
        [130.81, 164.81, 196, 246.94],
        [110, 130.81, 164.81, 196],
        [87.31, 130.81, 164.81, 207.65],
        [98, 123.47, 146.83, 174.61],
      ],
      arps: [
        [523.25, 659.25, 783.99, 987.77],
        [440, 523.25, 659.25, 783.99],
        [349.23, 523.25, 659.25, 830.61],
        [392, 493.88, 587.33, 698.46],
      ],
    },
  },
  {
    id: "cinematic",
    label: "Cinematic",
    role: "Wider, more deliberate; for a launch or a reveal that wants weight.",
    selection: {
      tempo: "slow",
      hasVocals: false,
      style: "Wide minor pad, deliberate movement",
      recommendedFor: ["product launch", "brand film", "feature reveal", "event recap"],
      mood: ["weighty", "confident", "dramatic", "spacious"],
    },
    recipe: {
      chords: [
        [146.83, 174.61, 220, 277.18],
        [116.54, 146.83, 174.61, 220],
        [98, 116.54, 146.83, 174.61],
        [110, 138.59, 164.81, 220],
      ],
      arps: [
        [293.66, 349.23, 440, 554.37],
        [233.08, 293.66, 349.23, 440],
        [196, 233.08, 293.66, 349.23],
        [220, 277.18, 329.63, 440],
      ],
    },
  },
  {
    id: "lofi",
    label: "Lo-fi",
    role: "Warmer and slightly out of tune; for a casual or personal piece.",
    selection: {
      tempo: "medium",
      hasVocals: false,
      style: "Detuned electric-piano pad, soft beat feel",
      recommendedFor: ["vlog", "study-with-me", "podcast background", "behind the scenes"],
      mood: ["relaxed", "warm", "casual", "friendly"],
    },
    recipe: {
      chords: [
        [130.81, 155.56, 196, 233.08],
        [110, 138.59, 164.81, 207.65],
        [87.31, 110, 130.81, 164.81],
        [98, 123.47, 155.56, 185],
      ],
      arps: [
        [523.25, 622.25, 783.99, 932.33],
        [440, 554.37, 659.25, 783.99],
        [349.23, 440, 523.25, 659.25],
        [392, 493.88, 622.25, 739.99],
      ],
    },
  },
  {
    id: "piano",
    label: "Piano",
    role: "Brighter, sparser voicing; for a calm walkthrough or a personal story.",
    selection: {
      tempo: "slow",
      hasVocals: false,
      style: "Bright sparse keys, open voicing",
      recommendedFor: ["personal story", "walkthrough", "announcement", "testimonial"],
      mood: ["gentle", "sincere", "clear", "unhurried"],
    },
    recipe: {
      chords: [
        [130.81, 164.81, 196, 261.63],
        [146.83, 174.61, 220, 293.66],
        [87.31, 110, 130.81, 174.61],
        [98, 123.47, 146.83, 196],
      ],
      arps: [
        [261.63, 329.63, 392, 523.25],
        [293.66, 349.23, 440, 587.33],
        [174.61, 220, 261.63, 349.23],
        [196, 246.94, 293.66, 392],
      ],
    },
  },
  {
    id: "dark",
    label: "Dark",
    role: "An octave down and heavier; for a problem beat, an outage, a warning.",
    selection: {
      tempo: "slow",
      hasVocals: false,
      style: "Sub-octave pad, heavy low end",
      recommendedFor: ["problem framing", "incident postmortem", "security topic", "warning"],
      mood: ["tense", "serious", "heavy", "cautionary"],
    },
    recipe: {
      chords: [
        [65.41, 82.41, 98, 123.47],
        [73.42, 87.31, 110, 130.81],
        [55, 69.3, 82.41, 103.83],
        [61.74, 77.78, 92.5, 116.54],
      ],
      arps: [
        [261.63, 311.13, 392, 466.16],
        [293.66, 349.23, 440, 523.25],
        [220, 277.18, 329.63, 415.3],
        [246.94, 311.13, 369.99, 466.16],
      ],
    },
  },
];

/**
 * Real tracks shipped with VidCom, so a user with no music at all still has
 * something a viewer would call music.
 *
 * The synthesized beds cover "there must be something under this"; these four
 * cover "this should sound produced". They are files, so they have a length and a
 * licence — both recorded here rather than discovered at play time.
 *
 * The metadata is the point of the catalogue. Whoever picks a track cannot listen
 * to it: an agent reads `selection`, and so does a person scanning a list.
 */
export type BgmShippedTrackId =
  | "corporate-synth"
  | "corporate-marimba"
  | "lofi-chill"
  | "promo-dance";

export interface BgmShippedTrack {
  id: BgmShippedTrackId;
  label: string;
  /** File under the shipped BGM asset directory. */
  filename: string;
  role: string;
  selection: BgmSelectionMetadata;
  durationSeconds: number;
  license: BgmLicense;
}

/**
 * Licence state of the shipped set.
 *
 * `unknown` is deliberate and load-bearing: these files were adopted from an
 * in-house production catalogue that did not record where they came from, and a
 * fabricated "royalty-free" would be worse than an honest gap. Anything published
 * with one of these should have its licence confirmed first, which is exactly what
 * a caller can see because it is in the data.
 */
const SHIPPED_LICENSE: BgmLicense = {
  kind: "unknown",
  holder: null,
  url: null,
  note: "Shipped with VidCom from an in-house catalogue; no licence was recorded. Confirm before publishing.",
};

export const SHIPPED_BGM_TRACKS: readonly BgmShippedTrack[] = [
  {
    id: "corporate-synth",
    label: "Corporate synth",
    filename: "alex-morgan-corporate-business-background.mp3",
    role: "Modern and driving; for a company or product intro that should feel current.",
    selection: {
      tempo: "medium-fast",
      hasVocals: false,
      style: "Electronic synth, upbeat rhythm",
      recommendedFor: ["company intro", "app or startup promo", "software tutorial", "work vlog"],
      mood: ["modern", "energetic", "positive", "professional"],
    },
    durationSeconds: 67.584,
    license: SHIPPED_LICENSE,
  },
  {
    id: "corporate-marimba",
    label: "Corporate marimba",
    filename: "corporate-marimba-business-background.mp3",
    role: "Light and tidy; for a report, an infographic, or a tips video.",
    selection: {
      tempo: "medium",
      hasVocals: false,
      style: "Acoustic guitar, marimba, light percussion",
      recommendedFor: ["business report", "infographic", "how-to tips", "tech news"],
      mood: ["cheerful", "friendly", "tidy", "collaborative"],
    },
    durationSeconds: 52.584,
    license: SHIPPED_LICENSE,
  },
  {
    id: "lofi-chill",
    label: "Lo-fi chill",
    filename: "meta.mp3",
    role: "Slow and warm; for a vlog, a podcast bed, or anything unhurried.",
    selection: {
      tempo: "slow",
      hasVocals: false,
      style: "Electric piano, lo-fi beat, chillout",
      recommendedFor: ["daily vlog", "study-with-me", "podcast background", "review"],
      mood: ["relaxed", "chill", "warm", "soft"],
    },
    durationSeconds: 59.999,
    license: SHIPPED_LICENSE,
  },
  {
    id: "promo-dance",
    label: "Promo dance",
    filename: "promo-promo-business-background.mp3",
    role: "Fast and bright; for a promo, an event recap, or a short-form launch.",
    selection: {
      tempo: "fast",
      hasVocals: false,
      style: "Light EDM, driving bassline, motivational beat",
      recommendedFor: ["promo", "event recap", "shorts or reels launch", "product line reveal"],
      mood: ["excited", "engaging", "youthful", "fast"],
    },
    durationSeconds: 150.544,
    license: SHIPPED_LICENSE,
  },
];

export function findShippedBgmTrack(id: string): BgmShippedTrack | undefined {
  return SHIPPED_BGM_TRACKS.find((track) => track.id === id);
}

export function findBgmBed(id: string): BgmBed | undefined {
  return BGM_BEDS.find((bed) => bed.id === id);
}

/** Audio extensions the BGM player can decode; a PNG named as a track is silence. */
export const BGM_AUDIO_EXTENSIONS: readonly string[] = ["mp3", "wav", "ogg", "m4a"];

/**
 * How a library entry got there.
 *
 * `synth` entries are reproducible from a recipe id; `import` entries are bytes
 * somebody supplied, and only those can carry a licence obligation.
 */
export const BgmLibrarySourceSchema = z.enum(["synth", "import"]);

/**
 * Licence recorded for an imported track.
 *
 * Recorded, never inferred: VidCom cannot read a licence off an audio file, so
 * the importer states it and the ledger keeps what was stated. `unknown` is a
 * legal value — an honest "nobody said" beats a fabricated "royalty-free", and
 * it is what a diagnostic can warn about before a publish.
 */
export const BgmLicenseSchema = z.strictObject({
  kind: z.enum(["unknown", "public-domain", "cc0", "cc-by", "royalty-free", "licensed", "own-work"]),
  /** Who to credit, when the licence requires it. */
  holder: z.string().max(255).nullable(),
  /** Where the licence or the download came from. */
  url: z.string().max(2_048).nullable(),
  /** Anything else the importer needs the next person to know. */
  note: z.string().max(1_024).nullable(),
});

/** One track in the machine-level library, usable by every project on this install. */
export const BgmLibraryEntrySchema = z.strictObject({
  id: IdentifierSchema,
  name: z.string().min(1).max(255),
  source: BgmLibrarySourceSchema,
  /** Recipe this entry was rendered from; null for an import. */
  bedId: z.enum(["ambient", "cinematic", "lofi", "piano", "dark"]).nullable(),
  durationSeconds: z.number().positive(),
  byteSize: z.number().int().nonnegative(),
  contentHash: ContentHashSchema,
  license: BgmLicenseSchema,
  addedAt: z.string().min(1),
});

/** Selection metadata as it crosses the wire; the shape a picker reads. */
export const BgmSelectionSchema = z.strictObject({
  tempo: z.enum(["slow", "medium", "medium-fast", "fast"]),
  hasVocals: z.boolean(),
  style: z.string(),
  recommendedFor: z.array(z.string()),
  mood: z.array(z.string()),
});

/** Input for `list_bgm_beds`. */
export const ListBgmBedsInputSchema = z.strictObject({});
/** Output for `list_bgm_beds`: the recipes, the shipped tracks, and this install's library. */
export const ListBgmBedsOutputSchema = z.strictObject({
  beds: z.array(z.strictObject({
    id: z.enum(["ambient", "cinematic", "lofi", "piano", "dark"]),
    label: z.string(),
    role: z.string(),
    selection: BgmSelectionSchema,
  })),
  tracks: z.array(z.strictObject({
    id: z.enum(["corporate-synth", "corporate-marimba", "lofi-chill", "promo-dance"]),
    label: z.string(),
    role: z.string(),
    selection: BgmSelectionSchema,
    durationSeconds: z.number().positive(),
    license: BgmLicenseSchema,
    /**
     * Whether the file is actually on this install.
     *
     * Reported rather than assumed: the audio ships as a runtime asset, and a
     * build that omitted it must read as "not here" instead of failing at the
     * moment somebody installs it.
     */
    available: z.boolean(),
  })),
  library: z.array(BgmLibraryEntrySchema),
  defaultVolume: z.number().min(0).max(1),
});

/** Input for `install_bgm`. */
export const InstallBgmInputSchema = z.strictObject({
  projectId: IdentifierSchema,
  /** A synthesized recipe id from `list_bgm_beds`. */
  bedId: z.enum(["ambient", "cinematic", "lofi", "piano", "dark"]).optional(),
  /** A shipped track id from `list_bgm_beds`. */
  trackId: z.enum(["corporate-synth", "corporate-marimba", "lofi-chill", "promo-dance"]).optional(),
  /** A library entry id from `list_bgm_beds`. */
  libraryEntryId: IdentifierSchema.optional(),
  /**
   * Bed length in seconds. Omitted means the project's own duration, which is
   * what a bed should be — a track that stops before the last scene is worse
   * than no track.
   */
  seconds: z.number().min(BGM_MIN_BED_SECONDS).max(BGM_MAX_BED_SECONDS).optional(),
  volume: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  /** Preview-settings revision, from get_project_context. */
  expectedRevision: z.number().int().nonnegative(),
}).refine(
  (input) => [input.bedId, input.trackId, input.libraryEntryId]
    .filter((value) => value !== undefined).length === 1,
  { message: "pass exactly one of bedId, trackId or libraryEntryId", path: ["bedId"] },
);

/** Output for `install_bgm`. */
export const InstallBgmOutputSchema = z.strictObject({
  track: z.strictObject({
    name: z.string().min(1),
    path: RelativePathSchema,
    durationSeconds: z.number().positive(),
    contentHash: ContentHashSchema,
  }),
  volume: z.number().min(0).max(1),
  loop: z.boolean(),
  revision: z.number().int().nonnegative(),
});

/** Input for `import_bgm`; the source is an asset already inside the project. */
export const ImportBgmInputSchema = z.strictObject({
  projectId: IdentifierSchema,
  /** Project-relative audio file, as listed by `list_project_assets`. */
  path: RelativePathSchema,
  name: z.string().min(1).max(255).optional(),
  license: BgmLicenseSchema,
});
/** Output for `import_bgm`. */
export const ImportBgmOutputSchema = z.strictObject({
  entry: BgmLibraryEntrySchema,
  /** True when a byte-identical track was already in the library. */
  alreadyPresent: z.boolean(),
});

/** Input for `record_bgm_license`. */
export const RecordBgmLicenseInputSchema = z.strictObject({
  trackId: z.enum(["corporate-synth", "corporate-marimba", "lofi-chill", "promo-dance"]),
  license: BgmLicenseSchema,
});
/** Output for `record_bgm_license`. */
export const RecordBgmLicenseOutputSchema = z.strictObject({
  trackId: z.enum(["corporate-synth", "corporate-marimba", "lofi-chill", "promo-dance"]),
  license: BgmLicenseSchema,
});

export type BgmLicense = z.infer<typeof BgmLicenseSchema>;
export type BgmLibraryEntry = z.infer<typeof BgmLibraryEntrySchema>;
export type BgmLibrarySource = z.infer<typeof BgmLibrarySourceSchema>;
