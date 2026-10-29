import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Model, Plugin, Provider } from "@opencode/plugin"

const PROVIDER_ID = "muse-code-sub"
const PROVIDER_NAME = "Muse Code Subscription"
const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"
const API_ORIGIN = "https://api.meta.ai"
const API_BASE = `${API_ORIGIN}/v1`
const KEYCHAIN_SERVICE = "ai.meta.dev.credentials"
const KEYCHAIN_ACCOUNT = "meta"
const REFRESH_MS = 30 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 10_000

type Credential = { api_key?: string; access_token?: string }
type CredentialFile = Credential & { providers?: { meta?: Credential } }

type MuseVariant = { reasoningEffort?: string }

type MuseModel = {
  readonly id: string
  readonly created?: number
  readonly metadata?: {
    readonly "muse-code"?: {
      readonly name?: string
      readonly is_hidden?: boolean
      readonly tool_call?: boolean
      readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] }
      readonly limit?: { readonly context?: number; readonly output?: number }
      readonly options?: { readonly reasoningEffort?: string }
      readonly variants?: Readonly<Record<string, MuseVariant>>
    }
  }
}

// The plugin host context is newer than the installed @opencode-ai/plugin
// types, so the provider domain is described locally.
type ProviderEditor = {
  get(providerID: string): unknown
  add(input: { info: Provider.Info; models: readonly Model.Info[] }): void
  update(providerID: string, update: (provider: Record<string, unknown>) => void): void
  models: { set(providerID: string, models: readonly Model.Info[]): void }
}

type ProviderDomain = {
  transform(callback: (editor: ProviderEditor) => void): Promise<{ dispose: () => Promise<void> }>
  reload(): Promise<void>
}

const FALLBACK_CATALOG: readonly MuseModel[] = [
  {
    id: "muse-spark-1.3",
    metadata: {
      "muse-code": {
        name: "Muse Spark 1.3",
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 1_007_997, output: 128_000 },
        options: { reasoningEffort: "high" },
        variants: {
          minimal: { reasoningEffort: "minimal" },
          low: { reasoningEffort: "low" },
          medium: { reasoningEffort: "medium" },
          high: { reasoningEffort: "high" },
          xhigh: { reasoningEffort: "xhigh" },
          max: { reasoningEffort: "max" },
        },
      },
    },
  },
]

