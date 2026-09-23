// Lógica de conversión: NO sabe nada de WhatsApp/Baileys.
// Recibe una ruta local de entrada y entrega una ruta local de salida (WebP),
// delegando el trabajo pesado al conversor Python (Pillow + FFmpeg).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_DIR = path.join(__dirname, '..', 'python');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const CONVERT_TIMEOUT_MS = Number(process.env.CONVERT_TIMEOUT_MS || 120_000);

export class ConversionError extends Error {}

/**
 * Convierte `inputPath` (imagen o video) en un sticker WebP dentro de `outDir`.
 * @returns {Promise<{path: string, animated: boolean, size: number}>}
 */
export function convertToSticker(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, ['cli.py', inputPath, outDir], { cwd: PYTHON_DIR });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new ConversionError('La conversión tardó demasiado.'));
    }, CONVERT_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ConversionError('No se pudo iniciar el conversor.'));
    });

    proc.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed;
      try {
        parsed = JSON.parse(lastLine || '');
      } catch {
        reject(new ConversionError(stderr.trim() || 'Formato no soportado.'));
        return;
      }
      if (parsed.error) {
        reject(new ConversionError(parsed.error));
        return;
      }
      resolve(parsed);
    });
  });
}
