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
  SettingsFormPathOp,
  SettingsFormScope,
  SettingsFormScopeSnapshot,
  SettingsFormShell,
  SettingsSecretSpec
} from '@deepseek-ai/dsh-client-ui-primitives'


/**
 * The field vocabulary lives in `form-specs.ts` so it can be unit-tested without
 * the browser bundle; re-exported here so the card and controller keep one import.
 */
export * from './form-specs'
// The model's own signatures name the spec type, so import it as well as
// re-export it: `export *` makes it visible to consumers, not to this module.
import type { PathFieldSpec } from './form-specs'

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