function run(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8", timeout: REQUEST_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

function parseJson<T>(value: string | undefined): T | undefined {
  if (!value) return undefined
  try {
    return JSON.parse(value) as T
  } catch {
    return undefined
  }
}

// The muse CLI keeps its login in the operating system credential store. On
// macOS that is the login keychain; on other platforms fall back to the files
// the CLI may write, and to the environment variables it understands.
async function readCredential(override: string | undefined): Promise<Credential | undefined> {
  if (override) return { api_key: override }

  const fromEnv = process.env.META_API_KEY ?? process.env.MUSE_API_KEY
  if (fromEnv) return { api_key: fromEnv }

  if (process.platform === "darwin") {
    const raw = await run("security", [
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      KEYCHAIN_ACCOUNT,
      "-w",
    ]).catch(() => undefined)
    const parsed = parseJson<CredentialFile>(raw)
    const credential = parsed?.providers?.meta ?? parsed
    if (credential?.api_key || credential?.access_token) return credential
  }

  for (const file of ["auth.json", "secrets.json"]) {
    const filePath = path.join(os.homedir(), ".config", "muse", file)
    const parsed = parseJson<CredentialFile>(await readFile(filePath, "utf8").catch(() => undefined))
    const credential = parsed?.providers?.meta ?? parsed
    if (credential?.api_key || credential?.access_token) return credential
  }

  // Legacy cache written by opencode-muse-auth (plain { apiKey }).
  const subCache = parseJson<{ apiKey?: string }>(
    await readFile(path.join(os.homedir(), ".config", "opencode", "muse-code-sub.json"), "utf8").catch(() => undefined),
  )
  if (subCache?.apiKey?.trim()) return { api_key: subCache.apiKey.trim() }

  return undefined
}

// Exchanges the OAuth login for the long-lived API key. Minting is idempotent:
// the same account always gets the same key back.
async function mintApiKey(accessToken: string): Promise<string | undefined> {
  const response = await fetch(`${API_ORIGIN}/muse-code/key`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json().catch(() => undefined)) as { api_key?: string } | undefined
  return body?.api_key
}

async function fetchCatalog(apiKey: string): Promise<readonly MuseModel[] | undefined> {
  const response = await fetch(`${API_ORIGIN}/muse-code/models`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response?.ok) return undefined
  const body = (await response.json().catch(() => undefined)) as { data?: readonly MuseModel[] } | undefined
  return body?.data
}

function toModelInfo(providerID: Provider.ID, model: MuseModel): Model.Info {
  const meta = model.metadata?.["muse-code"] ?? {}
  const defaultEffort = meta.options?.reasoningEffort
  return {
    ...Model.Info.default(providerID, Model.ID.make(model.id)),
    name: model.id,
    capabilities: {
      tools: meta.tool_call !== false,
      input: [...(meta.modalities?.input ?? ["text"])],
      output: ["text"],
    },
    limit: {
      context: meta.limit?.context ?? 200_000,
      output: meta.limit?.output ?? 32_000,
    },
    time: { released: (model.created ?? 0) * 1_000 },
    variants: Object.entries(meta.variants ?? {}).map(([id, variant]) => ({
      id: Model.VariantID.make(id),
      body: { reasoning_effort: variant.reasoningEffort ?? id },
    })),
    ...(defaultEffort ? { body: { reasoning_effort: defaultEffort } } : {}),
  }
}

export default Plugin.define({
  id: "muse-code-sub",
  async setup(ctx) {
    const provider = (ctx as unknown as { provider: ProviderDomain }).provider
    const providerID = Provider.ID.make(PROVIDER_ID)
    const optionKey = typeof ctx.options?.key === "string" ? ctx.options.key : undefined

    // Mutable state the synchronous transform reads. It is refreshed before
    // every provider reload, so reads during a replay see current data.
    const state: { apiKey?: string; accessToken?: string; catalog: readonly MuseModel[] } = { catalog: FALLBACK_CATALOG }

    // Subscription flow: the OAuth access token is used directly as the
    // bearer (mintApiKey would fail or return a key without the builtin
    // tool attestation). Catalog is fetched with the same bearer.
    const refreshWithToken = async (accessToken: string): Promise<boolean> => {
      const catalog = await fetchCatalog(accessToken)
      const usable = catalog?.filter((model) => {
        const meta = model.metadata?.["muse-code"]
        return meta && !meta.is_hidden && meta.tool_call !== false && (meta.modalities?.output ?? ["text"]).includes("text")
      })
      if (!usable?.length) return false
      state.apiKey = undefined
      state.accessToken = accessToken
      state.catalog = usable
      return true
    }

    const refresh = async (): Promise<boolean> => {
      const credential = await readCredential(optionKey)
      const minted = credential?.api_key ?? (credential?.access_token && (await mintApiKey(credential.access_token)))
      if (minted) {
        state.apiKey = minted
        state.accessToken = undefined
      } else if (credential?.access_token) {
        return refreshWithToken(credential.access_token)
      } else {
        return false
      }

      const apiKey = state.apiKey as string
      const catalog = await fetchCatalog(apiKey)
      const usable = catalog?.filter((model) => {
        const meta = model.metadata?.["muse-code"]
        return meta && !meta.is_hidden && meta.tool_call !== false && (meta.modalities?.output ?? ["text"]).includes("text")
      })
      if (usable?.length) state.catalog = usable
      return true
    }

    const connected = await refresh().catch(() => false)
    if (!connected) {
      console.warn(
        "[muse-code] No Muse Code login found. Sign in with the `muse` CLI or set META_API_KEY. " +
          "Models are listed but requests fail until then.",
      )
    }

    const registration = await provider.transform((editor) => {
      // Token flow: the OAuth access token goes straight in as the bearer so
      // the subscription attestation is preserved (no minted key).
      const settings = state.apiKey
        ? { baseURL: API_BASE, apiKey: state.apiKey }
        : state.accessToken
          ? { baseURL: API_BASE, apiKey: state.accessToken }
          : { baseURL: API_BASE }
      const models = state.catalog.map((model) => toModelInfo(providerID, model))

      if (editor.get(PROVIDER_ID)) {
        editor.update(PROVIDER_ID, (draft) => {
          draft.name = PROVIDER_NAME
          draft.activation = "enabled"
          draft.package = PROVIDER_PACKAGE
          draft.settings = settings
        })
        editor.models.set(PROVIDER_ID, models)
        return
      }

      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: PROVIDER_NAME,
          activation: "enabled",
          package: PROVIDER_PACKAGE,
          settings,
        },
        models,
      })
    })

    const timer = setInterval(() => {
      void refresh()
        .then((ready) => (ready ? Promise.resolve() : undefined))
        .catch((error) => console.error("[muse-code] refresh failed", error))
    }, REFRESH_MS)

    return () => {
      clearInterval(timer)
      void registration.dispose()
    }
  },
})

