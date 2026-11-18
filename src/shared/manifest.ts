// cutline.json, schema v1: the whole edit state of one project.
// The server is the only writer; the UI reads it and sends patches.
import { z } from "zod";

export const SCHEMA_ID = "cutline.project/1";
export const MANIFEST_FILE = "cutline.json";

const isoDate = z.iso.datetime();
const id = z.string().min(1);

export const SettingsSchema = z.strictObject({
  // null means "use the app-wide default".
  voiceId: z.string().nullable(),
  llm: z.string().nullable(),
  photo: z.string().nullable(),
});

export const TrackSchema = z.strictObject({
  file: z.string().min(1),
  codec: z.string().optional(),
  mime: z.string().optional(),
  offset: z.number().optional(),
});

export const SourceSchema = z.strictObject({
  id,
  kind: z.enum(["recording", "import"]),
  dir: z.string().min(1),
  label: z.string(),
  notes: z.string(),
  tags: z.array(z.string()),
  status: z.enum(["recording", "finalising", "ready", "recovered", "missing"]),
  duration: z.number().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  tracks: z.strictObject({
    screen: TrackSchema.nullable(),
    voice: TrackSchema.nullable(),
    cam: TrackSchema.nullable(),
  }),
  derived: z.record(z.string(), z.enum(["queued", "running", "ready", "failed"])),
  createdAt: isoDate,
});

export const ClipSchema = z
  .strictObject({
    id,
    source: id,
    in: z.number().nonnegative(),
    out: z.number().nonnegative(),
    label: z.string(),
    tags: z.array(z.string()),
    origin: z.enum(["manual", "ai"]),
    ai: z
      .strictObject({ intent: z.string(), said: z.string(), accepted: z.boolean() })
      .optional(),
  })
  .refine((clip) => clip.out > clip.in, { message: "clip out must be after in" });

const size = z.enum(["s", "m", "l"]);

export const TimelineItemSchema = z.strictObject({
  id,
  clip: id,
  voice: z.enum(["elevenlabs", "original", "none"]),
  script: z.strictObject({ text: z.string(), origin: z.enum(["manual", "ai"]), edited: z.boolean() }),
  narration: z
    .strictObject({
      key: z.string(),
      textHash: z.string(),
      stale: z.boolean(),
      duration: z.number().nonnegative(),
    })
    .nullable(),
  fit: z.enum(["auto", "stretch", "natural"]),
  bubble: z.strictObject({ on: z.boolean(), corner: z.enum(["tl", "tr", "bl", "br"]), size }),
  transition: z.string(),
});

export const TimelineSchema = z.strictObject({
  id,
  name: z.string(),
  items: z.array(TimelineItemSchema),
  look: z.strictObject({
    subs: z.strictObject({
      on: z.boolean(),
      style: z.enum(["box", "outline", "highlight"]),
      pos: z.enum(["top", "bottom"]),
      size,
    }),
    bubble: z.strictObject({ on: z.boolean(), size, pulse: z.boolean() }),
    transition: z.string(),
  }),
  copy: z.strictObject({
    titles: z.array(z.string()),
    title: z.number().int().nonnegative(),
    description: z.string(),
    thumb: z.number().int().nonnegative(),
  }),
});

export const ExportSchema = z.strictObject({
  id,
  timeline: id,
  dir: z.string().min(1),
  at: isoDate,
  size: z.string(),
  status: z.enum(["rendering", "done", "failed"]),
});

// What "resume exactly where I left off" restores.
export const UiStateSchema = z.strictObject({
  mode: z.enum(["overview", "capture", "edit"]),
  view: z.string().nullable(),
  selection: z.string().nullable(),
  source: z.string().nullable(),
  playhead: z.number().nonnegative(),
  zoom: z.number().positive(),
  panel: z.string().nullable(),
});

export const ManifestSchema = z.strictObject({
  schema: z.literal(SCHEMA_ID),
  id: z.string().regex(/^prj_[0-9A-Z]{26}$/),
  name: z.string().trim().min(1).max(200),
  rev: z.number().int().positive(),
  created: isoDate,
  updated: isoDate,
  product: z.string(),
  settings: SettingsSchema,
  sources: z.array(SourceSchema),
  clips: z.array(ClipSchema),
  timelines: z.array(TimelineSchema),
  exports: z.array(ExportSchema),
  ui: UiStateSchema,
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineItem = z.infer<typeof TimelineItemSchema>;
export type ExportRecord = z.infer<typeof ExportSchema>;
export type UiState = z.infer<typeof UiStateSchema>;

/** Fields only the server sets; patches may not touch them. */
export const SERVER_OWNED_FIELDS = ["schema", "id", "rev", "created", "updated"] as const;

export function newManifest(init: { id: string; name: string; now?: Date }): Manifest {
  const at = (init.now ?? new Date()).toISOString();
  return {
    schema: SCHEMA_ID,
    id: init.id,
    name: init.name,
    rev: 1,
    created: at,
    updated: at,
    product: "",
    settings: { voiceId: null, llm: null, photo: null },
    sources: [],
    clips: [],
    timelines: [
      {
        id: "tl_main",
        name: "Main cut",
        items: [],
        look: {
          subs: { on: true, style: "box", pos: "bottom", size: "m" },
          bubble: { on: true, size: "m", pulse: true },
          transition: "cut",
        },
        copy: { titles: [], title: 0, description: "", thumb: 0 },
      },
    ],
    exports: [],
    ui: {
      mode: "overview",
      view: null,
      selection: null,
      source: null,
      playhead: 0,
      zoom: 1,
      panel: null,
    },
  };
}

/** Reads the schema version out of an unknown cutline.json value, or null when there is none. */
export function schemaVersion(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const schema = (raw as { schema?: unknown }).schema;
  if (typeof schema !== "string") return null;
  const match = /^cutline\.project\/(\d+)$/.exec(schema);
  return match ? Number(match[1]) : null;
}
