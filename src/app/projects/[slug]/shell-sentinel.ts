/**
 * The single slug a static export renders for this route.
 *
 * Lives in its own module with no `"use client"` directive because the server
 * component needs its *value*. Importing it from the client module hands back a
 * client reference — a function — and `generateStaticParams` then rejects the
 * param as "received function" rather than a string.
 */
export const SHELL_SENTINEL = "__shell";
