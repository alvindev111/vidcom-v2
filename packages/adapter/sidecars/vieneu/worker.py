"""VieNeu-TTS v3 Turbo sidecar for VidCom.

Two modes, both driven entirely by argv and files:

    worker.py --probe
        Prints one JSON object on stdout: whether the engine imports, which
        preset voices it offers, and whether a GPU can actually be used. It
        resolves the requested model snapshot first, making a ready response
        proof that synthesis can enter warm-offline mode.

    worker.py --request <path> --response <path>
        Builds the engine once, speaks every cue in the request, writes one WAV
        per cue into the request's outputDir, then writes the response JSON.

Everything except --probe output goes to stderr. VidCom's MCP mode shares stdout
with the MCP protocol stream, and a single stray print from a dependency would
corrupt it.

Upstream API reference: https://github.com/pnnbao97/VieNeu-TTS
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCHEMA_VERSION = 1
MODEL_ID = "vieneu-v3-turbo"
MODEL_REPO = "pnnbao-ump/VieNeu-TTS-v3-Turbo"

# CPU runs the ONNX backend, which the upstream SDK ships torch-free; asking for
# it by name is what keeps a machine that happens to have torch installed from
# quietly taking the CUDA path. GPU has no explicit selector in the SDK — it
# auto-detects — so the sidecar's job is to refuse the GPU request outright when
# CUDA is unusable rather than let auto-detection fall back to CPU in silence.
CPU_BACKEND = "onnx"


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def model_cache_root() -> Path:
    """Absolute directory the model weights are downloaded into.

    Required, never defaulted. HuggingFace otherwise caches under the current
    working directory or ~/.cache depending on how it was invoked, and the first
    of those drops several hundred megabytes of weights inside whatever checkout
    the process happened to start in. VidCom passes an app-data path.
    """
    raw = os.environ.get("HF_HOME", "").strip()
    if not raw:
        raise RuntimeError("HF_HOME must point at a writable model cache outside the source tree")
    root = Path(raw)
    if not root.is_absolute():
        raise RuntimeError(f"HF_HOME must be an absolute path, got {raw!r}")
    root.mkdir(parents=True, exist_ok=True)
    # HuggingFace reads several of these depending on library version. Pinning
    # all of them means no code path can pick a default.
    os.environ["HF_HOME"] = str(root)
    os.environ["HF_HUB_CACHE"] = str(root / "hub")
    os.environ["TORCH_HOME"] = str(root / "torch")
    return root


def gpu_usable() -> bool:
    """Whether a CUDA device can actually be allocated on, not merely detected.

    `torch.cuda.is_available()` returns True for a driver that cannot serve this
    process. Allocating proves it. An unusable device must read as "no GPU" here
    rather than surfacing later as a failed batch, and the torch-free CPU install
    has no torch at all — which is a normal state, not an error.
    """
    try:
        import torch
    except ImportError:
        return False
    try:
        if not torch.cuda.is_available():
            return False
        torch.zeros(1, device="cuda")
        return True
    except Exception as error:  # noqa: BLE001 - any allocation failure means no GPU
        log(f"cuda present but unusable: {error}")
        return False


def engine_version() -> str:
    """Installed `vieneu` version, or "" when it cannot be determined.

    Read from package metadata, not from `vieneu.__version__`: upstream 3.2.4
    does not define that attribute, so the previous `getattr` always returned ""
    and left `vidcom doctor` with no version to report.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version as metadata_version

        return metadata_version("vieneu")
    except Exception:  # noqa: BLE001 - an unreportable version is not a failure
        return ""


def speaker_name(entry: object) -> str:
    """The name `Vieneu.infer(voice=…)` accepts, from one `list_preset_voices()` entry.

    Upstream returns `(label, name)` pairs — the label carries gender/region/style
    ("Minh Đức — Nam · Bắc · Phong cách tin tức") and only the second element is
    the name the engine will accept. The previous `str(entry)` stringified the
    whole tuple, so VidCom's catalog held `"('Minh Đức — …', 'Minh Đức')"` and
    every synthesis with a catalog-chosen voice failed with `Voice … not found`.

    Written to survive an upstream that returns plain strings instead: a bare
    string is used as-is, and any other sequence yields its last element, which
    is where the engine name sits today.
    """
    if isinstance(entry, str):
        return entry
    if isinstance(entry, (list, tuple)) and entry:
        return str(entry[-1])
    return str(entry)


