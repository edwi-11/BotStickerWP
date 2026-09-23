# Bot de WhatsApp para crear stickers

Bot que recibe una **foto o un video por WhatsApp** y responde en el mismo chat con un
**sticker de WhatsApp** (estático o animado). No usa TikTok en ninguna parte: toda la
lógica de recepción, conversión y envío ocurre dentro de WhatsApp.

```
Usuario
   ↓ envía FOTO o VIDEO
Bot de WhatsApp (Baileys)
   ↓ descarga el archivo
Conversor (Pillow / FFmpeg)
   ↓ genera WebP compatible con WhatsApp
Bot responde con el STICKER en el mismo chat
```

## Arquitectura

- **`index.js` + `src/`** (Node.js): todo lo relacionado con WhatsApp usando
  [Baileys](https://github.com/WhiskeySockets/Baileys) — conexión por QR o código de
  vinculación, sesión persistida en disco, reconexión automática, recepción de mensajes,
  descarga de multimedia y envío del sticker resultante.
- **`python/`**: el conversor, aislado de WhatsApp. Recibe un archivo local y entrega un
  WebP de sticker. Node lo invoca como subproceso (`python/cli.py`) y se comunica con él
  por JSON — así la lógica de conversión se puede probar y reutilizar sola.

La lógica de WhatsApp nunca importa el conversor directamente ni al revés: solo se
comunican por archivos en disco y una línea de JSON.

## Imágenes

Acepta JPG, JPEG, PNG, WEBP y GIF (animado o no). El proceso:
- Recorta lo que sobra para que el sticker quede casi cuadrado: una imagen ya cuadrada no se
  toca y una muy alargada (panorámica, captura de pantalla) se recorta lo justo. En fotos
  verticales se conserva más la parte de arriba (donde suelen estar las caras). El grado de
  recorte se controla con `STICKER_MAX_RATIO` (ver más abajo).
- Redimensiona sin deformar (`ImageOps.contain`).
- Centra el resultado en un lienzo cuadrado de 512×512, conservando transparencia.
- Genera WebP y comprime en pasos hasta cumplir los límites de WhatsApp
  (100 KB estático / 500 KB animado).

## Videos

Acepta MP4, MOV y WebM. El proceso:
- Verifica duración y resolución con `ffprobe` antes de convertir.
- Si el video dura más de 60 s o pesa más de lo permitido, el bot responde explicando
  cuál es el problema (no lo intenta igual).
- Aplica el mismo recorte casi cuadrado que a las imágenes.
- Convierte con FFmpeg a WebP animado 512×512, bajando FPS/calidad en pasos hasta caber
  en 500 KB.

## Enlaces

Si el mensaje es **solo un enlace** (o `/sticker <enlace>`), el bot lo abre y convierte su contenido:

- **Enlace directo** a una imagen, GIF o video (`.jpg`, `.png`, `.webp`, `.gif`, `.mp4`...): lo descarga y lo convierte.
- **Enlace a una página web** (Imgur, Pinterest, una noticia, una tienda...): usa el video o la imagen de su
  vista previa (`og:video`, `og:image`, `twitter:image`). Si el video es un reproductor incrustado, cae a la imagen.
- Un enlace dentro de una frase se ignora, para no responder a cualquier conversación.
- No descarga videos de redes sociales (TikTok, Instagram, YouTube...): esas plataformas exigen herramientas
  específicas y cambian a menudo.

Como cualquiera puede mandar un enlace, `src/linkfetch.js` se protege contra **SSRF** (que alguien haga que el bot
abra `localhost` o tu red interna): solo `http`/`https`, puertos 80/443, sin usuario/contraseña en la URL, y cada
salto (también las redirecciones) se resuelve por DNS y se rechaza si apunta a una IP privada o local; la conexión
se fija a la IP ya validada (evita *DNS rebinding*). Además hay límites de tamaño (`MAX_DOWNLOAD_MB`), de
redirecciones (5) y de tiempo (`LINK_TIMEOUT_MS`), y aplica el mismo límite por minuto que los archivos.

## Comandos

```
/menu             - Muestra la ayuda
/status           - Ver el estado de la conexión de WhatsApp
/sticker <enlace> - Igual que enviar solo el enlace
```

## Requisitos

- Node.js ≥ 20
- Python ≥ 3.10 con Pillow
- FFmpeg (con `ffprobe`) instalado en el sistema

## Instalación local

```bash
npm install
pip install -r python/requirements.txt
cp .env.example .env   # ajusta las variables si quieres código de vinculación en vez de QR
node index.js
```

Al arrancar por primera vez se imprime un **código QR** en la terminal
(WhatsApp > Dispositivos vinculados > Vincular un dispositivo). Si defines
`WA_PAIRING_NUMBER` en `.env`, en su lugar se genera un **código de vinculación** para
ingresar manualmente. La sesión queda guardada en `WA_AUTH_DIR` (por defecto `./auth`),
así que los siguientes arranques se reconectan solos.

## Variables de entorno

Ver `.env.example`. Las más relevantes:

| Variable | Descripción |
|---|---|
| `WA_PAIRING_NUMBER` | Número (sin `+`) para vincular por código en vez de QR |
| `WA_AUTH_DIR` | Carpeta donde se guarda la sesión de WhatsApp |
| `MAX_DOWNLOAD_MB` | Tamaño máximo de imagen/video aceptado |
| `RATE_LIMIT_PER_MIN` | Archivos máximos por minuto por chat |
| `STICKER_MAX_RATIO` | Cuánto puede alargarse el sticker (lado largo / lado corto). `1` = cuadrado exacto, `1.2` = casi cuadrado (por defecto), `99` = sin recortar |
| `BAILEYS_LOG_LEVEL` | Nivel de log de Baileys (`warn` por defecto; `debug` para diagnosticar) |
| `LINK_TIMEOUT_MS` | Tiempo máximo para descargar el contenido de un enlace (20000 por defecto) |
| `PYTHON_BIN` | Binario de Python a invocar (`python3` por defecto) |

## Docker

```bash
docker compose up -d --build
docker compose attach bot   # para ver el QR / código de vinculación la primera vez
```

La sesión de WhatsApp se persiste en el volumen `wa_auth`.

## Pruebas

El conversor y el descargador de enlaces se pueden probar de forma aislada, sin WhatsApp:

```bash
cd python && pip install pytest -r requirements.txt
pytest ../tests          # conversor de stickers (Python)
cd .. && npm test        # descarga de enlaces y protección SSRF (Node)
```

## Solución de problemas

**El bot registra "enviado correctamente" pero en WhatsApp no llega nada.** WhatsApp direcciona
ahora por LID (`@lid`) y Baileys 6.x no lo maneja bien (sesiones de cifrado duplicadas). Usa
Baileys 7.x (`npm install @whiskeysockets/baileys@latest`), borra la carpeta `auth/`, cierra la
sesión vieja en el teléfono (Dispositivos vinculados) y vincula de nuevo. Con
`BAILEYS_LOG_LEVEL=warn` (por defecto) verás en consola errores como `Bad MAC` o `No session record`.
Prueba siempre escribiendo desde **otro número**, no desde el teléfono al que está vinculado el bot.

## Notas de seguridad

- Baileys es un cliente **no oficial** de WhatsApp Web; úsalo bajo tu propio riesgo y
  respetando los términos de servicio de WhatsApp.
- No se guarda ningún archivo multimedia: cada trabajo usa una carpeta temporal que se
  borra siempre al terminar (éxito o error).
- Los comandos `/menu` y `/status` responden a cualquiera que escriba en el chat; si
  quieres restringirlos a ciertos números, es fácil añadir una lista blanca en
  `src/handlers.js`.
