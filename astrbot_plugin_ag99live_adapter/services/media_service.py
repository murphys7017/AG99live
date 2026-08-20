"""媒体服务：音频流式缓冲、文件缓存、前端图片落地。

承载三类能力：
  1. 流式音频缓冲（append_audio_chunk / drain_audio_buffer / clear_audio_buffer）：
     接收 VAD 引擎切分的小段 float32，按 segment_id 分桶堆积，最后一次性 drain。
  2. 音频文件缓存（cache_audio_file）：把 AstrBot 生成的任意格式音频转 wav，
     落到 http_port 暴露的 /cache/audio/ 下，发给前端用。
  3. 前端图片落地（convert_image_component / convert_image_component_with_diagnostic）：
     接受 data: / base64:// / 本地路径 / http URL 四种形式，只在白名单根目录内的
     本地文件被允许拷贝到 image_cache_dir。
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
from pathlib import Path
import re
import shutil
import threading
import time
from urllib.parse import unquote
from uuid import uuid4
import wave

import numpy as np

from astrbot.api import logger
from astrbot.api.message_components import Image
from astrbot.core.utils.astrbot_path import get_astrbot_temp_path
from pydub import AudioSegment

AUDIO_CACHE_MAX_FILES = 120
AUDIO_CACHE_MAX_AGE_SECONDS = 6 * 60 * 60
AUDIO_CACHE_TRIM_PROTECTION_SECONDS = 10 * 60
FRONTEND_IMAGE_MAX_BYTES = 10 * 1024 * 1024
FRONTEND_IMAGE_ALLOWED_SUFFIXES = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
}


class MediaService:
    """音频流缓冲 + 缓存 + 前端图片落地。

    内部以 asyncio.Lock 串行化音频缓冲读写；缓冲按 segment_id 分桶，None/空串
    都被规范化为 "__default__"。每次 cache_audio_file 调用前会先做一次缓存
    清理（_cleanup_audio_cache），见顶部常量。
    """

    def __init__(
        self,
        *,
        host: str,
        http_port: int,
        live2ds_dir: Path,
        olv_dir: Path,
        audio_cache_dir: Path,
        image_cache_dir: Path,
    ) -> None:
        self.host = host
        self.http_port = http_port
        self.live2ds_dir = live2ds_dir
        self.olv_dir = olv_dir
        self.audio_cache_dir = audio_cache_dir
        self.image_cache_dir = image_cache_dir
        self._audio_buffer_chunks_by_segment: dict[str, list[np.ndarray]] = {}
        self._audio_buffer_lock = asyncio.Lock()
        self._audio_cache_cleanup_lock = threading.Lock()

        self._prepare_audio_cache_dir()
        self._cleanup_audio_cache()

    async def append_audio_chunk(self, chunk: np.ndarray, segment_id: str | None = None) -> None:
        if chunk.size == 0:
            return

        buffer_key = self._normalize_audio_segment_id(segment_id)
        async with self._audio_buffer_lock:
            self._audio_buffer_chunks_by_segment.setdefault(buffer_key, []).append(chunk)

    async def drain_audio_buffer(self, segment_id: str | None = None) -> np.ndarray:
        buffer_key = self._normalize_audio_segment_id(segment_id)
        async with self._audio_buffer_lock:
            chunks = self._audio_buffer_chunks_by_segment.pop(buffer_key, [])
            if not chunks:
                return np.array([], dtype=np.float32)

        if len(chunks) == 1:
            return chunks[0].copy()

        return np.concatenate(chunks).astype(np.float32, copy=False)

    async def clear_audio_buffer(self, segment_id: str | None = None) -> None:
        async with self._audio_buffer_lock:
            if segment_id is None:
                self._audio_buffer_chunks_by_segment = {}
                return

            buffer_key = self._normalize_audio_segment_id(segment_id)
            self._audio_buffer_chunks_by_segment.pop(buffer_key, None)

    def _normalize_audio_segment_id(self, segment_id: str | None) -> str:
        normalized = str(segment_id or "").strip()
        return normalized or "__default__"

    def cache_audio_file(self, source_audio_path: str) -> tuple[str, str]:
        """把任意格式的音频文件转 wav 落到 audio_cache_dir，返回 (本地路径, http URL)。

        每次调用前都触发一次 _cleanup_audio_cache。新文件名用 uuid4().hex。
        源文件不存在时 FileNotFoundError；转码失败时包成 ValueError 抛出。
        得到的 http URL 由 static_server 暴露，前端拉来播放和做 lip sync。
        """
        self._cleanup_audio_cache()

        source_path = Path(source_audio_path)
        if not source_path.exists():
            raise FileNotFoundError(f"Audio file not found: {source_audio_path}")

        self._prepare_audio_cache_dir()
        cached_filename = f"{uuid4().hex}.wav"
        cached_path = self.audio_cache_dir / cached_filename

        if self._is_pcm_wav_file(source_path):
            shutil.copy2(source_path, cached_path)
            audio_url = f"http://{self.host}:{self.http_port}/cache/audio/{cached_filename}"
            return str(cached_path), audio_url

        try:
            audio = AudioSegment.from_file(source_path)
            audio.export(cached_path, format="wav")
        except Exception as exc:
            raise ValueError(
                f"Failed to convert generated audio file `{source_audio_path}` to wav cache: {exc}"
            ) from exc

        audio_url = f"http://{self.host}:{self.http_port}/cache/audio/{cached_filename}"
        return str(cached_path), audio_url

    def _is_pcm_wav_file(self, source_path: Path) -> bool:
        if source_path.suffix.lower() != ".wav":
            return False

        try:
            with wave.open(str(source_path), "rb") as wav_file:
                comptype = wav_file.getcomptype()
                sample_width = wav_file.getsampwidth()
                channel_count = wav_file.getnchannels()
                sample_rate = wav_file.getframerate()
        except (OSError, EOFError, wave.Error):
            return False

        if comptype != "NONE":
            return False
        if sample_width <= 0 or channel_count <= 0 or sample_rate <= 0:
            return False
        return True

    def convert_image_component(self, image_payload):
        image_component, _ = self.convert_image_component_with_diagnostic(image_payload)
        return image_component

    def convert_image_component_with_diagnostic(self, image_payload):
        if isinstance(image_payload, str) and image_payload:
            local_path, diagnostic = self._save_frontend_image_payload_to_local_path(
                image_payload
            )
            if local_path:
                return Image.fromFileSystem(path=local_path), None
            if image_payload.startswith("http://") or image_payload.startswith("https://"):
                return Image.fromURL(url=image_payload), None
            return None, diagnostic or _build_image_diagnostic("unsupported_image_payload")

        if not isinstance(image_payload, dict):
            return None, _build_image_diagnostic("unsupported_image_payload")

        data = image_payload.get("data")
        mime_type = image_payload.get("mime_type", "image/png")
        if isinstance(data, str) and data:
            local_path, diagnostic = self._save_frontend_image_payload_to_local_path(
                data,
                mime_type=mime_type,
            )
            if local_path:
                return Image.fromFileSystem(path=local_path), None
            if data.startswith("http://") or data.startswith("https://"):
                return Image.fromURL(url=data), None
            return None, diagnostic or _build_image_diagnostic("unsupported_image_payload")
        return None, _build_image_diagnostic("unsupported_image_payload")

    def save_audio_buffer_to_temp_wav(
        self,
        audio_buffer: np.ndarray,
        *,
        sample_rate: int = 16000,
    ) -> str:
        """把一段 float32 缓冲（[-1, 1]）落成单声道 16-bit PCM wav 临时文件。

        路径在 AstrBot 临时目录下，文件名带 uuid4().hex。返回临时文件绝对路径；
        调用方负责在用完后清理（SpeechIngressService 用 _pending_temp_audio_files
        做延迟回收）。
        """
        temp_dir = get_astrbot_temp_path()
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, f"olv_stt_{uuid4().hex}.wav")

        audio = audio_buffer.astype(np.float32)
        audio = np.clip(audio, -1.0, 1.0)
        pcm = (audio * 32767).astype(np.int16)

        with wave.open(temp_path, "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(max(int(sample_rate), 1))
            wf.writeframes(pcm.tobytes())

        return temp_path

    def _prepare_audio_cache_dir(self) -> None:
        self.audio_cache_dir.mkdir(parents=True, exist_ok=True)

    def _cleanup_audio_cache(self) -> None:
        """音频缓存两段清理。

        先按 mtime 把超 AUDIO_CACHE_MAX_AGE_SECONDS（6h）的文件删掉；再对剩下的
        文件按 mtime 排序，剔除超过 AUDIO_CACHE_MAX_FILES（120）个老文件，但
        AUDIO_CACHE_TRIM_PROTECTION_SECONDS（10m）内的新文件不受数量限制保留。
        """
        with self._audio_cache_cleanup_lock:
            self._prepare_audio_cache_dir()
            now = time.time()
            cached_files = self._snapshot_audio_cache_files()

            for entry, modified_at in cached_files:
                if now - modified_at <= AUDIO_CACHE_MAX_AGE_SECONDS:
                    continue

                try:
                    entry.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning(
                        "Failed to remove expired audio cache file `%s`: %s",
                        entry,
                        exc,
                    )

            protected_cutoff = now - AUDIO_CACHE_TRIM_PROTECTION_SECONDS
            trimmable_files = sorted(
                (
                    (entry, modified_at)
                    for entry, modified_at in self._snapshot_audio_cache_files()
                    if modified_at <= protected_cutoff
                ),
                key=lambda item: item[1],
                reverse=True,
            )

            for entry, _modified_at in trimmable_files[AUDIO_CACHE_MAX_FILES:]:
                try:
                    entry.unlink(missing_ok=True)
                except OSError as exc:
                    logger.warning(
                        "Failed to trim audio cache file `%s`: %s",
                        entry,
                        exc,
                    )

    def _snapshot_audio_cache_files(self) -> list[tuple[Path, float]]:
        files: list[tuple[Path, float]] = []
        for entry in self.audio_cache_dir.iterdir():
            try:
                if entry.is_file():
                    files.append((entry, entry.stat().st_mtime))
            except OSError:
                continue
        return files

    def _save_frontend_image_payload_to_local_path(
        self,
        image_payload: str,
        *,
        mime_type: str | None = None,
    ) -> tuple[str | None, dict[str, str] | None]:
        payload = (image_payload or "").strip()
        if not payload:
            return None, _build_image_diagnostic("empty_image_payload")

        if payload.startswith("file:///"):
            source_path = Path(unquote(payload.replace("file:///", "", 1)))
            return self._copy_allowed_frontend_image_to_cache(source_path, mime_type)

        if os.path.exists(payload):
            return self._copy_allowed_frontend_image_to_cache(Path(payload), mime_type)

        if payload.startswith("http://") or payload.startswith("https://"):
            return None, None

        image_bytes: bytes | None = None
        resolved_mime_type = mime_type or "image/png"

        if payload.startswith("data:"):
            data_match = re.match(
                r"^data:(?P<mime>[\w.+-]+/[\w.+-]+);base64,(?P<data>.+)$",
                payload,
                re.DOTALL,
            )
            if not data_match:
                logger.warning("Unsupported frontend image data URI, skip saving image.")
                return None, _build_image_diagnostic("unsupported_data_uri")
            resolved_mime_type = data_match.group("mime") or resolved_mime_type
            try:
                image_bytes = base64.b64decode(data_match.group("data"))
            except Exception as exc:
                logger.warning("Failed to decode frontend image data URI: %s", exc)
                return None, _build_image_diagnostic("invalid_base64_payload")
        else:
            compact_payload = payload
            if compact_payload.startswith("base64://"):
                compact_payload = compact_payload.removeprefix("base64://")
            try:
                image_bytes = base64.b64decode(compact_payload)
            except Exception:
                return None, _build_image_diagnostic("invalid_base64_payload")

        return self._write_frontend_image_bytes(image_bytes, resolved_mime_type)

    def _write_frontend_image_bytes(
        self,
        image_bytes: bytes | None,
        mime_type: str,
    ) -> tuple[str | None, dict[str, str] | None]:
        if not image_bytes:
            return None, _build_image_diagnostic("empty_image_payload")

        if len(image_bytes) > FRONTEND_IMAGE_MAX_BYTES:
            logger.warning(
                "Rejected frontend image larger than %s bytes.",
                FRONTEND_IMAGE_MAX_BYTES,
            )
            return None, _build_image_diagnostic("image_too_large")

        self.image_cache_dir.mkdir(parents=True, exist_ok=True)
        suffix = mimetypes.guess_extension(mime_type or "") or ".png"
        if suffix == ".jpe":
            suffix = ".jpg"

        image_path = self.image_cache_dir / f"frontend_{uuid4().hex}{suffix}"
        image_path.write_bytes(image_bytes)
        logger.debug("Saved frontend image to local file: %s", image_path)
        return str(image_path.resolve()), None

    def _copy_allowed_frontend_image_to_cache(
        self,
        source_path: Path,
        mime_type: str | None = None,
    ) -> tuple[str | None, dict[str, str] | None]:
        try:
            resolved_path = source_path.expanduser().resolve(strict=True)
        except OSError:
            return None, _build_image_diagnostic("invalid_local_path")

        if not resolved_path.is_file():
            return None, _build_image_diagnostic("invalid_local_path")

        if not self._is_allowed_frontend_image_path(resolved_path):
            logger.warning(
                "Rejected frontend local image path outside allowed roots: %s",
                resolved_path,
            )
            return None, _build_image_diagnostic("local_path_outside_allowed_roots")

        if resolved_path.suffix.lower() not in FRONTEND_IMAGE_ALLOWED_SUFFIXES:
            logger.warning(
                "Rejected frontend local image path with unsupported suffix: %s",
                resolved_path,
            )
            return None, _build_image_diagnostic("unsupported_local_suffix")

        try:
            image_bytes = resolved_path.read_bytes()
        except OSError as exc:
            logger.warning("Failed to read frontend local image `%s`: %s", resolved_path, exc)
            return None, _build_image_diagnostic("local_read_failed")

        if not image_bytes:
            return None, _build_image_diagnostic("empty_image_payload")

        if len(image_bytes) > FRONTEND_IMAGE_MAX_BYTES:
            logger.warning(
                "Rejected frontend image larger than %s bytes: %s",
                FRONTEND_IMAGE_MAX_BYTES,
                resolved_path,
            )
            return None, _build_image_diagnostic("image_too_large")

        resolved_mime_type = (
            mime_type or mimetypes.guess_type(str(resolved_path))[0] or "image/png"
        )
        return self._write_frontend_image_bytes(image_bytes, resolved_mime_type)

    def _is_allowed_frontend_image_path(self, path: Path) -> bool:
        for root in self._frontend_image_allowed_roots():
            try:
                path.relative_to(root)
                return True
            except ValueError:
                continue
        return False

    def _frontend_image_allowed_roots(self) -> tuple[Path, ...]:
        temp_root = Path(get_astrbot_temp_path()).resolve()
        return (
            self.image_cache_dir.resolve(),
            self.live2ds_dir.resolve(),
            (self.olv_dir / "avatars").resolve(),
            (self.olv_dir / "backgrounds").resolve(),
            temp_root,
        )


def _build_image_diagnostic(reason: str) -> dict[str, str]:
    return {"reason": reason}
