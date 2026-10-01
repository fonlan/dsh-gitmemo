/**
 * OpenAI-compatible chat client used for the optional LLM modes
 * (`--query-keywords llm`, `--ingest-keywords llm`, the RAG reader, and the
 * answer judge).
 *
 * Design points:
 *  - Every request is disk-cached by sha256(model + messages), so re-runs and
 *    ablations are free and reproducible.
 *  - Credentials resolve in order: explicit option → `--api-key-env` →
 *    `DEEPSEEK_API_KEY`/`OPENAI_API_KEY` → the local DSH credential store
 *    (`~/.dsh/.credentials.yaml`). Keys are never logged.
 *  - Default endpoint is DeepSeek's OpenAI-compatible API because it is what
 *    this machine is provisioned with; `--base-url`/`--model` switch it.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = process.env.DSH_LME_BASE_URL ?? "https://api.deepseek.com/v1";
export const DEFAULT_MODEL = process.env.DSH_LME_MODEL ?? "deepseek-chat";

/** Pull a key out of the local DSH credential store without ever echoing it. */
export async function keyFromDshCredentials(name) {
  const path = join(homedir(), ".dsh", ".credentials.yaml");
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  // The store is a small YAML document: `refs:` maps an env-var name to a
  // secret, `records:` holds payloads. Only the literal secret values are read
  // here, matched by the requested name.
  const lines = raw.split(/\r?\n/);
  let pendingName;
  for (const line of lines) {
    const nameMatch = line.match(/^\s{2,}([A-Z0-9_]+):\s*(.*)$/);
    if (nameMatch) {
      pendingName = nameMatch[1];
      const inline = nameMatch[2].trim().replace(/^["']|["']$/g, "");
      if (pendingName === name && inline.length > 0 && !/^[>|]/.test(inline)) return inline;
      continue;
    }
    const secretMatch = line.match(/^\s+secret:\s*(.+)$/);
    if (secretMatch && pendingName === name) {
      const value = secretMatch[1].trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

export async function resolveCredential({ apiKey, apiKeyEnv } = {}) {
  if (apiKey) return apiKey;
  const names = [apiKeyEnv, "DEEPSEEK_API_KEY", "OPENAI_API_KEY"].filter(Boolean);
  for (const name of names) {
    const fromEnv = process.env[name];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  }
  for (const name of names) {
    const stored = await keyFromDshCredentials(name);
    if (stored) return stored;
  }
  return undefined;
}

class Cache {
  constructor(dir) {
    this.dir = dir;
    this.memory = new Map();
  }
  key(body) {
    return createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 32);
  }
  async get(body) {
    const key = this.key(body);
    if (this.memory.has(key)) return this.memory.get(key);
    try {
      const raw = await readFile(join(this.dir, `${key}.json`), "utf8");
      const parsed = JSON.parse(raw);
      this.memory.set(key, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }
  async set(body, value) {
    const key = this.key(body);
    this.memory.set(key, value);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${key}.json`), JSON.stringify(value), "utf8");
  }
}

export class ChatClient {
  /**
   * @param {{ baseUrl?: string, model?: string, apiKey?: string, apiKeyEnv?: string,
   *           cacheDir?: string, concurrency?: number, maxRetries?: number, temperature?: number,
   *           onUsage?: (usage: {prompt:number, completion:number, calls:number}) => void }} opts
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.apiKey = opts.apiKey;
    this.apiKeyEnv = opts.apiKeyEnv;
    this.cacheDir = opts.cacheDir ?? join(process.cwd(), "evals", "longmemeval", ".cache");
    this.cache = new Cache(this.cacheDir);
    this.concurrency = opts.concurrency ?? 8;
    this.maxRetries = opts.maxRetries ?? 4;
    this.temperature = opts.temperature ?? 0;
    this.usage = { prompt: 0, completion: 0, calls: 0, cached: 0 };
    this.onUsage = opts.onUsage;
    this.active = 0;
    this.queue = [];
  }

  static async create(opts = {}) {
    const client = new ChatClient(opts);
    client.apiKey = await resolveCredential({ apiKey: opts.apiKey, apiKeyEnv: opts.apiKeyEnv });
    return client;
  }

  get ready() {
    return typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  async _acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  _release() {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** One chat completion; cached, retried, and concurrency-limited. */
  async chat(messages, { maxTokens = 512, temperature, model } = {}) {
    if (!this.ready) throw new Error("llm: no API key available (set DEEPSEEK_API_KEY or pass --api-key)");
    const body = {
      model: model ?? this.model,
      messages,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens,
      stream: false
    };
    const cached = await this.cache.get(body);
    if (cached !== undefined) {
      this.usage.cached += 1;
      return cached;
    }
    await this._acquire();
    try {
      let lastError;
      for (let attempt = 0; attempt < this.maxRetries; attempt += 1) {
        try {
          const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
            body: JSON.stringify(body)
          });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            const retryable = res.status === 429 || res.status >= 500;
            const hint =
              res.status === 402
                ? " (the provider account is out of credit — top it up or point --base-url at another endpoint)"
                : res.status === 401 || res.status === 403
                  ? " (the credential was rejected — check the key/endpoint pair)"
                  : "";
            const error = new Error(`llm: HTTP ${res.status} ${text.slice(0, 300)}${hint}`);
            error.status = res.status;
            error.retryable = retryable;
            throw error;
          }
          const json = await res.json();
          const content = json?.choices?.[0]?.message?.content ?? "";
          this.usage.calls += 1;
          this.usage.prompt += json?.usage?.prompt_tokens ?? 0;
          this.usage.completion += json?.usage?.completion_tokens ?? 0;
          this.onUsage?.(this.usage);
          await this.cache.set(body, content);
          return content;
        } catch (error) {
          lastError = error;
          // A rejected credential or an exhausted balance will not fix itself:
          // retrying turns one clear failure into thousands of them. Only
          // rate limits, 5xx and network faults are worth another attempt.
          if (error?.retryable === false) throw error;
          const delay = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      throw lastError;
    } finally {
      this._release();
    }
  }

  /** Chat that must return a JSON value; tolerates fenced code blocks. */
  async chatJson(messages, opts = {}) {
    const raw = await this.chat(messages, opts);
    const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (start === -1 || end === -1) throw new Error(`llm: response is not JSON: ${raw.slice(0, 200)}`);
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export function ensureDir(path) {
  return mkdir(dirname(path), { recursive: true });
}
