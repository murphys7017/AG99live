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
from .sampler import SamplingProgress, sample_parameters, subscribe_environment_events


DEFAULT_ENDPOINT = "ws://localhost:8001"


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(_run(args))
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="VTube Studio parameter discovery and in-memory sampling probe."
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
    return parser


async def _run(args: argparse.Namespace) -> None:
    _validate_args(args)
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
    if args.command == "sample":
        if args.hz <= 0 or args.hz > 30:
            raise ValueError("hz must be greater than 0 and no greater than 30 for this probe")
        if args.seconds <= 0:
            raise ValueError("seconds must be greater than 0")


def _print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _print_sampling_progress(progress: SamplingProgress) -> None:
    _print_progress(
        "sampling progress: "
        f"{progress.elapsed_seconds:.1f}/{progress.target_seconds:.1f}s, "
        f"samples={progress.sample_count}, errors={progress.error_count}, "
        f"skipped={progress.skipped_schedule_slots}"
    )


def _print_progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)
