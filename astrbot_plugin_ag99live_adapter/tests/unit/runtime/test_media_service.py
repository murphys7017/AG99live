from __future__ import annotations

import importlib
import struct
import wave


def _install_media_service_dependencies(install_fake_astrbot, monkeypatch) -> None:
    install_fake_astrbot()
    message_components = importlib.import_module("types").ModuleType(
        "astrbot.api.message_components"
    )

    class Image:
        @staticmethod
        def fromFileSystem(path: str):
            return {"type": "file", "path": path}

        @staticmethod
        def fromURL(url: str):
            return {"type": "url", "url": url}

    message_components.Image = Image
    monkeypatch.setitem(
        importlib.import_module("sys").modules,
        "astrbot.api.message_components",
        message_components,
    )

    astrbot_path_module = importlib.import_module("types").ModuleType(
        "astrbot.core.utils.astrbot_path"
    )
    astrbot_path_module.get_astrbot_temp_path = lambda: "."
    monkeypatch.setitem(
        importlib.import_module("sys").modules,
        "astrbot.core.utils.astrbot_path",
        astrbot_path_module,
    )


def _create_media_service(install_fake_astrbot, monkeypatch, tmp_path):
    _install_media_service_dependencies(install_fake_astrbot, monkeypatch)
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.services.media_service")
    MediaService = module.MediaService
    return MediaService(
        host="127.0.0.1",
        http_port=12345,
        live2ds_dir=tmp_path / "live2ds",
        olv_dir=tmp_path / "assets",
        audio_cache_dir=tmp_path / "cache" / "audio",
        image_cache_dir=tmp_path / "cache" / "images",
    )


def _write_pcm_wav(path, *, channels: int = 1, sample_rate: int = 16000) -> bytes:
    frames = struct.pack("<hhhh", 0, 1200, -1200, 0)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(channels)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(frames)
    return path.read_bytes()


def test_cache_audio_file_passthroughs_pcm_wav(
    install_fake_astrbot,
    monkeypatch,
    tmp_path,
) -> None:
    media_service = _create_media_service(install_fake_astrbot, monkeypatch, tmp_path)
    source_path = tmp_path / "source.wav"
    source_bytes = _write_pcm_wav(source_path)

    module = importlib.import_module("astrbot_plugin_ag99live_adapter.services.media_service")

    def fail_from_file(_path):
        raise AssertionError("pcm wav fast path should not invoke pydub conversion")

    monkeypatch.setattr(module.AudioSegment, "from_file", fail_from_file)

    cached_path, audio_url = media_service.cache_audio_file(str(source_path))

    assert cached_path.endswith(".wav")
    assert audio_url.startswith("http://127.0.0.1:12345/cache/audio/")
    assert source_path.read_bytes() == source_bytes
    assert source_path != importlib.import_module("pathlib").Path(cached_path)
    assert importlib.import_module("pathlib").Path(cached_path).read_bytes() == source_bytes


def test_cache_audio_file_falls_back_to_conversion_for_non_pcm_wav(
    install_fake_astrbot,
    monkeypatch,
    tmp_path,
) -> None:
    media_service = _create_media_service(install_fake_astrbot, monkeypatch, tmp_path)
    source_path = tmp_path / "source.wav"
    source_path.write_bytes(b"RIFFnot-a-real-wav")
    module = importlib.import_module("astrbot_plugin_ag99live_adapter.services.media_service")
    calls: list[str] = []

    class FakeAudioSegment:
        def export(self, target_path, format: str):
            calls.append(f"export:{format}")
            importlib.import_module("pathlib").Path(target_path).write_bytes(b"converted-wav")

    def fake_from_file(path):
        calls.append(f"from_file:{path}")
        return FakeAudioSegment()

    monkeypatch.setattr(module.AudioSegment, "from_file", fake_from_file)

    cached_path, _audio_url = media_service.cache_audio_file(str(source_path))

    assert calls == [f"from_file:{source_path}", "export:wav"]
    assert importlib.import_module("pathlib").Path(cached_path).read_bytes() == b"converted-wav"
