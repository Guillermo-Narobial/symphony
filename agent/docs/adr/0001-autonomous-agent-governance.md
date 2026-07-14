# ADR-0001: Gobernanza de automatización autónoma

- Estado: Aceptado
- Fecha: 2026-07-14
- Responsable: Narobial Engineering

## Contexto

Los agentes crean PRs, ejecutan pruebas y despliegan previews. Sin límites explícitos podían competir por Git, recursos y entornos temporales.

## Decisión

- Un solo agente funcional concurrente.
- Despliegues automáticos solo con pruebas verdes y sin rutas sensibles, salvo `deploy:approved`.
- Previews con caducidad de siete días y limpieza semanal.
- Escritores Git serializados con `flock`.
- Cambios de arquitectura o automatización requieren ADR breve.

## Consecuencias

Menos paralelismo, pero mayor trazabilidad, menor riesgo operativo y revisiones más predecibles.

## Reversión

Cambiar esta decisión mediante un ADR posterior y actualizar los guards, timers y documentación afectados.
