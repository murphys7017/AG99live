from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .auth import TokenStore, authenticate, default_token_path
from .client import VTSClient
from .discovery import discover_parameters
from .live_recorder import list_microphones, record_live
from .recorder import record_parameters
from .sampler import SamplingProgress, sample_parameters, subscribe_environment_events
from .store import RecorderStore, default_database_path


DEFAULT_ENDPOINT = "ws://localhost:8001"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(_run(args))
    except KeyboardInterrupt:
        print("interrupted before a report was available", file=sys.stderr)
        return 130
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="VTube Studio parameter discovery, sampling, and independent recording tool."
    )
    parser.add_argument("--url", default=DEFAULT_ENDPOINT, help="VTS WebSocket URL")
    parser.add_argument(
        "--timeout",
        type=float,
        default=5.0,
        help="Connection and normal request timeout in seconds (default: 5)",
    )
    parser.add_argument(
        "--token-file",
        type=Path,
        default=default_token_path(),
        help="Local authentication token path; keep it outside the repository",
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=default_database_path(),
        help="Independent SQLite recording database path",
    )
    parser.add_argument(
        "--reauthorize",
        action="store_true",
        help="Request a new VTS token and show the VTS approval dialog",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="Check VTS API availability without authenticating")
    commands.add_parser("discover", help="Authenticate and list current VTS parameters")
    sample = commands.add_parser("sample", help="Authenticate and sample parameters in memory")
    sample.add_argument("--hz", type=float, default=20.0, help="Sampling rate, 0 < hz <= 30")
    sample.add_argument("--seconds", type=float, default=30.0, help="Sampling duration in seconds")
    record = commands.add_parser("record", help="Record VTS parameters into the independent SQLite database")
    record.add_argument("--hz", type=float, default=20.0, help="Sampling rate, 0 < hz <= 30")
    record.add_argument("--seconds", type=float, default=30.0, help="Sampling duration in seconds")
    record.add_argument("--label", help="Optional internal operator label for this take")
    live = commands.add_parser(
        "live-record",
        help="Continuously record VTS parameters, microphone WAV, and local streaming STT events",
    )
    live.add_argument("--hz", type=float, default=20.0, help="VTS sampling rate, 0 < hz <= 30")
    live.add_argument(
        "--seconds",
        type=float,
        help="Optional duration; omit to record until Ctrl+C",
    )
    live.add_argument("--label", help="Optional operator label for this live session")
    live.add_argument("--stt-model", type=Path, required=True, help="Local sherpa-onnx model directory")
    live.add_argument("--stt-provider", choices=("cpu", "cuda"), default="cpu")
    live.add_argument("--stt-threads", type=int, default=4)
    live.add_argument(
        "--microphone",
        help="Exact microphone name or ID; omit to use the Windows default input device",
    )
    live.add_argument(
        "--audio-output",
        type=Path,
        help="WAV output path; defaults beside the database",
    )
    commands.add_parser("list", help="List takes in the independent recording database")
    commands.add_parser("list-microphones", help="List available microphone names and IDs")
    inspect = commands.add_parser("inspect", help="Inspect one recorded take without dumping raw frames")
    inspect.add_argument("take_id", type=int)
    annotate = commands.add_parser("annotate", help="Attach human context and a reviewed target to one take")
    annotate.add_argument("take_id", type=int)
    annotate.add_argument("--status", dest="review_status", choices=("draft", "accepted", "rejected", "needs_review"), default="draft")
    annotate.add_argument("--prompt", help="Original natural-language instruction")
    annotate.add_argument("--action-kind", choices=("axis_levels", "motion_steps", "parameter_trace", "other"))
    annotate.add_argument("--emotion", help="Optional emotion or scene label")
    annotate.add_argument("--target-json", type=Path, help="JSON file containing the reviewed semantic target")
    annotate.add_argument("--note", dest="reviewer_note", help="Human review note")
    export = commands.add_parser("export", help="Export one take, including raw frames and annotation, as JSON")
    export.add_argument("take_id", type=int)
    export.add_argument("--output", type=Path, required=True, help="Destination JSON file")
    delete = commands.add_parser("delete", help="Permanently delete one take and its dependent records")
    delete.add_argument("take_id", type=int)
    return parser


