"""Pruebas del conversor de stickers (independientes de WhatsApp/Node).

Ejecutar desde python/:  pip install pytest -r requirements.txt && pytest ../tests
"""
import io
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from stickers.common import ConversionError, sniff_kind  # noqa: E402
from stickers.converter import convert_to_sticker  # noqa: E402


def _make_png(path: Path, size=(800, 400)) -> None:
    im = Image.new("RGBA", size, (255, 0, 0, 255))
    im.save(path, "PNG")


def test_sniff_kind_png(tmp_path: Path):
    png = tmp_path / "a.png"
    _make_png(png)
    assert sniff_kind(png) == "png"


def test_convert_static_image_to_webp_sticker(tmp_path: Path):
    src = tmp_path / "in.png"
    _make_png(src)
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    res = convert_to_sticker(src, out_dir)

    assert res.path.exists()
    assert res.path.suffix == ".webp"
    assert res.animated is False
    assert res.size <= 100 * 1024  # límite de sticker estático de WhatsApp
    with Image.open(res.path) as im:
        assert im.size == (512, 512)


def test_rejects_unsupported_format(tmp_path: Path):
    src = tmp_path / "in.txt"
    src.write_text("no es una imagen")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    with pytest.raises(ConversionError):
        convert_to_sticker(src, out_dir)


def test_rejects_empty_file(tmp_path: Path):
    src = tmp_path / "empty.png"
    src.touch()
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    with pytest.raises(ConversionError):
        convert_to_sticker(src, out_dir)


def _content_size(webp: Path) -> tuple[int, int]:
    """Tamano del contenido visible (sin la transparencia de relleno) de un sticker."""
    with Image.open(webp) as im:
        bbox = im.convert("RGBA").getchannel("A").getbbox()
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def _convert(tmp_path: Path, size: tuple[int, int]) -> Path:
    src = tmp_path / "in.png"
    _make_png(src, size=size)
    out_dir = tmp_path / "out"
    out_dir.mkdir(exist_ok=True)
    return convert_to_sticker(src, out_dir).path


def test_wide_image_is_cropped_to_near_square(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("STICKER_MAX_RATIO", raising=False)
    w, h = _content_size(_convert(tmp_path, (1920, 600)))  # panoramica 3.2:1
    assert max(w, h) / min(w, h) <= 1.25


def test_tall_image_is_cropped_to_near_square(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("STICKER_MAX_RATIO", raising=False)
    w, h = _content_size(_convert(tmp_path, (600, 1920)))
    assert max(w, h) / min(w, h) <= 1.25


def test_square_image_is_not_cropped(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("STICKER_MAX_RATIO", raising=False)
    assert _content_size(_convert(tmp_path, (900, 900))) == (512, 512)


def test_ratio_one_gives_exact_square(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STICKER_MAX_RATIO", "1")
    assert _content_size(_convert(tmp_path, (1200, 800))) == (512, 512)


def test_large_ratio_keeps_old_behavior(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STICKER_MAX_RATIO", "99")
    w, h = _content_size(_convert(tmp_path, (1200, 800)))
    assert (w, h) == (512, 341)  # sin recorte: franjas transparentes


def test_invalid_ratio_falls_back_to_default(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("STICKER_MAX_RATIO", "abc")
    w, h = _content_size(_convert(tmp_path, (1920, 600)))
    assert max(w, h) / min(w, h) <= 1.25
