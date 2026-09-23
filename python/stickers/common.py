"""Tipos y utilidades compartidas por el conversor (sin dependencias externas)."""
from __future__ import annotations

from pathlib import Path


class ConversionError(Exception):
    """Archivo rechazado o imposible de convertir. El mensaje es seguro para mostrar al usuario."""


def sniff_kind(path: Path) -> str | None:
    """Detecta el tipo REAL por firma binaria (ignora extensión y Content-Type).

    Devuelve "png" | "jpeg" | "gif" | "webp" | "video" | None.
    """
    with open(path, "rb") as f:
        head = f.read(32)
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free"):
        return "video"  # MP4 / MOV
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "video"  # WebM / Matroska (EBML)
    return None
