/**
 * A staged, path-aware settings form model.
 *
 * Why this exists instead of `SettingsFormModel` from
 * `@deepseek-ai/dsh-client-ui-primitives`: that model addresses every field as
 * a SINGLE top-level key of the namespace section (`path: [field]` in its
 * `plan()`), while this plugin's editable fields live one level down under the
 * nested `systemOne` object its `Config` declares. Feeding it
 * `settingsTextField('systemOne.endpoint')` would read `section['systemOne.endpoint']`
 * and write a literal dotted key — silently configuring nothing.
 *
 * So this model keeps the shipped model's staging semantics (one save writes
 * every staged edit; an empty draft clears the field; a draft the field does
 * not accept BLOCKS the save rather than being dropped; a save that did not
 * land keeps its drafts) and its state shapes (`SettingsFormShell`,
 * `SettingsFieldState`), but carries an explicit `path` per field and emits
 * nested `SettingsFormPathOp`s — the vocabulary the Host's settings plane
 * actually accepts (`isVolatilePath` walks multi-segment paths, and
 * `settings/mutate` applies them positionally).
 */

import type {
  SettingsFieldState,
  SettingsFieldWrite,
  SettingsFormPathOp,
  SettingsFormScope,
  SettingsFormScopeSnapshot,
  SettingsFormShell,
  SettingsSecretSpec
} from '@deepseek-ai/dsh-client-ui-primitives'

/** The editable projection of this plugin's settings namespace. */
export interface GitMemoSettings {
  /** The System-one recall gate, as `src/index.ts` declares it. */
  systemOne?: {
    enabled?: boolean
    endpoint?: string
    model?: string
    apiKey?: string
    apiKeyEnv?: string
    mode?: 'noul' | 'score'
    threshold?: number
    scoreMin?: number
    minKeep?: number
    maxCandidates?: number
    maxTaskChars?: number
    timeoutMs?: number
  }
}

/** How one section field converts between its stored value and its draft text. */
export interface PathFieldSpec {
  /** Key addressing this control inside the card's form. */
  field: string
  /** Path inside the namespace section this control edits. */
  path: readonly string[]
  /** Render a stored value as draft text; the empty string when the section carries none. */
  format: (value: unknown) => string
  /** The write this draft text stages, or undefined when the text is not a value this field accepts. */
  parse: (text: string) => SettingsFieldWrite | undefined
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathTextField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'string' ? value : ''),
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    }
  }
}

/**
 * A whole-number field. An empty draft clears the field; any other draft that
 * is not a finite number blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathNumberField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'number' ? String(value) : ''),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    }
  }
}

/**
 * Draft text a boolean field renders while the section carries no value.
 *
 * A missing boolean is not "unknown": `src/index.ts` declares
 * `systemOne.enabled` with `default(true)` and reads it back through
 * `liveValue(section.enabled, true)`, so an absent value means ENABLED. Rendering
 * an absent boolean as the empty string would show a disabled switch for a gate
 * that is actually running, so the draft is seeded with the declared default.
 */
const ABSENT_BOOLEAN_TEXT = 'true'

/**
 * A boolean field, staged as the `'true'`/`'false'` draft the card's switch
 * renders. An empty draft clears the field (re-inheriting the declared
 * default); any other draft that is not one of those two words blocks the save.
 * @param field - key addressing this control inside the card's form.
 * @param path - path of the field inside the namespace section.
 * @returns the field's conversion spec.
 */
export function pathBooleanField(field: string, path: readonly string[]): PathFieldSpec {
  return {
    field,
    path,
    format: (value) => (typeof value === 'boolean' ? String(value) : ABSENT_BOOLEAN_TEXT),
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      if (trimmed === 'true') return { kind: 'set', value: true }
      if (trimmed === 'false') return { kind: 'set', value: false }
      return undefined
    }
  }
}

/** One staged draft: what the user typed, and whether it stages a clear. */
interface Staged {
  text: string
  clear: boolean
}

/** One planned write: a section op, a credential write, or a blocking invalid draft. */
interface PlannedWrite {
  field: string
  op?: SettingsFormPathOp
  run?: () => Promise<boolean>
  invalid?: boolean
}

