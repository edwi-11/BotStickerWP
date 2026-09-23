#!/usr/bin/env python3
"""CLI usada por el bot de Node/Baileys: convierte un archivo a sticker WebP y
devuelve el resultado como una linea JSON por stdout.

Uso:  python3 cli.py <archivo_entrada> <carpeta_salida>

Salida (una sola linea JSON):
  exito:  {"path": "...", "animated": true|false, "size": 12345}
  error:  {"error": "mensaje seguro para mostrar al usuario"}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from stickers.common import ConversionError
from stickers.converter import convert_to_sticker


def main() -> int:
    if len(sys.argv) != 3:
        print(json.dumps({"error": "uso: cli.py <archivo_entrada> <carpeta_salida>"}))
        return 2
    src, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        res = convert_to_sticker(src, out_dir)
    except ConversionError as e:
        print(json.dumps({"error": str(e)}))
        return 1
    except Exception as e:  # salvaguarda: nunca dejar un traceback crudo en stdout
        print(json.dumps({"error": f"Error inesperado ({type(e).__name__})"}))
        return 1
    print(json.dumps({"path": str(res.path), "animated": res.animated, "size": res.size}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
