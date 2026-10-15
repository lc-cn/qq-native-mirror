/** Explicit error fields suitable for diagnostic events across worker IPC. */
export interface DiagnosticFailure {
  message: string;
  name?: string;
  code?: string | number;
}

/** Runtime diagnostics expose supported fields rather than native error objects. */
export interface DiagnosticInfo {
  stage: string;
  cleanupFailures?: DiagnosticFailure[];
}
