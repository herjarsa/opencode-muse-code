# Fork herjarsa/opencode-muse-code — plan de fixes

Fuente: upstream swalker326/opencode-muse-code v0.1.2 (+ commit da4d811 ya en el fork).
Objetivo: fork instalable que (1) arregle issue #1, (2) arregle issue #2, (3) no choque con opencode-muse-auth.

## Conflicto detectado (2026-10-29)
- `opencode-muse-auth@0.4.0` YA está en `plugins` del opencode.jsonc global (línea 42).
- Registra el MISMO provider id `muse-code` (provider transform `editor.get('muse-code')` → update).
- Fuente de key: auth store OpenCode `muse-code` + fallback `~/.config/opencode/muse-code-sub.json`.
- Si el fork registra `muse-code` también → doble registro, orden de plugins decide quién gana. FRÁGIL.

## Decisión
- El fork registra provider id **`muse-code-sub`** (nombre "Muse Code Subscription"), NO `muse-code`.
- Lee credencial de: `ctx.options.key` → `META_API_KEY`/`MUSE_API_KEY` → `~/.config/muse/auth.json` (`providers.meta`, fix issue #1) → `~/.config/opencode/muse-code-sub.json` (cache de opencode-muse-auth, como fallback extra).
- NO escribe en el provider `muse-code` existente: si `editor.get('muse-code-sub')` no existe → `add`; si existe → `update`.
- Deja `opencode-muse-auth` intacto (sigue dueño de `muse-code`).

## Fix issue #1 (subscription flow)
- `CredentialFile = Credential & { providers?: { meta?: Credential } }`.
- `readCredential`: `parsed?.providers?.meta ?? parsed` en keychain, auth.json y secrets.json.
- `refresh`: `credential?.api_key ?? (access_token && mintApiKey)` + si hay access_token pero mint falla → `refreshWithToken()` (usa el access_token directo como bearer, TODO-1 tal cual).
- `refresh` expone `mode` para que `transform` no ponga `apiKey: undefined` en settings cuando va por token.

## Fix issue #2 (Wonder Full indistinguible)
- `toModelInfo`: `name: model.id` (TODO-2 tal cual). Mantiene `meta.name` fuera del display.

## Verificación
- `bunx tsc --noEmit` (o `npx tsc --noEmit`) en el fork con `@opencode/plugin` de devDeps.
- Prueba de carga: plugin + `opencode-muse-auth` en sandbox con `OPENCODE_CONFIG` temporal → `opencode models` lista `muse-code` y `muse-code-sub` sin errores.
- `bun test` si se añaden tests de `readCredential` (parsers puros).

## Instalación
- Solo tras push del fork: `opencode-muse-code` → entrada `github:herjarsa/opencode-muse-code` (o file: local) en `plugins` del opencode.jsonc global, con backup previo del archivo.
- Restart OpenChamber para recargar plugins.
