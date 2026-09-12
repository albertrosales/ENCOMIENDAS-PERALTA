# Bot de Telegram + Base44 + Render

Este proyecto permite consultar una encomienda de Base44 desde Telegram usando el número de guía.

## Flujo

Telegram → Render → Base44 → Telegram

El bot trabaja en modo **solo lectura**: consulta `Encomienda` y `Entrega`. No crea, actualiza ni elimina registros.

## 1. Seguridad primero

Si alguna API key de Base44 apareció en una captura o mensaje compartido, **revócala/regénérala antes de usar este proyecto**.

No subas `.env` a GitHub.

## 2. Crear el bot de Telegram

En Telegram crea un bot con BotFather y guarda el token.

No publiques ese token.

## 3. Subir este proyecto a GitHub

Sube todos los archivos excepto `.env`.

GitHub debe contener, como mínimo:

- `server.js`
- `package.json`
- `.gitignore`
- `.env.example`
- `README.md`

## 4. Crear el Web Service en Render

En Render:

1. New → Web Service
2. Conecta tu repositorio de GitHub
3. Runtime: Node
4. Build Command: `npm install`
5. Start Command: `npm start`

Agrega estas variables de entorno:

```env
BASE44_APP_ID=TU_APP_ID
BASE44_API_KEY=TU_API_KEY_NUEVA
TELEGRAM_BOT_TOKEN=TU_TOKEN
PUBLIC_URL=https://NOMBRE-DE-TU-SERVICIO.onrender.com
ALLOWED_TELEGRAM_IDS=123456789
```

Render normalmente asigna `PORT` automáticamente; no hace falta definirlo.

## 5. Cómo obtener tu Telegram ID

Arranca el bot temporalmente con `ALLOWED_TELEGRAM_IDS` vacío.

Escribe `/start` al bot. Si quieres restringirlo desde el principio, puedes usar un bot confiable de identificación o revisar los logs del update, pero la opción más segura es agregar temporalmente una salida de logging local y retirarla después.

Una vez conozcas tu ID, ponlo en:

```env
ALLOWED_TELEGRAM_IDS=123456789
```

Para varios usuarios:

```env
ALLOWED_TELEGRAM_IDS=123456789,987654321
```

Si queda vacío, cualquiera que encuentre el bot podrá consultar.

## 6. Uso

En Telegram:

```text
/start
```

Después:

```text
EP-20260903-E5F6
```

o:

```text
/buscar EP-20260903-E5F6
```

## 7. Entidades usadas

### Encomienda

El proyecto espera estos campos:

- `numero_guia`
- `destinatario`
- `destino`
- `tipo_paquete`
- `peso`
- `precio`
- `fecha`
- `estado`
- `forma_pago`
- `estado_pago`
- `tipo_entrega`
- `observaciones`
- `id`

### Entrega

- `encomienda_id`
- `fecha_hora`
- `persona_recibe`
- `observaciones`

La relación usada es:

```text
Encomienda.id = Entrega.encomienda_id
```

## 8. Compatibilidad del SDK

El código intenta tres formas de consultar Base44:

1. `Entity.filter({...})`
2. `Entity.list({ q: {...} })`
3. `Entity.list()` + filtro local

Esto permite tolerar diferencias entre versiones del SDK de Base44.

Para bases con muchísimos registros conviene confirmar el método de filtro soportado por tu versión y eliminar el fallback de `list()`.

## 9. Health check

Abre:

```text
https://TU-SERVICIO.onrender.com/health
```

Debe responder:

```json
{"ok":true}
```

## Próxima fase

Cuando esta búsqueda por guía funcione, se puede añadir:

- búsqueda por foto/OCR
- nombre del remitente desde `remitente_id`
- nombre de sucursal desde `origen_id`
- botones de Telegram
- cambio de estado con permisos