def probe() -> int:
    """Report engine readiness, the preset voice list, and whether a GPU is usable.

    Upstream exposes `list_preset_voices()` only as an instance method, so this
    has to construct the engine. The requested snapshot is resolved explicitly
    first: engine construction alone does not prove that the revision synthesis
    will request is complete. `model_cache_root()` runs before either operation,
    so an unset HF_HOME cannot drop weights in the working directory. VidCom
    caches this result for the life of the process, so the cost is paid at most
    once per run.
    """
    ready = False
    voices: list[str] = []
    version = ""
    try:
        model_cache_root()
        import vieneu

        version = engine_version()
        # A successful probe is the cache-completeness boundary used by the
        # TypeScript download coordinator. Constructing the engine alone is not
        # sufficient proof: synthesis resolves an explicit revision snapshot,
        # which can still be absent even when voices are available.
        download_model(pinned_revision())
        engine = vieneu.Vieneu(backend=CPU_BACKEND)
        # The catalog is the engine's own list, never a copy maintained in
        # TypeScript: a hard-coded list drifts the moment upstream adds a voice,
        # and a name VidCom offers but the engine rejects fails at synthesis.
        voices = [speaker_name(entry) for entry in engine.list_preset_voices()]
        ready = bool(voices)
    except Exception as error:  # noqa: BLE001 - a missing dependency is a normal, reportable state
        log(f"vieneu sidecar is not ready: {error}")

    json.dump({
        "schemaVersion": SCHEMA_VERSION,
        "ready": ready,
        "gpu": gpu_usable(),
        "voices": voices,
        "engineVersion": version,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


def pinned_revision() -> str | None:
    """Model repository revision to download, when the operator pinned one.

    No commit is hard-coded here: inventing a SHA would break every install, and
    upstream publishes no stable tag VidCom could follow. Set
    `VIDCOM_VIENEU_REVISION` to freeze output across machines. Unpinned, the
    resolved revision is still reported back so a given WAV is traceable to the
    weights that produced it.
    """
    revision = os.environ.get("VIDCOM_VIENEU_REVISION", "").strip()
    return revision or None


def download_model(revision: str | None) -> str:
    """Fetch the weights and return the exact commit they came from."""
    from huggingface_hub import snapshot_download

    path = snapshot_download(repo_id=MODEL_REPO, revision=revision)
    # snapshot_download lays the files out under <cache>/snapshots/<commit>/.
    resolved = Path(path).name
    log(f"model {MODEL_REPO}@{resolved} is available at {path}")
    return resolved


def build_engine(device: str):
    """Construct the engine for the requested device, or fail rather than downgrade.

    A GPU request that silently runs on CPU is the failure mode this sidecar
    exists to prevent: the batch still succeeds, an order of magnitude slower,
    and nothing in the logs says why.
    """
    from vieneu import Vieneu

    if device == "cpu":
        return Vieneu(backend=CPU_BACKEND)
    if device != "gpu":
        raise ValueError(f"unknown device {device!r}")
    if not gpu_usable():
        raise RuntimeError(
            "gpu was requested but no usable CUDA device is available — "
            'install the GPU extra with `pip install "vieneu[gpu]"` or use the CPU device'
        )
    # No backend argument: the SDK switches to its torch path on its own once
    # CUDA is present, and naming a backend here would pin it back to ONNX.
    return Vieneu()


def synthesize(request_path: Path, response_path: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    if request.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported request schema version")
    if request.get("modelId") != MODEL_ID:
        raise ValueError(f"unsupported model {request.get('modelId')!r}")

    output_dir = Path(request["outputDir"])
    if not output_dir.is_dir():
        raise ValueError("outputDir does not exist")

    device = request.get("device", "cpu")
    cache_root = model_cache_root()
    log(f"model cache: {cache_root}")
    revision = download_model(pinned_revision())
    engine = build_engine(device)

    assets = []
    for cue in request["cues"]:
        cue_id = cue["id"]
        # The id was validated on the VidCom side, but this sidecar can be run by
        # hand; refusing a separator here keeps a hand-written request from
        # writing outside outputDir.
        if "/" in cue_id or "\\" in cue_id or cue_id in {".", ".."}:
            raise ValueError(f"unsafe cue id {cue_id!r}")
        target = output_dir / f"{cue_id}.vieneu.wav"
        log(f"synthesizing {cue_id}")
        audio = engine.infer(cue["text"], voice=request["voice"])
        engine.save(audio, str(target))
        if not target.is_file() or target.stat().st_size < 256:
            raise RuntimeError(f"no audio was produced for {cue_id}")
        assets.append({"cueId": cue_id, "path": str(target)})

    response_path.write_text(
        json.dumps({
            "schemaVersion": SCHEMA_VERSION,
            "provider": "vieneu",
            "modelId": MODEL_ID,
            "modelRevision": revision,
            "effectiveDevice": device,
            "assets": assets,
        }, ensure_ascii=False),
        encoding="utf-8",
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="VieNeu-TTS sidecar for VidCom")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--request", type=Path)
    parser.add_argument("--response", type=Path)
    args = parser.parse_args()

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    if args.probe:
        return probe()
    if not args.request or not args.response:
        parser.error("--request and --response are required unless --probe is given")

    try:
        return synthesize(args.request, args.response)
    except Exception as error:  # noqa: BLE001 - the message is the user-facing diagnosis
        log(str(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
