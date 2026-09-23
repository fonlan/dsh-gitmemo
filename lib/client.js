window.__ModuleLoader__.load({
	id: "@fonlan/dsh-gitmemo",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/card.tsx
		/**
		* The gitmemo settings page's card: the gate's master switch, the System-one
		* endpoint, its model, and the API key — written through the credentials domain,
		* never into the settings section, so the literal never rides a response.
		*
		* The form chrome (read-only notice, unavailable notice, save, and the staged
		* save semantics) is the shared `SettingsForm`/`SettingsValueField`/
		* `SettingsSecretField` kit, so this page behaves exactly like a shipped one.
		*/
		/**
		* Render one labelled boolean field.
		* @param props - the field's copy, its staged state, and the edit actions.
		* @returns the labelled switch.
		*/
		function SettingsSwitchField(props) {
			const { id, label, hint, checked, overridden, overriddenLabel, resetLabel, disabled, onEdit, onReset } = props;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 6
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							fontSize: 13,
							fontWeight: 500,
							color: "var(--dsw-alias-label-primary)"
						},
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: {
							display: "flex",
							alignItems: "center",
							gap: 8
						},
						children: [overridden ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tag, {
							tone: "neutral",
							children: overriddenLabel
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "ghost",
							size: "sm",
							type: "button",
							disabled,
							onClick: onReset,
							children: resetLabel
						})] }) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Switch, {
							checked,
							onChange: onEdit,
							label,
							disabled
						})]
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					id: `${id}-hint`,
					style: {
						margin: 0,
						fontSize: 12,
						color: "var(--dsw-alias-label-tertiary)"
					},
					children: hint
				})]
			});
		}
		/**
		* The form frame's copy, read from this page's dictionary.
		* @param t - the page's locale reader.
		* @returns the labels the shared settings form renders.
		*/
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		/**
		* Render the gitmemo settings page.
		* @param props - locale copy, the staged form state, and its actions.
		* @returns the settings form.
		*/
		function GitMemoSettingsSection(props) {
			const { t, useGitMemoSettings, edit, resetField, save, discard } = props;
			const state = useGitMemoSettings((snapshot) => snapshot);
			const sectionDisabled = !state.writable;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
				labels: formLabels(t),
				state,
				onSave: save,
				onDiscard: discard,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SettingsSwitchField, {
						id: "dsh-gitmemo-systemone-enabled",
						label: t("enabled"),
						hint: t("enabledHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						disabled: sectionDisabled,
						checked: state.enabled.text === "true",
						overridden: state.enabled.overridden,
						onEdit: (next) => {
							edit("enabled", String(next));
						},
						onReset: () => {
							resetField("enabled");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
						id: "dsh-gitmemo-systemone-endpoint",
						label: t("endpoint"),
						hint: t("endpointHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidText"),
						disabled: sectionDisabled,
						...state.endpoint,
						onEdit: (text) => {
							edit("endpoint", text);
						},
						onReset: () => {
							resetField("endpoint");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
						id: "dsh-gitmemo-systemone-model",
						label: t("model"),
						hint: t("modelHint"),
						overriddenLabel: t("overridden"),
						resetLabel: t("reset"),
						invalidLabel: t("invalidText"),
						disabled: sectionDisabled,
						...state.model,
						onEdit: (text) => {
							edit("model", text);
						},
						onReset: () => {
							resetField("model");
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.SettingsSecretField, {
						id: "dsh-gitmemo-systemone-apikey",
						label: t("apiKey"),
						hint: t("apiKeyHint"),
						disabled: !state.apiKeyWritable,
						text: state.apiKey.text,
						configured: state.apiKeyConfigured,
						stateLabel: state.apiKeyConfigured ? t("apiKeySet") : t("apiKeyUnset"),
						onEdit: (text) => {
							edit("apiKey", text);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/form-model.tsx
		/**
		* A free-text field. An empty draft clears the field, so emptying the control
		* and saving is the same gesture as resetting it.
		* @param field - key addressing this control inside the card's form.
		* @param path - path of the field inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function pathTextField(field, path) {
			return {
				field,
				path,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => {
					const trimmed = text.trim();
					return trimmed === "" ? { kind: "clear" } : {
						kind: "set",
						value: trimmed
					};
				}
			};
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
		const ABSENT_BOOLEAN_TEXT = "true";
		/**
		* A boolean field, staged as the `'true'`/`'false'` draft the card's switch
		* renders. An empty draft clears the field (re-inheriting the declared
		* default); any other draft that is not one of those two words blocks the save.
		* @param field - key addressing this control inside the card's form.
		* @param path - path of the field inside the namespace section.
		* @returns the field's conversion spec.
		*/
		function pathBooleanField(field, path) {
			return {
				field,
				path,
				format: (value) => typeof value === "boolean" ? String(value) : ABSENT_BOOLEAN_TEXT,
				parse: (text) => {
					const trimmed = text.trim();
					if (trimmed === "") return { kind: "clear" };
					if (trimmed === "true") return {
						kind: "set",
						value: true
					};
					if (trimmed === "false") return {
						kind: "set",
						value: false
					};
				}
			};
		}
		/** Read one path inside a JSON-shaped layer. */
		function member(value, path) {
			let node = value;
			for (const key of path) {
				if (node === null || typeof node !== "object") return void 0;
				node = node[key];
			}
			return node;
		}
		/** Whether the user layer actually carries this path (presence, not value, marks an override). */
		function carries(value, path) {
			const last = path[path.length - 1];
			if (last === void 0) return false;
			const parent = member(value, path.slice(0, -1));
			return parent !== null && typeof parent === "object" && Object.hasOwn(parent, last);
		}
		/**
		* Stages one card's edits over one settings namespace and writes them on save.
		*/
		var GitMemoFormModel = class {
			scope;
			specs;
			secretSpecs;
			staged = /* @__PURE__ */ new Map();
			listeners = /* @__PURE__ */ new Set();
			unsubscribe;
			baseline;
			saving = false;
			failed = false;
			/**
			* @param scope - the shared configuration form for this card's namespace.
			* @param specs - the section fields this card edits.
			* @param secrets - the card's write-only controls, written outside the section.
			*/
			constructor(scope, specs, secrets = []) {
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.field, spec]));
				this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]));
				this.unsubscribe = scope.subscribe(() => {
					this.publish();
				});
			}
			/** Observe draft or host-state changes. */
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			/** Read the card-level state: what the Host serves, and what a save would do. */
			shell() {
				const snapshot = this.scope.getSnapshot();
				const plan = this.plan();
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					dirty: plan.length > 0,
					invalid: plan.some((item) => item.invalid === true),
					saving: this.saving,
					failed: this.failed
				};
			}
			/**
			* Read one control's state.
			* @param field - key of a section field or of a write-only control.
			* @returns the draft text, whether a save would leave an override, and whether it is invalid.
			*/
			field(field) {
				const staged = this.staged.get(field);
				if (this.secretSpecs.has(field)) return {
					text: staged?.text ?? "",
					overridden: false,
					invalid: false
				};
				const spec = this.spec(field);
				if (staged === void 0) return {
					text: spec.format(this.sectionValue(spec.path)),
					overridden: this.stored(spec.path),
					invalid: false
				};
				const write = staged.clear ? { kind: "clear" } : spec.parse(staged.text);
				return {
					text: staged.text,
					overridden: write?.kind === "set",
					invalid: write === void 0
				};
			}
			/** Build the edit, reset, save, and discard actions bound to this form. */
			actions() {
				return {
					edit: (field, text) => {
						this.stage(field, {
							text,
							clear: false
						});
					},
					resetField: (field) => {
						const spec = this.spec(field);
						this.stage(field, {
							text: spec.format(this.baseValue(spec.path)),
							clear: true
						});
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.staged.size === 0 && !this.failed) return;
						this.staged.clear();
						this.baseline = void 0;
						this.failed = false;
						this.publish();
					}
				};
			}
			/**
			* Write every staged edit, then re-seed from what the Host accepted.
			*
			* The Host is the only authority on whether a value was accepted, so the
			* outcome is read back from the section rather than predicted here. A save
			* that did not land keeps its drafts, so the user can correct them instead of
			* retyping.
			*/
			async save() {
				const plan = this.plan();
				if (plan.length === 0 || this.saving || !this.scope.getSnapshot().writable || plan.some((item) => item.invalid === true)) return;
				this.saving = true;
				this.failed = false;
				this.publish();
				try {
					const ops = plan.flatMap((item) => item.op === void 0 ? [] : [item.op]);
					let landed = ops.length === 0 || await this.scope.mutate(ops, this.baseline?.revision);
					if (!landed) {
						this.failed = true;
						return;
					}
					for (const item of plan) if (item.run !== void 0) landed = await item.run() && landed;
					if (landed) {
						this.staged.clear();
						this.baseline = void 0;
					}
					this.failed = !landed;
				} catch {
					this.failed = true;
				} finally {
					this.saving = false;
					this.publish();
				}
			}
			/** Release the form's accepted-value subscription. */
			dispose() {
				this.unsubscribe();
				this.listeners.clear();
			}
			/**
			* Every staged edit a save would write, in staging order. An entry whose
			* draft is not a value its field accepts carries no write: the form is still
			* dirty, and the save refuses rather than dropping the edit.
			*/
			plan() {
				const plan = [];
				for (const [field, staged] of this.staged) {
					const secret = this.secretSpecs.get(field);
					if (secret !== void 0) {
						const value = staged.text.trim();
						if (value !== "") plan.push({
							field,
							run: () => secret.write(value)
						});
						continue;
					}
					const spec = this.spec(field);
					if (staged.clear) {
						if (this.stored(spec.path)) plan.push({
							field,
							op: {
								op: "unset",
								path: [...spec.path]
							}
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(spec.path))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({
						field,
						invalid: true
					});
					else if (write.kind === "clear") plan.push({
						field,
						op: {
							op: "unset",
							path: [...spec.path]
						}
					});
					else plan.push({
						field,
						op: {
							op: "set",
							path: [...spec.path],
							value: write.value
						}
					});
				}
				return plan;
			}
			stage(field, edit) {
				this.baseline ??= this.scope.getSnapshot();
				this.staged.set(field, edit);
				this.failed = false;
				this.publish();
			}
			spec(field) {
				const spec = this.specs.get(field);
				if (spec === void 0) throw new Error(`dsh-gitmemo settings card has no field ${field}`);
				return spec;
			}
			sectionValue(path) {
				return member(this.scope.getSnapshot().value, path);
			}
			baseValue(path) {
				return member(this.scope.getSnapshot().base, path);
			}
			stored(path) {
				return carries(this.scope.getSnapshot().user, path);
			}
			publish() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/controller.tsx
		/**
		* Settings namespace of this plugin. Spelled here rather than imported: a
		* client half must not depend on a host half, and the id is the profile entry
		* id the settings plane keys forms by.
		*/
		const GITMEMO_NS = "dsh-gitmemo";
		/** Credential reference the host resolves when the section names none. */
		const DEFAULT_API_KEY_REF = "TYPESAFE_API_KEY";
		/** Form field the credential control stages under. */
		const API_KEY_FIELD = "apiKey";
		/** Bridges the `dsh-gitmemo` scope and the credentials domain onto the page. */
		var GitMemoSettingsController = class {
			scope;
			ctx;
			form;
			listeners = /* @__PURE__ */ new Set();
			unsubscribe;
			unsubscribeForm;
			snapshot;
			credential = {
				ref: "",
				configured: false,
				writable: true
			};
			/**
			* @param scope - the bound settings scope for the `dsh-gitmemo` namespace.
			* @param ctx - the page plugin's context, whose `remote.credentials` namespace
			* answers for the credential the section references.
			*/
			constructor(scope, ctx) {
				this.scope = scope;
				this.ctx = ctx;
				this.form = new GitMemoFormModel(scope, [
					pathBooleanField("enabled", ["systemOne", "enabled"]),
					pathTextField("endpoint", ["systemOne", "endpoint"]),
					pathTextField("model", ["systemOne", "model"])
				], [{
					field: API_KEY_FIELD,
					write: (text) => this.writeKey(text)
				}]);
				this.snapshot = this.projection();
				this.unsubscribe = scope.subscribe(() => {
					this.readCredential();
					this.publish();
				});
				this.unsubscribeForm = this.form.subscribe(() => {
					this.publish();
				});
				this.readCredential();
			}
			/** Read the current page snapshot (stable reference until the next change). */
			getSnapshot = () => this.snapshot;
			/** Observe page-snapshot replacements. */
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			};
			/**
			* Re-read after the Host reports a change to the reference this page watches.
			* A key can be written from somewhere else, and the settings section does not
			* change when it is.
			* @param ref - the reference the Host reports as changed.
			*/
			refreshCredential(ref) {
				if (ref !== this.credential.ref) return;
				this.readCredential();
			}
			/**
			* Build the face the page's slot registration injects.
			* @returns the page's snapshot and its form actions.
			*/
			inject() {
				return {
					hooks: { gitMemoSettings: {
						getSnapshot: this.getSnapshot,
						subscribe: this.subscribe
					} },
					...this.form.actions()
				};
			}
			/** Release configuration subscriptions. */
			dispose() {
				this.unsubscribe();
				this.unsubscribeForm();
				this.form.dispose();
				this.listeners.clear();
			}
			projection() {
				return {
					...this.form.shell(),
					enabled: this.form.field("enabled"),
					endpoint: this.form.field("endpoint"),
					model: this.form.field("model"),
					apiKey: this.form.field(API_KEY_FIELD),
					apiKeyConfigured: this.credential.configured,
					apiKeyWritable: this.credential.writable
				};
			}
			publish() {
				this.snapshot = this.projection();
				for (const listener of [...this.listeners]) listener();
			}
			/**
			* Ask the credentials domain about the reference the section currently names.
			*
			* The answer is stored with the reference it describes: `apiKeyEnv` can change
			* between the request and its response, so a response is published only while
			* it still answers for the reference in force.
			*/
			async readCredential() {
				const ref = refOf(this.scope.getSnapshot());
				if (ref !== this.credential.ref) {
					this.credential = {
						ref,
						configured: false,
						writable: true
					};
					this.publish();
				}
				const response = await this.ctx.remote.credentials.describe([ref]);
				if (!response.ok || ref !== refOf(this.scope.getSnapshot())) return;
				const view = response.value[ref];
				const next = {
					ref,
					configured: view?.configured ?? false,
					writable: view?.writable ?? true
				};
				if (next.configured === this.credential.configured && next.writable === this.credential.writable) return;
				this.credential = next;
				this.publish();
			}
			/**
			* Write the staged key, then re-read whether the Host now holds one.
			* @param value - the staged credential literal.
			* @returns whether the Host reports a configured credential afterwards.
			*/
			async writeKey(value) {
				const response = await this.ctx.remote.credentials.set(refOf(this.scope.getSnapshot()), value);
				await this.readCredential();
				return response.ok && this.credential.configured;
			}
		};
		/**
		* The credential reference the section names, or the host's default.
		* @param snapshot - the current scope snapshot.
		* @returns the reference to address.
		*/
		function refOf(snapshot) {
			const declared = snapshot.value?.systemOne?.apiKeyEnv;
			return declared !== void 0 && declared.length > 0 ? declared : DEFAULT_API_KEY_REF;
		}
		//#endregion
		//#region src/client/locales.tsx
		/**
		* Locale dictionaries for the gitmemo settings page.
		*
		* The namespace is the plugin's own cordis id (kebab), which is also the
		* settings namespace and the profile entry id; the scoped npm package name is
		* reserved for package-bound identifiers (the module-loader id, the bundle
		* route base). zh is the key source of truth — en is typed against it, and the
		* locale registry re-checks the key sets at registration time.
		*/
		/** Dictionary namespace owned by this page. */
		const LOCALE_NS = "dsh-gitmemo";
		/** Simplified Chinese copy. */
		const zh = {
			settingsTitle: "GitMemo",
			settingsSub: "Git 长期记忆（.mem）中「系统一召回闸门」的配置。",
			enabled: "启用 System-one 召回闸门",
			enabledHint: "关闭后 mem_search 不再调用 System-one 模型，召回行为与门控存在前逐字节一致；此外仍需已配置密钥。",
			endpoint: "System-one 接口地址",
			endpointHint: "接受 System-one 请求契约的 HTTP 端点；留空表示恢复默认地址。",
			model: "模型",
			modelHint: "请求体中携带的模型标识；留空表示恢复默认模型。",
			apiKey: "API Key",
			apiKeyHint: "凭据不写入设置文件。留空表示保持当前密钥。",
			apiKeySet: "已配置密钥。",
			apiKeyUnset: "未配置密钥；配置之前召回闸门不生效。",
			overridden: "已覆盖",
			reset: "恢复默认",
			invalidText: "该字段不接受这个值。",
			readOnly: "本部署的设置为只读。",
			unavailable: "该插件当前未加载，暂时无法配置。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "本部署没有接受这些值，已保留供你修改。"
		};
		/** English copy; the key set must match {@link zh} exactly. */
		const en = {
			settingsTitle: "GitMemo",
			settingsSub: "Configuration of the System-one recall gate over the Git-backed .mem memory.",
			enabled: "Enable the System-one recall gate",
			enabledHint: "When off, mem_search never calls the System-one model and recall behaves byte-for-byte as it did before the gate existed; a credential is still required for it to run.",
			endpoint: "System-one endpoint",
			endpointHint: "HTTP endpoint accepting the System-one request contract; blank restores the default.",
			model: "Model",
			modelHint: "Model identifier sent in the request body; blank restores the default.",
			apiKey: "API key",
			apiKeyHint: "Stored outside the settings file. Leave blank to keep the current key.",
			apiKeySet: "A key is configured.",
			apiKeyUnset: "No key is configured; the recall gate stays a no-op until one is.",
			overridden: "Overridden",
			reset: "Reset to default",
			invalidText: "This field does not accept that value.",
			readOnly: "This deployment stores settings read-only.",
			unavailable: "This plugin is not loaded, so it cannot be configured right now.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "The deployment did not accept these values; they were left for you to correct."
		};
		//#endregion
		//#region src/client/index.tsx
		/** The settings sidebar entry this plugin's page owns (must stay stable). */
		const SETTINGS_SECTION_ID = "dsh-gitmemo";
		/** Services required before mounting (provided by the client runtime). */
		const inject = [
			"slots",
			"locale",
			"remote",
			"remote.credentials",
			"configForms"
		];
		/**
		* Mount the gitmemo settings page while the Host serves its namespace.
		* @param ctx - the browser plugin context.
		*/
		function apply(ctx) {
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, {
				zh,
				en
			}), "dsh-gitmemo: dictionaries");
			const controller = new GitMemoSettingsController(ctx.configForms.get(GITMEMO_NS), ctx);
			ctx.effect(() => () => {
				controller.dispose();
			}, "dsh-gitmemo: settings form");
			ctx.effect(() => ctx.remote.$on("credentials/reference-updated", (ref) => {
				controller.refreshCredential(ref);
			}), "dsh-gitmemo: credential invalidations");
			ctx.effect(() => ctx.configForms.whileServed([GITMEMO_NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: SETTINGS_SECTION_ID,
				order: 200,
				label: () => t("settingsTitle"),
				locale: LOCALE_NS,
				inject: () => controller.inject()
			}, GitMemoSettingsSection))), "dsh-gitmemo: settings page");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map