/** Read one path inside a JSON-shaped layer. */
function member(value: unknown, path: readonly string[]): unknown {
  let node: unknown = value
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Whether the user layer actually carries this path (presence, not value, marks an override). */
function carries(value: unknown, path: readonly string[]): boolean {
  const last = path[path.length - 1]
  if (last === undefined) return false
  const parent = member(value, path.slice(0, -1))
  return parent !== null && typeof parent === 'object' && Object.hasOwn(parent, last)
}

/**
 * Stages one card's edits over one settings namespace and writes them on save.
 */
export class GitMemoFormModel<T> {
  private readonly scope: SettingsFormScope<T>
  private readonly specs: Map<string, PathFieldSpec>
  private readonly secretSpecs: Map<string, SettingsSecretSpec>
  private readonly staged = new Map<string, Staged>()
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private baseline: SettingsFormScopeSnapshot<T> | undefined
  private saving = false
  private failed = false

  /**
   * @param scope - the shared configuration form for this card's namespace.
   * @param specs - the section fields this card edits.
   * @param secrets - the card's write-only controls, written outside the section.
   */
  constructor(scope: SettingsFormScope<T>, specs: PathFieldSpec[], secrets: SettingsSecretSpec[] = []) {
    this.scope = scope
    this.specs = new Map(specs.map((spec) => [spec.field, spec]))
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]))
    this.unsubscribe = scope.subscribe(() => {
      this.publish()
    })
  }

  /** Observe draft or host-state changes. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Read the card-level state: what the Host serves, and what a save would do. */
  shell(): SettingsFormShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.invalid === true),
      saving: this.saving,
      failed: this.failed
    }
  }

  /**
   * Read one control's state.
   * @param field - key of a section field or of a write-only control.
   * @returns the draft text, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): SettingsFieldState {
    const staged = this.staged.get(field)
    if (this.secretSpecs.has(field)) return { text: staged?.text ?? '', overridden: false, invalid: false }
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(spec.path)), overridden: this.stored(spec.path), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  /** Build the edit, reset, save, and discard actions bound to this form. */
  actions(): {
    edit: (field: string, text: string) => void
    resetField: (field: string) => void
    save: () => void
    discard: () => void
  } {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false })
      },
      resetField: (field) => {
        const spec = this.spec(field)
        this.stage(field, { text: spec.format(this.baseValue(spec.path)), clear: true })
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.baseline = undefined
        this.failed = false
        this.publish()
      }
    }
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted.
   *
   * The Host is the only authority on whether a value was accepted, so the
   * outcome is read back from the section rather than predicted here. A save
   * that did not land keeps its drafts, so the user can correct them instead of
   * retyping.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    if (
      plan.length === 0 ||
      this.saving ||
      !this.scope.getSnapshot().writable ||
      plan.some((item) => item.invalid === true)
    ) {
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    try {
      const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]))
      let landed = ops.length === 0 || (await this.scope.mutate(ops, this.baseline?.revision))
      if (!landed) {
        this.failed = true
        return
      }
      for (const item of plan) if (item.run !== undefined) landed = (await item.run()) && landed
      if (landed) {
        this.staged.clear()
        this.baseline = undefined
      }
      this.failed = !landed
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Release the form's accepted-value subscription. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * Every staged edit a save would write, in staging order. An entry whose
   * draft is not a value its field accepts carries no write: the form is still
   * dirty, and the save refuses rather than dropping the edit.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const secret = this.secretSpecs.get(field)
      if (secret !== undefined) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(spec.path)) plan.push({ field, op: { op: 'unset', path: [...spec.path] } })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(spec.path))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, invalid: true })
      else if (write.kind === 'clear') plan.push({ field, op: { op: 'unset', path: [...spec.path] } })
      else plan.push({ field, op: { op: 'set', path: [...spec.path], value: write.value } })
    }
    return plan
  }

  private stage(field: string, edit: Staged): void {
    this.baseline ??= this.scope.getSnapshot()
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): PathFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`dsh-gitmemo settings card has no field ${field}`)
    return spec
  }

  private sectionValue(path: readonly string[]): unknown {
    return member(this.scope.getSnapshot().value, path)
  }

  private baseValue(path: readonly string[]): unknown {
    return member(this.scope.getSnapshot().base, path)
  }

  private stored(path: readonly string[]): boolean {
    return carries(this.scope.getSnapshot().user, path)
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
