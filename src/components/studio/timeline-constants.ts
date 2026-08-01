/**
 * Width of the timeline's left gutter (scene number, name and visibility), in
 * pixels. The ruler and every lane reserve exactly this much so the bars line up
 * with the ruler ticks, and it stays pinned while the lanes scroll sideways.
 *
 * A number rather than a Tailwind class: the lane layout needs it arithmetically
 * to place the playhead, and deriving that from a class string meant any edit to
 * an arbitrary-value class ("w-[11rem]") silently produced NaN offsets.
 */
export const TIMELINE_GUTTER_PX = 176;

/** Inline style for a gutter cell — keeps every row on the same grid. */
export const TIMELINE_GUTTER_STYLE = { width: TIMELINE_GUTTER_PX } as const;

/** Zoom multipliers applied on top of the width that exactly fits `duration`. */
export const ZOOM_LEVELS = [1, 2, 4, 8] as const;
