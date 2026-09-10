# ADR-0003: Comando /generar de escaneo de code smells

- Estado: Aceptado
- Fecha: 2026-09-10
- Responsable: Narobial Engineering

## Contexto

El bot de Telegram de Symphony ya orquesta issues, PRs y sesiones de agente
(`/chat`) sobre Narobial-Frontend. Faltaba una vía para auditar de forma
proactiva la calidad del código de Angular y convertir cada hallazgo en trabajo
accionable (issues) sin intervención manual.

## Decisión

Se añade el módulo `src/code-scanner.ts` y el comando `/generar` (alias `/q700`,
`/scan`) en `src/telegram-bot.ts`.

- El escaneo prepara un workspace aislado (`scan-workspace`) sobre la rama
  `hotfix-master` y lanza kiro-cli (con fallback a codex) durante una ventana
  acotada (~10 min por defecto, configurable 1–30 min).
- El agente actúa en modo solo-lectura: detecta code smells de Angular
  (JSON.parse sin try/catch, tipado ausente, falta de optional chaining,
  suscripciones no liberadas, errores HTTP sin controlar, subscribes anidados,
  Change Detection/OnPush, mutación de estado compartido, `@for`/`*ngFor` sin
  track, funciones pesadas en template, lifecycle hooks, dependencias
  circulares, routing sin cancelar peticiones, formularios reactivos frágiles,
  guards/interceptors mal usados, etc.) y escribe un hallazgo por línea en
  `FINDINGS.jsonl`. No commitea, no pushea, no cambia de rama, no modifica
  código del proyecto.
- El módulo parsea los hallazgos de forma tolerante, deduplica localmente y
  contra GitHub mediante un marcador oculto `<!-- scan-fingerprint: ... -->`, y
  crea una issue por hallazgo con `gh issue create` (labels `code-smell`,
  `ai-generated`, `calidad`, `smell:<categoria>`, `severidad:<nivel>`).
- Se limita el número de issues por ejecución con
  `SCAN_MAX_ISSUES_PER_RUN` (por defecto 40) para evitar ruido.
- El comando corre en background con status cada 60s y un resumen final; solo se
  permite un escaneo simultáneo.

## Consecuencias

El equipo puede lanzar auditorías bajo demanda desde Telegram y recibir issues
trazables por hallazgo, con dedupe para no duplicar trabajo. El coste está
acotado por la ventana temporal y por el tope de issues. No se introducen
dependencias nuevas (se reutiliza `agent-executor`, `config` y patrones de
`chat-agent` e `issuer`).

## Reversión

Retirar el comando `/generar` y sus alias del dispatcher y del menú, y eliminar
`src/code-scanner.ts`. Las issues ya creadas permanecen en GitHub y se gestionan
manualmente.
