# Prompt para Codex — Documentación y Presentación de Symphony Agent

## Instrucción

Genera dos archivos:

1. **`docs/ARCHITECTURE.md`** — Documentación técnica completa del sistema
2. **`docs/presentation.html`** — Presentación visual HTML (estilo slides, navegable con flechas) para stakeholders

## Contexto del sistema

Symphony Agent es un orquestador de agentes de IA que automatiza el ciclo de vida completo de desarrollo de software para los proyectos Narobial. Corre en un servidor Linux (95.39.37.37) como servicio systemd y gestiona múltiples repos de GitHub.

### Arquitectura general

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SYMPHONY AGENT (Orquestador)                       │
│                    /home/gcalleja/code/symphony/agent                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────┐    ┌────────────┐    ┌────────────┐    ┌───────────┐ │
│  │ fetcher  │───▶│ controller │───▶│   issuer   │───▶│  solver   │ │
│  │ (DMS API)│    │(validación)│    │(GitHub API)│    │(prioriza) │ │
│  └──────────┘    └─────┬──────┘    └────────────┘    └─────┬─────┘ │
│                         │                                     │       │
│                    ┌────▼─────┐                         ┌────▼─────┐ │
│                    │ q700-    │                         │  runner   │ │
│                    │validator │                         │(kiro-cli) │ │
│                    └────┬─────┘                         └────┬─────┘ │
│                         │                                     │       │
│                    ┌────▼──────┐                        ┌────▼─────┐ │
│                    │ notifier- │                        │knowledge-│ │
│                    │ email     │                        │base      │ │
│                    └───────────┘                        └──────────┘ │
│                                                                       │
├───────────────────── AGENTES PERIÓDICOS ─────────────────────────────┤
│                                                                       │
│  Diario 08:30    │ alerts.ts        → Email alertas proactivas       │
│  Lunes 06:00     │ changelog-gen.ts → Release notes para stakeholders│
│  Miércoles 07:40 │ docs-checker.ts  → PRs de JSDoc automático        │
│  Viernes 19:00   │ deps-checker.ts  → PRs de actualización deps      │
│  Sábado 08:00    │ auditor.ts       → Seguridad (gitleaks+npm+kiro)  │
│  Domingo 04:00   │ mutator.ts       → Mutation testing (Stryker)     │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │   AGENTE: narobial-frontend    │
              │   (kiro-cli + AGENTS.md)       │
              │                               │
              │ - Lee AGENTS.md/INSTRUCTIONS  │
              │ - Detecta perfil de testing   │
              │ - Implementa solución         │
              │ - Ejecuta tests               │
              │ - Crea PR + deploy qdevweb    │
              │ - Registra en changelog       │
              └───────────────────────────────┘
