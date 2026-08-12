/** A non-blocking composition issue; Phase 1 responses always return an empty list. */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  sceneId?: string;
  elementId?: string;
  effectId?: string;
  file?: string;
  line?: number;
  message: string;
  details?: Record<string, unknown>;
  fix?: {
    kind: "set-attribute";
    target: string;
    attribute: string;
    value: string;
  };
}
