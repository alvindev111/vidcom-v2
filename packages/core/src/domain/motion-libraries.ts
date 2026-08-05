/**
 * The motion library catalogue lives in `@vidcom/contracts` because the studio
 * UI needs it too and the frontend may not import Core. Core re-exports it so
 * use cases and adapters keep one import site.
 */
export {
  findMotionLibrary,
  MOTION_LIBRARIES,
  MOTION_LIBRARY_IDS,
  motionLibraryImportSpecifier,
  motionLibraryScriptTag,
  scanRemoteMotionLibraries,
  type MotionLibrary,
  type MotionLibraryFile,
  type MotionLibraryId,
  type MotionLibraryLoader,
  type RemoteMotionLibraryUse,
} from "@vidcom/contracts";
