from __future__ import annotations

import importlib
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def test_static_resource_server_serves_cache_audio_file(
    install_fake_astrbot,
    tmp_path,
) -> None:
    install_fake_astrbot()
    module = importlib.import_module(
        "astrbot_plugin_ag99live_adapter.transport.static_resources"
    )
    StaticResourceServer = module.StaticResourceServer

    cache_root = tmp_path / "cache"
    audio_dir = cache_root / "audio"
    audio_dir.mkdir(parents=True)
    audio_path = audio_dir / "voice.wav"
    audio_bytes = b"RIFFtest"
    audio_path.write_bytes(audio_bytes)

    server = StaticResourceServer(
        host="127.0.0.1",
        port=0,
        routes={
            "/cache": cache_root,
        },
    )
    server.start()
    try:
        assert server._server is not None
        port = server._server.server_address[1]
        with urlopen(
            f"http://127.0.0.1:{port}/cache/audio/voice.wav",
            timeout=3,
        ) as response:
            assert response.status == 200
            assert response.headers.get("Content-Length") == str(len(audio_bytes))
            assert response.read() == audio_bytes
        with urlopen(
            Request(
                f"http://127.0.0.1:{port}/cache/audio/voice.wav",
                method="OPTIONS",
            ),
            timeout=3,
        ) as response:
            assert response.status == 200
            assert response.headers.get("Access-Control-Allow-Methods") == "GET, HEAD, OPTIONS"
        try:
            urlopen(
                Request(
                    f"http://127.0.0.1:{port}/cache/audio/voice.wav",
                    method="POST",
                ),
                timeout=3,
            )
        except HTTPError as error:
            assert error.code == 501
        else:
            raise AssertionError("StaticResourceServer must reject POST requests.")
    finally:
        server.stop()
