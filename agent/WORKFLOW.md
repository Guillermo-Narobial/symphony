---
tracker:
  kind: linear
  project_slug: "narobial-frontend"
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Cancelled
polling:
  interval_ms: 30000
workspace:
  root: ~/code/symphony-workspaces
hooks:
  after_create: |
    git clone --depth 1 https://github.com/Narobial/Narobial-Frontend .
    git fetch origin hotfix-master release
agent:
  max_concurrent_agents: 2
  max_turns: 30
codex:
  command: codex --config shell_environment_policy.inherit=all app-server
  approval_policy: never
  thread_sandbox: workspace-write
---

You are working on issue `{{ issue.identifier }}`

{% if attempt %}
This is retry attempt #{{ attempt }}. Resume from current workspace state.
{% endif %}

Issue context:
- Identifier: {{ issue.identifier }}
- Title: {{ issue.title }}
- Status: {{ issue.state }}
- Labels: {{ issue.labels }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Project: Narobial Frontend (Angular)

This is an Angular project with two active branches:
- `hotfix-master` — Angular 15 legacy (for bugfixes/incidents)
- `release` — Angular 19 modern (for features/projects)

## Instructions

1. Read `AGENTS.md` and `INSTRUCTIONS.md` in the repo root — they contain mandatory rules.
2. Detect the branch profile with `npm run test:unit:profile`.
3. Determine if this is a bugfix (base: `hotfix-master`) or feature (base: `release`).
4. Create a branch: `hotfix/<issue-number>-<short-slug>` or `feature/<issue-number>-<short-slug>`.
5. Implement the solution following project conventions (SCSS, i18n, standalone components, etc.).
6. Run related tests: `npm run test:unit:staged`.
7. Commit using format: `tipo(contexto): Descripción en español`.
8. Run `npm run i18n:sync` if you touched translations.
9. Push: `git push -u origin <branch>`.
10. Create PR: `gh pr create --base <base-branch> --assignee Guillermo-Narobial --title "<branch-name>" --body "Resuelve #<issue-number>"`.
11. Add label `en-revision` to the issue.
12. If Codex hits a limit, classify it before retrying: account/time quota (`You've hit your usage limit`, `try again at <time>`, `limits reset`, `rate limit`, `quota`, `credits`) means stop all reattempts, preserve the workspace, and resume only after the stated reset time; session/tab/context limit (`session limit`, `tab limit`, `conversation limit`, `context window`, `maximum context`, `start a new session`) means write `CODEX_HANDOFF.md` in the repo root with objective, branch/issue, git status, completed work, changed files, tests, blockers, pending tasks and a continuation prompt, then end the current session and resume from that file in a fresh Codex session without resetting or discarding changes.

## Commit format

```
tipo(contexto): Descripción en español
```

Types: fix, feat, docs, style, refactor, build.

## Sincronización obligatoria antes de cambios

Antes de crear o modificar una rama de trabajo:

1. Actualiza la rama base con `git fetch origin` y `git pull --ff-only` (o rebasea la rama sobre la base actualizada).
2. Comprueba `git status --short` y resuelve o aparta cualquier cambio local antes de continuar.
3. Justo antes de commit/push, vuelve a traer la base y rebasea si ha avanzado.
4. No abras una PR desde una rama que esté detrás de su base; verifica el estado de merge en GitHub.

## Quality bar before PR

- Tests pass for changed files.
- i18n synced if translations touched.
- No hardcoded colors (use `var(--nb-color-...)`).
- No hardcoded spacing (use `var(--nb-spacing-XX)`).
- Security: no secrets, no innerHTML, validate inputs.
- Standalone components with lazy loading.
