"use strict";
/**
 * Browser half of dsh-goal-wait-gate: the configuration page for the strategy
 * this plugin mounts. It registers into the public `plugins.row.config` slot and
 * uses only the public settings service; no Harness Client package is imported.
 *
 * The web shell fetches this file as a classic script and concatenates several
 * bundles into one combo response, so it has to stay a script: no ESM syntax
 * anywhere, and every declaration inside the single registration factory below so
 * that nothing can collide with another bundle sharing the same response.
 * @module dsh-goal-wait-gate/client
 */
window.__ModuleLoader__.load({
    id: 'dsh-goal-wait-gate',
    factory(require) {
        const React = require('react');
        /** Loader row id declared by this bundle's patch. */
        const ROW_ID = 'goal-wait-gate';
        /** The bundle id the shell registers; must match the npm package name. */
        const BUNDLE_ID = 'dsh-goal-wait-gate';
        /**
         * The four implementation strategies, in the order the page shows them.
         * The 中文 labels mirror locale/zh.json so a reader sees the card text and
         * the choice list in the same words.
         */
        const STRATEGIES = [
            {
                value: 'activation',
                label: '官方原生驱动＋闸门（默认）',
                hint: '本插件挂载 DSH 官方原生驱动，并在会话仍有存活后台工作时暂缓自动续行——0.3.0 以来的行为。',
            },
            {
                value: 'replacement',
                label: '本插件移植驱动',
                hint: '由本插件接管调度，使用按宿主 pin 移植的驱动；后台工作存在时按资格等待，而不是靠反复 disarm。',
            },
            {
                value: 'native',
                label: '官方原样',
                hint: '只挂 DSH 官方原生驱动、不加干预：完全回到官方行为，是配置页里的一键回退。',
            },
            {
                value: 'off',
                label: '关闭续行',
                hint: '不挂任何驱动：目标不再自动续行。重新选回其它方式即可恢复；卸载插件同样回到官方行为。',
            },
        ];
        /** Boolean policy fields this page owns. */
        const BOOLEANS = [
            {
                key: 'waitForJobs',
                label: '后台作业存在时暂缓续行',
                hint: '会话仍拥有运行中或收尾中的作业时，不进行自动续行。默认开启。',
            },
            {
                key: 'waitForSubagents',
                label: '存活子代理存在时暂缓续行',
                hint: '会话仍有存活的子代理后代时，不进行自动续行。默认开启。',
            },
        ];
        /** Numeric policy field: milliseconds, `0` holds indefinitely. */
        const DURATION = {
            key: 'maxHoldMs',
            label: '最长持有时长（毫秒）',
            hint: '0 表示一直持有到后台工作结束；正数表示超过该时长后释放本次持有并记一条警告。',
        };
        /** Field names in display order. */
        const FIELDS = ['strategy', 'waitForJobs', 'waitForSubagents', 'maxHoldMs'];
        /** Read one field of a projected section, defaulting to the shipped policy. */
        function seedField(value, field) {
            const section = value !== null && typeof value === 'object' ? value : {};
            if (field === 'strategy') {
                const strategy = section.strategy;
                return STRATEGIES.some((item) => item.value === strategy) ? strategy : 'activation';
            }
            if (field === 'waitForJobs' || field === 'waitForSubagents') {
                const flag = section[field];
                return typeof flag === 'boolean' ? flag : true;
            }
            const duration = section.maxHoldMs;
            return typeof duration === 'number' && Number.isSafeInteger(duration) && duration >= 0 ? String(duration) : '0';
        }
        /** Build the display state for one accepted snapshot. */
        function seed(snapshot) {
            return {
                status: snapshot.status,
                writable: snapshot.writable,
                revision: snapshot.revision,
                strategy: seedField(snapshot.value, 'strategy'),
                waitForJobs: seedField(snapshot.value, 'waitForJobs'),
                waitForSubagents: seedField(snapshot.value, 'waitForSubagents'),
                maxHoldMs: seedField(snapshot.value, 'maxHoldMs'),
                dirty: false,
                saving: false,
                error: '',
                conflict: false,
            };
        }
        /** Parse the duration field; returns a number or an error message. */
        function parseDuration(text) {
            const trimmed = String(text).trim();
            if (!/^\d+$/.test(trimmed)) return { error: '最长持有时长必须是非负整数毫秒（0 表示一直持有）。' };
            const value = Number(trimmed);
            if (!Number.isSafeInteger(value)) return { error: '最长持有时长超出可表示范围。' };
            return { value };
        }
        /**
         * Create the page editor. Edits stage locally; Save submits one revision-fenced
         * atomic mutation so a concurrent change can never be overwritten silently.
         * @param form - the shared form for this plugin's Host entry.
         * @returns the editor control surface used by the React view.
         */
        function createEditor(form) {
            const listeners = new Set();
            let accepted = form.getSnapshot();
            let baseline;
            let resets = new Set();
            let unsubscribe;
            let active = false;
            let state = seed(accepted);
            /** Replace the state and notify subscribers. */
            function publish(next) {
                state = next;
                for (const listener of listeners) listener();
            }
            /** Adopt a newly accepted snapshot, or record a conflict over a draft. */
            function refresh() {
                accepted = form.getSnapshot();
                if (!state.dirty && !state.saving) {
                    baseline = undefined;
                    resets = new Set();
                    publish(seed(accepted));
                    return;
                }
                publish({
                    ...state,
                    status: accepted.status,
                    writable: accepted.writable,
                    conflict: accepted.revision !== baseline,
                });
            }
            /** Whether an edit is currently allowed. */
            function canEdit() {
                return active && state.status === 'ready' && state.writable && !state.saving;
            }
            /** Remember the revision the draft started from. */
            function begin() {
                if (!state.dirty) baseline = accepted.revision;
            }
            /** The operations a save would submit for the current draft. */
            function operations() {
                const ops = [];
                if (resets.has('strategy')) ops.push({ op: 'unset', path: ['strategy'] });
                else if (state.strategy !== seedField(accepted.value, 'strategy')) ops.push({ op: 'set', path: ['strategy'], value: state.strategy });
                for (const field of BOOLEANS) {
                    const key = field.key;
                    if (resets.has(key)) ops.push({ op: 'unset', path: [key] });
                    else if (state[key] !== seedField(accepted.value, key)) ops.push({ op: 'set', path: [key], value: state[key] });
                }
                if (resets.has(DURATION.key)) ops.push({ op: 'unset', path: [DURATION.key] });
                else {
                    const parsed = parseDuration(state.maxHoldMs);
                    if (parsed.error !== undefined) return { error: parsed.error };
                    if (parsed.value !== seedField(accepted.value, DURATION.key)) ops.push({ op: 'set', path: [DURATION.key], value: parsed.value });
                }
                return { ops };
            }
            return {
                getSnapshot: () => state,
                subscribe(listener) {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                },
                /** Subscribe to the Host form; the returned disposer ends the page's lifetime. */
                start() {
                    active = true;
                    unsubscribe?.();
                    unsubscribe = form.subscribe(refresh);
                    refresh();
                    return () => {
                        active = false;
                        unsubscribe?.();
                        unsubscribe = undefined;
                    };
                },
                /** Stage one field's value. */
                edit(field, value) {
                    if (!FIELDS.includes(field) || !canEdit()) return;
                    begin();
                    resets.delete(field);
                    publish({ ...state, [field]: value, dirty: true, error: '', conflict: false });
                },
                /** Drop the draft and re-read the accepted snapshot. */
                discard() {
                    baseline = undefined;
                    resets = new Set();
                    publish({ ...seed(accepted), status: accepted.status, writable: accepted.writable, revision: accepted.revision });
                },
                /** Restore the inherited value for every field; Save applies it. */
                reset() {
                    if (!canEdit()) return;
                    begin();
                    resets = new Set(FIELDS);
                    publish({ ...seed(accepted), status: state.status, writable: state.writable, revision: state.revision, dirty: true, resets: true });
                },
                /** Submit the staged edits as one revision-fenced mutation. */
                async save() {
                    if (!canEdit() || !state.dirty) return false;
                    const prepared = operations();
                    if (prepared.error !== undefined) {
                        publish({ ...state, error: prepared.error });
                        return false;
                    }
                    if (prepared.ops.length === 0) {
                        publish({ ...state, dirty: false, error: '' });
                        return true;
                    }
                    if (!Number.isSafeInteger(baseline) || state.conflict) {
                        publish({ ...state, conflict: true, error: '配置已在其他页面更新。草稿已保留；请先放弃草稿并重新读取，再编辑保存。' });
                        return false;
                    }
                    publish({ ...state, saving: true, error: '' });
                    try {
                        const ok = await form.mutate(prepared.ops, baseline);
                        if (!active) return ok;
                        if (ok) {
                            baseline = undefined;
                            resets = new Set();
                            accepted = form.getSnapshot();
                            publish(seed(accepted));
                        } else {
                            accepted = form.getSnapshot();
                            publish({
                                ...state,
                                saving: false,
                                conflict: accepted.revision !== baseline,
                                error: '保存未被接受，草稿已保留。若配置已更新，请放弃草稿后重新编辑。',
                            });
                        }
                        return ok;
                    } catch {
                        if (active) publish({ ...state, saving: false, error: '无法保存配置，草稿已保留。请检查连接后重试。' });
                        return false;
                    }
                },
            };
        }
        const styles = {
            root: { display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
            field: { display: 'grid', gap: 7 },
            label: { fontWeight: 600 },
            hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
            select: {
                boxSizing: 'border-box', width: '100%', padding: '8px 10px',
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
                color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
            },
            check: { display: 'flex', gap: 8, alignItems: 'center' },
            number: {
                boxSizing: 'border-box', width: '100%', padding: '8px 10px',
                border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
                color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)', font: 'inherit',
            },
            actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
            button: {
                padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
                color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
            },
            error: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.6 },
        };
        /** Short description shown on the plugin card while no editor is open. */
        const summary = '选择目标续行的实现方式（activation / replacement / native / off）与等待策略；保存即生效。';
        /** Service list Cordis activates before this bundle runs. */
        const inject = ['slots', 'configForms'];
        /**
         * Mount the configuration page on the shared platform React.
         * @param ctx - client context carrying the slot registry and settings service.
         */
        function apply(ctx) {
            const form = ctx.configForms.get(ROW_ID);
            const h = React.createElement;
            function EditorView({ configForm }) {
                const [instance] = React.useState(() => createEditor(configForm));
                React.useEffect(() => instance.start(), [instance]);
                const state = React.useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot);
                if (state.status !== 'ready') {
                    return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
                        ? '正在读取插件配置…'
                        : '此插件当前未提供可编辑配置。');
                }
                const disabled = !state.writable || state.saving;
                const chosen = STRATEGIES.find((item) => item.value === state.strategy) ?? STRATEGIES[0];
                function strategyField() {
                    const id = 'dsh-goal-wait-gate-strategy';
                    return h('div', { key: 'strategy', style: styles.field },
                        h('label', { htmlFor: id, style: styles.label }, '实现方式'),
                        h('select', {
                            id, style: styles.select, value: state.strategy, disabled,
                            'aria-describedby': id + '-hint',
                            onChange: (event) => instance.edit('strategy', event.target.value),
                        }, STRATEGIES.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
                        h('p', { id: id + '-hint', style: styles.hint }, chosen.hint));
                }
                function booleanField(field) {
                    const id = 'dsh-goal-wait-gate-' + field.key;
                    return h('div', { key: field.key, style: styles.field },
                        h('label', { style: styles.check, htmlFor: id },
                            h('input', {
                                id, type: 'checkbox', checked: state[field.key], disabled,
                                'aria-describedby': id + '-hint',
                                onChange: (event) => instance.edit(field.key, event.target.checked),
                            }),
                            h('span', { style: styles.label }, field.label)),
                        h('p', { id: id + '-hint', style: styles.hint }, field.hint));
                }
                function durationField() {
                    const id = 'dsh-goal-wait-gate-maxHoldMs';
                    return h('div', { key: 'maxHoldMs', style: styles.field },
                        h('label', { htmlFor: id, style: styles.label }, DURATION.label),
                        h('input', {
                            id, type: 'number', min: 0, step: 1, inputMode: 'numeric',
                            style: styles.number, value: state.maxHoldMs, disabled,
                            'aria-describedby': id + '-hint',
                            onChange: (event) => instance.edit('maxHoldMs', event.target.value),
                        }),
                        h('p', { id: id + '-hint', style: styles.hint }, DURATION.hint));
                }
                return h('form', {
                    style: styles.root,
                    'aria-label': '目标续行闸门设置',
                    'aria-busy': state.saving,
                    onSubmit: (event) => { event.preventDefault(); void instance.save(); },
                },
                !state.writable && h('p', { style: styles.hint, role: 'status' }, '当前连接或配置文档为只读。'),
                strategyField(),
                booleanField(BOOLEANS[0]),
                booleanField(BOOLEANS[1]),
                durationField(),
                h('p', { style: styles.hint }, '保存即生效：宿主把本行配置作为活值交给插件，策略切换会就地更换驱动，不需要重启。'),
                state.conflict && !state.error && h('p', { role: 'alert', style: styles.error }, '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。'),
                state.error && h('p', { role: 'alert', style: styles.error }, state.error),
                h('div', { style: styles.actions },
                    h('button', { type: 'submit', style: styles.button, disabled: disabled || !state.dirty || state.conflict }, state.saving ? '正在保存…' : '保存'),
                    h('button', { type: 'button', style: styles.button, disabled: state.saving || !state.dirty, onClick: () => instance.discard() }, '放弃草稿'),
                    h('button', { type: 'button', style: styles.button, disabled, onClick: () => instance.reset() }, '恢复默认（保存后生效）')));
            }
            function ConfigView(props) {
                return props.view === 'summary' ? summary : h(EditorView, { configForm: props.configForm });
            }
            ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
                name: 'plugins.row.config',
                key: BUNDLE_ID + '#' + ROW_ID,
                inject: () => ({ configForm: form }),
            }, ConfigView))), 'dsh-goal-wait-gate: configuration page');
        }
        // The shell reads named exports off the factory result, exactly like the
        // Harness' own client bundles, so the shape is an explicit namespace object.
        const exported = {};
        Object.defineProperty(exported, Symbol.toStringTag, { value: 'Module' });
        exported.inject = inject;
        exported.apply = apply;
        exported.createEditor = createEditor;
        exported.seedField = seedField;
        exported.parseDuration = parseDuration;
        exported.summary = summary;
        exported.ROW_ID = ROW_ID;
        exported.STRATEGIES = STRATEGIES;
        return exported;
    },
});
