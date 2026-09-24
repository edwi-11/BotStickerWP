"""MP4/MOV/WebM -> WebP animado con FFmpeg (sin shell, con timeouts)."""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from .image import TOP_BIAS, max_ratio

ANIM_LIMIT = 500 * 1024
MAX_DIM = 4096


class VideoError(Exception):
    pass


def _probe(src: Path) -> dict:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-select_streams", "v:0",
             "-show_entries", "stream=width,height:format=duration", "-of", "json", str(src)],
            capture_output=True, text=True, timeout=20, check=True,
        )
        data = json.loads(r.stdout)
        st = data["streams"][0]
        return {"w": int(st["width"]), "h": int(st["height"]), "dur": float(data["format"].get("duration") or 0)}
    except (subprocess.SubprocessError, KeyError, IndexError, ValueError, FileNotFoundError) as e:
        raise VideoError("Video invalido o ilegible (verifica que FFmpeg/ffprobe esten instalados)") from e


def _crop_filter(ratio: float) -> str:
    """Filtro de FFmpeg: recorta el sobrante para que lado_largo/lado_corto <= ratio.

    En videos verticales conserva mas la parte de arriba (TOP_BIAS); en horizontales centra.
    """
    r = f"{ratio:.4f}"
    return (f"crop=w='min(iw,ih*{r})':h='min(ih,iw*{r})':"
            f"x='(in_w-out_w)/2':y='(in_h-out_h)*{TOP_BIAS}'")


def convert_video(src: Path, out: Path) -> None:
    info = _probe(src)
    if info["w"] > MAX_DIM or info["h"] > MAX_DIM:
        raise VideoError("Resolucion de video demasiado alta")
    # Videos largos: no se rechazan, se usan solo los primeros segundos (ver `secs` abajo).
    # Presupuesto total: menos que el timeout de Node para que ffmpeg nunca quede huerfano.
    budget = float(os.environ.get("CONVERT_TIMEOUT_MS", "120000")) / 1000 * 0.85
    deadline = time.monotonic() + budget
    # (fps, calidad, segundos maximos): se degrada hasta caber en 500 KB
    for fps, q, secs in ((15, 55, 6), (12, 45, 6), (10, 35, 5), (8, 25, 4), (6, 15, 3)):
        vf = (f"fps={fps},{_crop_filter(max_ratio())},"
              "scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos,"
              "format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000")
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
               "-protocol_whitelist", "file", "-i", str(src), "-map", "0:v:0", "-an", "-sn", "-dn",
               "-t", str(secs), "-vf", vf, "-c:v", "libwebp", "-lossless", "0", "-q:v", str(q),
               "-compression_level", "4", "-loop", "0", str(out)]
        remaining = deadline - time.monotonic()
        if remaining < 3:
            raise VideoError("La conversion tardo demasiado")
        try:
            subprocess.run(cmd, capture_output=True, timeout=min(90, remaining), check=True)
        except subprocess.TimeoutExpired as e:
            raise VideoError("La conversion tardo demasiado") from e
        except (subprocess.CalledProcessError, FileNotFoundError) as e:
            raise VideoError("FFmpeg no esta instalado o no pudo convertir el video") from e
        if out.exists() and out.stat().st_size <= ANIM_LIMIT:
            return
    raise VideoError("No se pudo reducir el video por debajo de 500 KB")