```

### Componentes del orquestador (loop principal cada 5 min)

| Módulo | Archivo | Función |
|--------|---------|---------|
| **Fetcher** | `fetcher.ts` | Extrae incidencias del DMS de Narobial (API REST con tokens) |
| **Controller** | `controller.ts` | Valida schema (zod) + valida Q700 (calidad de la incidencia) |
| **Q700 Validator** | `q700-validator.ts` | Rechaza incidencias incompletas/ambiguas/inconsistentes → notifica por email |
| **Issuer** | `issuer.ts` | Crea issues en GitHub con labels, tipo, cuerpo estructurado para el agente |
| **Solver** | `solver.ts` | Prioriza issues por señales (severidad, impacto, hotspots, complejidad) y lanza agentes |
| **Runner** | `runner.ts` | Crea rama, consulta Knowledge Base, construye prompt, ejecuta kiro-cli, despliega a qdevweb |
| **Knowledge Base** | `knowledge-base.ts` | Busca resoluciones similares en el historial de decisiones del changelog |
| **Notifier** | `notifier.ts` | Crea issues de rechazo en GitHub |
| **Notifier Email** | `notifier-email.ts` | Envía emails via SMTP relay (smtp-relay.gmail.com:465 SSL) |

### Agentes periódicos (systemd timers)

| Agente | Archivo | Timer | Qué hace |
|--------|---------|-------|----------|
| **Alertas proactivas** | `alerts.ts` | Diario 08:30 | Cobertura < 60%, módulo con ≥3 issues en 14 días, PRs sin revisión ≥48h laborables |
| **Changelog inteligente** | `changelog-generator.ts` | Lunes 06:00 | Lee CHANGELOG.md + git log, identifica autores, genera RELEASE-NOTES.md legible para stakeholders |
| **Documentación** | `docs-checker.ts` | Miércoles 07:40 | Detecta funciones/interfaces/métodos sin JSDoc en código nuevo, genera docs con kiro-cli, abre PR |
| **Dependencias** | `deps-checker.ts` | Viernes 19:00 | npm outdated + npm audit en 4 repos, ejecuta npm update + audit fix, abre PRs de actualización |
| **Auditor de seguridad** | `auditor.ts` | Sábado 08:00 | gitleaks (secrets), npm audit (CVEs critical/high), kiro-cli (XSS, CSP, sanitización, memory leaks, bugs, UI) |
| **Mutation testing** | `mutator.ts` | Domingo 04:00 | Stryker mutation testing, detecta tests débiles, abre issues con archivos y mutantes sobrevivientes |

### Agente narobial-frontend (ejecutor)

Configurado en `~/.kiro/agents/narobial-frontend.json`. Es el agente que resuelve las issues:

- Lee `AGENTS.md` e `INSTRUCTIONS.md` del repo
- Detecta perfil de testing con `npm run test:unit:profile`
- Implementa la solución siguiendo convenciones (design system nb-, traducciones, CSS variables)
- Ejecuta tests unitarios antes de commitear
- Crea PR contra hotfix-master
- Despliega automáticamente a qdevweb (Docker + nginx + SSL)
- Registra en narobial-changelog (CHANGELOG.md + decisiones/)

### Ciclo de vida completo cubierto

```
1. TOMA DE INCIDENCIAS     → fetcher.ts (DMS API cada 5 min)
2. VALIDACIÓN              → controller.ts + q700-validator.ts
3. PRIORIZACIÓN            → solver.ts (scoring por señales)
4. CONTEXTO HISTÓRICO      → knowledge-base.ts (resoluciones pasadas)
5. IMPLEMENTACIÓN          → runner.ts + narobial-frontend (kiro-cli)
6. TESTING                 → runner.ts (test:unit:staged, coverage)
7. REVISIÓN                → PR automática + deploy preview en qdevweb
8. DESPLIEGUE              → runner.ts (Docker build + push a qdevweb)
9. REGISTRO                → narobial-changelog (CHANGELOG.md + decisiones/)
10. MEJORA CONTINUA        → mutator.ts (mutation testing semanal)
11. SEGURIDAD              → auditor.ts (gitleaks + npm audit + análisis profundo)
12. DOCUMENTACIÓN          → docs-checker.ts (JSDoc automático)
13. DEPENDENCIAS           → deps-checker.ts (actualización automática)
14. ALERTAS                → alerts.ts (cobertura, hotspots, PRs estancadas)
15. RELEASE NOTES          → changelog-generator.ts (resumen para stakeholders)
```

### Repos gestionados

- `Narobial/Narobial-Frontend` (Angular 19, rama principal: hotfix-master)
- `Narobial/narobial-changelog` (registro de cambios y decisiones)
- `Narobial/narobialAdmin-Frontend` (panel de administración)
- `Narobial/narobial-docs` (documentación)

### Notificaciones

- **Email** (noreply@narobial.net → guillermo.calleja@narobial.net): rechazos Q700, alertas diarias, release notes
- **GitHub Issues**: rechazos de schema, findings de auditoría, tests débiles
- **GitHub PRs**: actualizaciones de deps, documentación JSDoc, código resuelto

### Stack técnico

- Runtime: Node.js 18 + TypeScript + tsx
- Agente IA: kiro-cli con agente narobial-frontend
- CI/CD: systemd timers (no GitHub Actions)
- Deploy: Docker + nginx + SSL en qdevweb.intraquiter
- SMTP: smtp-relay.gmail.com:465 (SSL, IP 95.39.37.37 autorizada)
- Herramientas: gitleaks 8.21.2, Stryker, gh CLI, npm audit

## Requisitos para los archivos generados

### docs/ARCHITECTURE.md

- Documentación técnica completa con diagramas mermaid
- Sección por cada componente explicando qué hace, cómo se configura, y cómo se relaciona
- Diagrama de flujo del loop principal
- Diagrama de flujo de cada agente periódico
- Sección de configuración (.env, systemd)
- Sección de troubleshooting
- Tabla resumen de todos los timers y comandos

### docs/presentation.html

- HTML autocontenido (CSS inline, sin dependencias externas)
- Estilo moderno, dark mode, tipografía limpia
- Navegable con flechas del teclado (← →) o clicks
- Slides:
  1. Portada: "Symphony Agent — Orquestador de Desarrollo Autónomo"
  2. Problema que resuelve (ciclo manual vs automatizado)
  3. Arquitectura general (diagrama visual)
  4. Loop principal (fetcher → controller → issuer → solver → runner)
  5. Validación inteligente (Q700 validator + Knowledge Base)
  6. Agente narobial-frontend (cómo resuelve issues)
  7. Agentes periódicos (calendario visual)
  8. Seguridad (gitleaks + npm audit + análisis profundo)
  9. Mejora continua (mutation testing + docs + deps)
  10. Alertas proactivas (cobertura, hotspots, PRs)
  11. Notificaciones (email + GitHub)
  12. Ciclo de vida completo (diagrama circular)
  13. Métricas / resultados (placeholder para datos reales)
  14. Próximos pasos
- Cada slide con animaciones suaves de transición
- Incluir iconos emoji como elementos visuales
- Responsive (funciona en móvil y proyector)
