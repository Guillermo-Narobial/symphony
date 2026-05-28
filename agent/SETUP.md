# Configuración pendiente

## 1. Instalar dependencias

```bash
cd agent && npm install
```

## 2. Autenticar gh CLI

```bash
gh auth login
```

Sigue el flujo interactivo. El agente usa `gh` para crear issues, así que necesita una sesión activa.

## 3. Crear label "rechazada" en el repo

```bash
gh label create rechazada --repo owner/repo --color D93F0B --description "Tarea rechazada por el agente"
```

## 4. Configurar variables de entorno

Copia `.env.example` a `.env` y rellena:

```bash
cp .env.example .env
```

| Variable | Descripción | Ejemplo |
|---|---|---|
| `BACKEND_URL` | URL del endpoint que devuelve tareas | `https://api.ejemplo.com/tasks` |
| `GITHUB_REPO` | Repositorio destino en formato `owner/repo` | `Guillermo-Narobial/mi-proyecto` |
| `REJECT_ASSIGNEE` | Usuario GitHub para notificar rechazos | `Guillermo-Narobial` |
| `CRON_SCHEDULE` | Frecuencia de polling (cron) | `*/5 * * * *` |

## 5. Definir el schema de la tarea

Edita `src/schema.ts` para que coincida con el formato real de tu backend. Actualmente espera:

```json
{
  "id": "string | number",
  "title": "string (obligatorio)",
  "description": "string (obligatorio)",
  "labels": ["string"] // opcional
}
```

## 6. Cargar .env al ejecutar

Usa un loader como `--env-file` (Node 20.6+):

```bash
node --env-file=.env dist/index.js
```

O en desarrollo:

```bash
node --env-file=.env --import=tsx src/index.ts
```

## 7. Ejecutar

```bash
# Desarrollo
npm run dev

# Producción
npm run build && npm start
```
