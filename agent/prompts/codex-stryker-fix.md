# Prompt para Codex: Arreglar mutation testing con @stryker-mutator/core + Vitest

## Contexto

Tenemos un proyecto Angular 19 con Vitest como test runner. Actualmente usamos un **script custom** (`src/mutator.ts`) que hace mutation testing "a mano": genera mutaciones con regex, modifica archivos, ejecuta `vitest run` por cada mutante, y restaura. Es extremadamente lento (3h+ para 72 archivos, 20 mutantes/archivo).

Queremos migrar a usar `@stryker-mutator/core` con `@stryker-mutator/vitest-runner` correctamente, que ya están instalados pero no se usan.

## Archivos relevantes

### `stryker.config.json` (ya existe)
```json
{
  "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker/master/packages/core/schema/stryker-core.json",
  "testRunner": "vitest",
  "vitest": { "configFile": "vitest.stryker.config.ts" },
  "checkers": [],
  "mutate": [
    "src/app/**/*.service.ts",
    "src/app/**/*.utils.ts",
    "src/app/**/*.pipe.ts",
    "src/app/**/*.interceptor.ts",
    "src/app/**/*.helpers.ts",
    "!src/app/**/*.spec.ts",
    "!src/app/**/video.component.ts"
  ],
  "reporters": ["progress", "json"],
  "jsonReporter": { "fileName": "reports/mutation/mutation.json" },
  "incremental": true,
  "concurrency": 2,
  "timeoutMS": 30000,
  "thresholds": { "high": 80, "low": 60, "break": null }
}
```

### `vitest.stryker.config.ts` (ya existe)
```typescript
import { defineConfig } from 'vite';
import angular from '@analogjs/vite-plugin-angular';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [angular()],
  resolve: {
    alias: {
      src: resolve(__dirname, 'src'),
      '@app': resolve(__dirname, 'src/app'),
      '@directives': resolve(__dirname, 'src/app/directives'),
    },
    mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
  },
  test: {
    globals: true,
    clearMocks: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    exclude: [
      '**/masters.component.spec.ts',
      '**/customer.component.spec.ts',
      '**/offer-data.component.spec.ts',
      '**/person.component.spec.ts',
      '**/new-appraisal.component.spec.ts',
      '**/deliveryModal.component.spec.ts',
    ],
    server: {
      deps: {
        inline: [/.*/],
      },
    },
  },
});
```

### Dependencias instaladas
```
"@stryker-mutator/core": "^9.5.0",
"@stryker-mutator/typescript-checker": "^8.7.1",
"@stryker-mutator/vitest-runner": "^9.5.0",
```

## Problemas conocidos que debes resolver

1. **Incompatibilidad de versiones**: `@stryker-mutator/typescript-checker` es v8 pero core es v9. Hay que actualizar el checker a v9 o eliminarlo (ya está en `"checkers": []`).

2. **`globals: true` en vitest config**: El vitest-runner de Stryker v9 tiene problemas con `globals: true`. Puede causar que `describe`/`it`/`expect` no estén disponibles en el contexto del worker de Stryker. Solución: añadir `globals: true` explícitamente o verificar que el setupFile lo maneja.

3. **`@analogjs/vite-plugin-angular` cachea compilaciones**: Stryker modifica archivos .ts y espera que Vitest recompile. El plugin de Angular puede servir versiones cacheadas. Solución: desactivar cache de Vite para Stryker o usar `server.deps.inline: [/.*/]` (ya está).

4. **Timeout**: Con Angular components pesados, 30s puede no ser suficiente para la primera compilación. Considerar `timeoutMS: 60000` para el dry-run inicial.

5. **Concurrency**: Con `concurrency: 2` y el overhead de compilación Angular, puede haber contención de recursos. Probar con `concurrency: 1` primero para verificar que funciona.

## Tarea

1. Haz que `npx stryker run` funcione correctamente en el directorio del proyecto (`repos/Narobial-Frontend/`).

2. Si `@stryker-mutator/typescript-checker` v8 da problemas con core v9, elimínalo del package.json (ya no está en `checkers: []`).

3. Ajusta `stryker.config.json` si es necesario para que sea compatible con el vitest-runner.

4. Crea un script npm `"test:mutation": "stryker run"` en package.json.

5. Si hay errores de compilación o de runner, documéntalos en un archivo `STRYKER-ISSUES.md` con la solución aplicada.

## Criterio de éxito

- `npx stryker run` ejecuta al menos un ciclo completo de mutación sin crashear.
- Genera `reports/mutation/mutation.json` con resultados.
- El tiempo total es razonable (< 30 min para el subset de archivos configurado).

## Comandos útiles para debug

```bash
# Ejecutar stryker con más verbosidad
npx stryker run --logLevel debug

# Verificar que vitest funciona solo
npx vitest run --config vitest.stryker.config.ts

# Ver qué archivos matchea el glob de mutate
npx stryker run --dryRunOnly
```
