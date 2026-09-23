"""Imagenes (PNG/JPG/WebP/GIF/APNG) -> WebP de sticker 512x512 con Pillow.

La imagen se recorta para que quede casi cuadrada (ver STICKER_MAX_RATIO)."""
from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

SIZE = 512
STATIC_LIMIT = 100 * 1024   # limite WhatsApp sticker estatico
ANIM_LIMIT = 500 * 1024     # limite WhatsApp sticker animado
MAX_PIXELS = 25_000_000
MAX_ANIM_MS = 10_000
MAX_ANIM_FRAMES = 120

# Relacion de aspecto maxima (lado largo / lado corto) que se conserva antes de
# encajar la imagen en el lienzo de 512x512. Lo que sobra se recorta:
#   1.0  -> siempre cuadrado exacto (recorta todo lo que sobre)
#   1.2  -> (por defecto) casi cuadrado; las imagenes ya cuadradas no se tocan
#   99   -> no recorta nunca (comportamiento antiguo: franjas transparentes)
DEFAULT_MAX_RATIO = 1.2
# En fotos verticales se conserva mas la parte de arriba (donde suelen estar las caras).
TOP_BIAS = 0.3


class ImageError(Exception):
    pass


def max_ratio() -> float:
    """Lee STICKER_MAX_RATIO del entorno (>= 1.0). Valores invalidos -> por defecto."""
    try:
        value = float(os.environ.get("STICKER_MAX_RATIO", DEFAULT_MAX_RATIO))
    except ValueError:
        return DEFAULT_MAX_RATIO
    return max(1.0, value)


def _crop_to_ratio(frame: Image.Image, ratio: float) -> Image.Image:
    """Recorta el sobrante para que lado_largo/lado_corto no pase de `ratio`.

    Una imagen ya cuadrada (o casi) no se recorta; una muy alargada se recorta lo
    justo. Asi el sticker ocupa casi todo el lienzo en vez de quedar como una franja.
    """
    w, h = frame.size
    if w >= h:
        if w / h <= ratio:
            return frame
        new_w = max(1, round(h * ratio))
        left = (w - new_w) // 2
        return frame.crop((left, 0, left + new_w, h))
    if h / w <= ratio:
        return frame
    new_h = max(1, round(w * ratio))
    top = round((h - new_h) * TOP_BIAS)
    return frame.crop((0, top, w, top + new_h))


def _fit(frame: Image.Image) -> Image.Image:
    """Recorta el sobrante, redimensiona sin deformar y centra en un lienzo 512x512."""
    frame = _crop_to_ratio(frame.convert("RGBA"), max_ratio())
    frame = ImageOps.contain(frame, (SIZE, SIZE), Image.LANCZOS)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(frame, ((SIZE - frame.width) // 2, (SIZE - frame.height) // 2))
    return canvas


def convert_image(src: Path, out: Path) -> bool:
    """Convierte y devuelve True si el resultado es animado."""
    try:
        im = Image.open(src)
        if im.width * im.height > MAX_PIXELS:
            raise ImageError("Imagen demasiado grande")
        n = getattr(im, "n_frames", 1)
        if n > 1:
            _animated(im, n, out)
            return True
        im = ImageOps.exif_transpose(im) or im
        _static(im, out)
        return False
    except ImageError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError) as e:
        raise ImageError(f"Imagen invalida o danada ({type(e).__name__})") from e


def _static(im: Image.Image, out: Path) -> None:
    fitted = _fit(im)
    fitted.save(out, "WEBP", lossless=True, method=6)
    if out.stat().st_size <= STATIC_LIMIT:
        return
    for q in (90, 80, 70, 60, 50, 40, 30, 20):
        fitted.save(out, "WEBP", quality=q, method=6, exact=True)
        if out.stat().st_size <= STATIC_LIMIT:
            return
    raise ImageError("No se pudo reducir el sticker por debajo de 100 KB")


def _animated(im: Image.Image, n: int, out: Path) -> None:
    durs: list[int] = []
    total = 0
    for i in range(min(n, 600)):
        im.seek(i)
        d = max(int(im.info.get("duration", 100) or 100), 20)
        if total + d > MAX_ANIM_MS and durs:
            break
        durs.append(d)
        total += d
    keep = len(durs)
    base = max(1, math.ceil(keep / MAX_ANIM_FRAMES))
    for quality, mult in ((70, 1), (60, 1), (50, 2), (40, 2), (30, 3), (20, 4)):
        step = base * mult
        idx = list(range(0, keep, step))
        frames, fd = [], []
        for i in idx:
            im.seek(i)
            frames.append(_fit(im))
            fd.append(sum(durs[i : i + step]))
        frames[0].save(
            out, "WEBP", save_all=True, append_images=frames[1:], duration=fd, loop=0,
            quality=quality, method=4, exact=True,
        )
        if out.stat().st_size <= ANIM_LIMIT:
            return
    raise ImageError("No se pudo reducir el sticker animado por debajo de 500 KB")