async def _run(args: argparse.Namespace) -> None:
    _validate_args(args)
    if args.command == "list-microphones":
        _print_json({"microphones": list_microphones()})
        return
    if args.command in {"list", "inspect", "delete", "annotate", "export"}:
        with RecorderStore(args.database) as store:
            if args.command == "list":
                _print_json({"database": str(store.path), "takes": store.list_takes()})
                return
            if args.command == "inspect":
                take = store.inspect_take(args.take_id)
                if take is None:
                    raise ValueError(f"Unknown recording take ID: {args.take_id}")
                _print_json({"database": str(store.path), "take": take})
                return
            if args.command == "annotate":
                if store.inspect_take(args.take_id) is None:
                    raise ValueError(f"Unknown recording take ID: {args.take_id}")
                target = _read_json_file(args.target_json) if args.target_json else None
                if target is not None and not isinstance(target, dict):
                    raise ValueError("target JSON must contain an object")
                context = {
                    key: value
                    for key, value in {
                        "prompt": args.prompt,
                        "action_kind": args.action_kind,
                        "emotion": args.emotion,
                    }.items()
                    if value
                }
                store.save_annotation(
                    args.take_id,
                    review_status=args.review_status,
                    context=context or None,
                    target=target,
                    reviewer_note=args.reviewer_note,
                )
                _print_json({"database": str(store.path), "take": store.inspect_take(args.take_id)})
                return
            if args.command == "export":
                exported = store.export_take(args.take_id)
                if exported is None:
                    raise ValueError(f"Unknown recording take ID: {args.take_id}")
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(json.dumps(exported, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                _print_json({"database": str(store.path), "take_id": args.take_id, "output": str(args.output)})
                return
            if not store.delete_take(args.take_id):
                raise ValueError(f"Unknown recording take ID: {args.take_id}")
            _print_json({"database": str(store.path), "deleted_take_id": args.take_id})
            return

    async with VTSClient(
        args.url,
        connect_timeout_seconds=args.timeout,
        request_timeout_seconds=args.timeout,
    ) as client:
        if args.command == "status":
            response = await client.request("APIStateRequest")
            _print_json({"endpoint": args.url, "api_state": dict(response.data)})
            return

        authentication = await authenticate(
            client,
            TokenStore(args.token_file),
            reauthorize=args.reauthorize,
        )
        discovery = await discover_parameters(client)
        if args.command == "discover":
            _print_json(
                {
                    "endpoint": args.url,
                    "authentication": {
                        "reused_saved_token": authentication.reused_saved_token,
                    },
                    "discovery": discovery.to_dict(),
                }
            )
            return

        if not discovery.model_loaded:
            raise RuntimeError("VTube Studio has no loaded Live2D model; cannot start sampling")
        if not discovery.live2d_parameters:
            raise RuntimeError("VTube Studio returned no Live2D parameters; cannot start sampling")

        _print_progress("sample setup: subscribing to VTube Studio environment events")
        subscription_warnings = await subscribe_environment_events(client)
        if args.command in {"record", "live-record"}:
            api_state = await client.request("APIStateRequest")
            _print_progress(
                (
                    f"recording started: {args.hz:g} Hz for {args.seconds:g}s"
                    if args.command == "record"
                    else f"live recording started: {args.hz:g} Hz until Ctrl+C"
                )
                + "; progress is written to stderr"
            )
            with RecorderStore(args.database) as store:
                if args.command == "record":
                    recording = await record_parameters(
                        client,
                        store=store,
                        endpoint=args.url,
                        discovery=discovery,
                        vts_version=_optional_text(api_state.data.get("vtsVersion")),
                        hz=args.hz,
                        seconds=args.seconds,
                        operator_label=args.label,
                        subscription_warnings=subscription_warnings,
                    )
                    audio_path = None
                else:
                    audio_path = args.audio_output or (
                        args.database.parent / f"take-live-{int(asyncio.get_running_loop().time())}.wav"
                    )
                    recording = await record_live(
                        client,
                        store=store,
                        endpoint=args.url,
                        discovery=discovery,
                        vts_version=_optional_text(api_state.data.get("vtsVersion")),
                        hz=args.hz,
                        seconds=args.seconds,
                        operator_label=args.label,
                        subscription_warnings=subscription_warnings,
                        audio_path=audio_path,
                        stt_model_dir=args.stt_model,
                        stt_provider=args.stt_provider,
                        stt_num_threads=args.stt_threads,
                        microphone_name=args.microphone,
                        on_progress=_print_sampling_progress,
                    )
                take = store.inspect_take(recording.take_id)
            _print_json(
                {
                    "database": str(args.database),
                    "session_id": recording.session_id,
                    "audio": str(audio_path) if audio_path else None,
                    "take": take,
                }
            )
            return

        _print_progress(
            f"sampling started: {args.hz:g} Hz for {args.seconds:g}s; progress is written to stderr"
        )
        sampling = await sample_parameters(
            client,
            hz=args.hz,
            seconds=args.seconds,
            known_model_id=discovery.model_id,
            on_progress=_print_sampling_progress,
        )
        if subscription_warnings:
            sampling.report["event_subscription_warnings"] = subscription_warnings
        _print_json(
            {
                "endpoint": args.url,
                "authentication": {
                    "reused_saved_token": authentication.reused_saved_token,
                },
                "discovery": discovery.summary(),
                "sampling": sampling.report,
            }
        )


def _validate_args(args: argparse.Namespace) -> None:
    if args.timeout <= 0:
        raise ValueError("timeout must be greater than 0")
    if not str(args.url).startswith(("ws://", "wss://")):
        raise ValueError("url must start with ws:// or wss://")
    if args.command in {"sample", "record", "live-record"}:
        if args.hz <= 0 or args.hz > 30:
            raise ValueError("hz must be greater than 0 and no greater than 30 for this probe")
        if args.seconds is not None and args.seconds <= 0:
            raise ValueError("seconds must be greater than 0")
    if args.command == "live-record" and args.stt_threads <= 0:
        raise ValueError("stt-threads must be greater than 0")


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _print_sampling_progress(progress: SamplingProgress) -> None:
    target = f"{progress.target_seconds:.1f}s" if progress.target_seconds > 0 else "live"
    _print_progress(
        "sampling progress: "
        f"{progress.elapsed_seconds:.1f}/{target}, "
        f"samples={progress.sample_count}, errors={progress.error_count}, "
        f"skipped={progress.skipped_schedule_slots}"
    )


def _print_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _optional_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _read_json_file(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"cannot read JSON file {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON file {path}: {exc}") from exc
