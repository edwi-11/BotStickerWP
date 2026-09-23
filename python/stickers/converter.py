"""Modulo independiente: cualquier archivo soportado -> sticker WebP de WhatsApp.

No sabe nada de WhatsApp ni de Baileys: solo recibe una ruta local de entrada
y entrega una ruta local de salida (WebP). Lo invoca `cli.py`.
"""
from __future__ import annotations

import stat
import uuid
from dataclasses import dataclass
from pathlib import Path

from .common import ConversionError, sniff_kind
from .image import ImageError, convert_image
from .video import VideoError, convert_video


@dataclass
class StickerResult:
    path: Path
    animated: bool
    size: int


DEFAULT_MAX_INPUT_BYTES = 20 * 1024 * 1024


def _validate_input(src: Path, max_bytes: int) -> None:
    """Primer paso: el archivo existe, es un archivo normal, no esta vacio ni es enorme."""
    try:
        st = src.stat()
    except OSError as e:
        raise ConversionError("Archivo no encontrado.") from e
    if not stat.S_ISREG(st.st_mode):
        raise ConversionError("Archivo no encontrado.")
    if st.st_size == 0:
        raise ConversionError("El archivo esta vacio.")
    if st.st_size > max_bytes:
        raise ConversionError("Archivo demasiado grande.")


def convert_to_sticker(src: Path, out_dir: Path, max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES) -> StickerResult:
    """input multimedia -> validacion -> deteccion de tipo -> conversion -> WebP de sticker."""
    _validate_input(src, max_input_bytes)
    try:
        kind = sniff_kind(src)
    except OSError as e:
        raise ConversionError("No se pudo leer el archivo.") from e
    if kind is None:
        raise ConversionError("Formato no soportado (solo PNG, JPG, WebP, GIF, MP4, MOV o WebM).")
    out = out_dir / f"{uuid.uuid4().hex}.webp"
    try:
        if kind == "video":
            convert_video(src, out)
            animated = True
        else:
            animated = convert_image(src, out)
    except (ImageError, VideoError) as e:
        out.unlink(missing_ok=True)
        raise ConversionError(str(e)) from e
    return StickerResult(path=out, animated=animated, size=out.stat().st_size)
