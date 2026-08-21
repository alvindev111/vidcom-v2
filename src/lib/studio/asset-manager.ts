import { apiUrl, type ApiPath, type ApiRequestInit } from "@/lib/api/services";

export type UploadAssetKind = "image" | "video" | "audio" | "font";

const EXTENSIONS: ReadonlyArray<readonly [UploadAssetKind, ReadonlySet<string>]> = [
  ["image", new Set(["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"])],
  ["video", new Set(["mp4", "webm", "mov"])],
  ["audio", new Set(["mp3", "wav", "ogg", "m4a"])],
  ["font", new Set(["woff", "woff2", "ttf", "otf"])],
];

export function assetKindFromName(name: string): UploadAssetKind | null {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  return EXTENSIONS.find(([, values]) => values.has(extension))?.[0] ?? null;
}

export function entryMutationRequest(
  projectId: string,
  action: "create" | "rename" | "prepare-delete" | "delete",
  body: object,
  grantId?: string,
): { path: ApiPath; init: ApiRequestInit } {
  const root = `/api/v1/projects/${encodeURIComponent(projectId)}/entries` as ApiPath;
  const path = action === "prepare-delete"
    ? `${root}/deletions` as ApiPath
    : action === "delete"
      ? `${root}/deletions/${encodeURIComponent(grantId ?? "")}` as ApiPath
      : root;
  return {
    path,
    init: {
      method: action === "rename" ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

interface XhrLike {
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  status: number;
  responseText: string;
  withCredentials: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: File): void;
  abort(): void;
}

type XhrConstructor = new () => XhrLike;

export function startAssetUpload(
  input: {
    projectId: string;
    file: File;
    expectedRevision: number;
    requestInit: ApiRequestInit;
    /** Set when the upload is the first half of a timeline drop (R11.3b). */
    pendingMount?: { operationId: string; atSeconds: number; trackIndex: number };
    onProgress(value: number): void;
  },
  Xhr: XhrConstructor = XMLHttpRequest as unknown as XhrConstructor,
): { promise: Promise<{ path: string; changeSeq: number | null }>; cancel(): void } {
  const kind = assetKindFromName(input.file.name);
  if (!kind) {
    return {
      promise: Promise.reject(new Error("unsupported asset type")),
      cancel() {},
    };
  }
  const query = new URLSearchParams({
    kind,
    filename: input.file.name,
    expectedRevision: String(input.expectedRevision),
    ...(input.pendingMount === undefined ? {} : {
      operationId: input.pendingMount.operationId,
      atSeconds: String(input.pendingMount.atSeconds),
      trackIndex: String(input.pendingMount.trackIndex),
    }),
  });
  const xhr = new Xhr();
  const promise = new Promise<{ path: string; changeSeq: number | null }>((resolve, reject) => {
    xhr.open("POST", apiUrl(`/api/v1/projects/${encodeURIComponent(input.projectId)}/assets?${query}` as ApiPath));
    xhr.withCredentials = true;
    const headers = new Headers(input.requestInit.headers);
    headers.set("content-type", "application/octet-stream");
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) input.onProgress(Math.min(90, event.loaded / event.total * 90));
    };
    xhr.onload = () => {
      type Payload = { path?: string; changeSeq?: number | null; error?: { message?: string } };
      let payload: Payload | null = null;
      try { payload = JSON.parse(xhr.responseText) as Payload; } catch { /* mapped below */ }
      if (xhr.status < 200 || xhr.status >= 300 || !payload?.path) {
        reject(new Error(payload?.error?.message ?? `upload failed (${xhr.status})`));
        return;
      }
      input.onProgress(90);
      input.onProgress(100);
      resolve({ path: payload.path, changeSeq: payload.changeSeq ?? null });
    };
    // The bytes may or may not have landed. The drop machine has to ask the
    // server which before it considers resending them.
    xhr.onerror = () => reject(Object.assign(new Error("upload connection failed"), { ambiguous: true }));
    xhr.onabort = () => reject(new Error("upload cancelled"));
    input.onProgress(0);
    xhr.send(input.file);
  });
  return { promise, cancel: () => xhr.abort() };
}
