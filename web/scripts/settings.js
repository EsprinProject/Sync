/* 设置视图：左侧分类导航与右侧面板。分类在桌面版基础上只留浏览器能落地的那几类：
   不含系统与托盘（托盘、常驻后台、开机自启）、更新与版本（应用自更新）、数据存放位置
   （浏览器不允许自选存储目录，本地副本已经存在 IndexedDB 里），也不提供字体定制。 */

// 分类与分区命名对齐桌面版（系统级项目在浏览器里没有对应能力）
const SETTINGS_CATEGORIES = [
    { id: 'editor', label: '编辑器', icon: 'edit_note' },
    { id: 'appearance', label: '外观', icon: 'palette' },
    { id: 'ai', label: 'AI 助手', icon: 'chat_bubble' },
    { id: 'secret', label: '秘密本', icon: 'lock' },
    { id: 'data', label: '数据与同步', icon: 'folder' },
    { id: 'system', label: '系统', icon: 'info' }
];

const ACCENT_PRESETS = ['', '#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#db61a2', '#39c5cf'];

// 圆角尺度的四档：与 styles/radius.css 的 data-radius 取值一一对应
const RADIUS_STEPS = [
    { value: 'square', label: '纯方' },
    { value: 'slight', label: '微圆角' },
    { value: 'default', label: '默认' },
    { value: 'large', label: '大圆' }
];

// 缩放比例的五档：与桌面版同一套取值（小 80% / 中 90% / 默认 100% / 大 110% / 超大 120%）
const UI_SCALE_STEPS = [
    { value: 0.8, label: '小', ratio: '80%' },
    { value: 0.9, label: '中', ratio: '90%' },
    { value: 1, label: '默认', ratio: '100%' },
    { value: 1.1, label: '大', ratio: '110%' },
    { value: 1.2, label: '超大', ratio: '120%' }
];

let activeSettingsCategory = SETTINGS_CATEGORIES[0].id;

// 窄屏下设置是两级：分类列表（false）↔ 某个分类的面板（true）。桌面端两栏并排，这个标记不参与排版
let settingsSubpageOpen = false;

// 切层级只改 #settings-view 上的类名，不重建面板：面板里可能有正在填的内容与状态
function setSettingsSubpageOpen(open) {
    settingsSubpageOpen = !!open;
    const view = document.getElementById('settings-view');
    if (view) view.classList.toggle('is-subpage', settingsSubpageOpen);
}

function categoryLabel(id, fallback) {
    /* 分类名：本地模式（页面不由 EsprinSync 托管）里没有同步，「数据与同步」那一格就叫「数据与存储」 */
    if (id === 'data' && !Sync.supportsSync()) return '数据与存储';
    return fallback;
}

function renderSettingsNav() {
    const nav = document.getElementById('settings-nav');
    nav.innerHTML = '';
    SETTINGS_CATEGORIES.forEach((category) => {
        const entry = document.createElement('button');
        entry.type = 'button';
        entry.className = `nav-item settings-nav-item ${category.id === activeSettingsCategory ? 'active' : ''}`;
        entry.innerHTML = `
            <div class="nav-item-left">
                <span class="ms-icon sm">${category.icon}</span>
                <span>${categoryLabel(category.id, category.label)}</span>
            </div>
            <span class="ms-icon sm settings-nav-chevron">chevron_right</span>
        `;
        entry.onclick = () => {
            activeSettingsCategory = category.id;
            // 窄屏下点分类即进入第二级；桌面端这一个类名不参与排版
            setSettingsSubpageOpen(true);
            renderSettingsView();
        };
        nav.appendChild(entry);
    });
}

function renderSettingsView() {
    renderSettingsNav();
    const content = document.getElementById('settings-content');
    const category = SETTINGS_CATEGORIES.find((item) => item.id === activeSettingsCategory) || SETTINGS_CATEGORIES[0];

    if (category.id === 'appearance') content.innerHTML = appearancePanelHTML();
    else if (category.id === 'editor') content.innerHTML = editorPanelHTML();
    else if (category.id === 'ai') content.innerHTML = aiPanelHTML();
    else if (category.id === 'secret') content.innerHTML = secretPanelHTML();
    else if (category.id === 'data') content.innerHTML = dataPanelHTML();
    else content.innerHTML = systemPanelHTML();

    if (category.id === 'appearance') bindAppearancePanel();
    if (category.id === 'editor') bindEditorPanel();
    if (category.id === 'ai') bindAiPanel();
    if (category.id === 'secret') bindSecretPanel();
    if (category.id === 'data') bindDataPanel();

    // 窄屏的两级：类名跟着标记补回来（标记本身只由入口与返回键改），
    // 顶端那条导航栏里写的是当前分类，左边那枚回到分类列表
    setSettingsSubpageOpen(settingsSubpageOpen);
    const crumbIcon = document.getElementById('settings-crumb-icon');
    const crumbText = document.getElementById('settings-crumb-text');
    if (crumbIcon) crumbIcon.textContent = category.icon;
    if (crumbText) crumbText.textContent = categoryLabel(category.id, category.label);
    const crumb = document.getElementById('btn-settings-crumb');
    if (crumb) crumb.onclick = () => setSettingsSubpageOpen(false);

    // 面板里的原生下拉同样升级成自绘菜单（bindCustomSelect 自带幂等判定）
    initCustomSelects();
    syncUiModeUI();
}

function panelHeader(title, desc, icon) {
    return `
        <div class="settings-header">
            <div class="settings-title">
                <span class="ms-icon md">${icon}</span>
                <span>${title}</span>
            </div>
            <div class="settings-desc">${desc}</div>
        </div>
    `;
}

/* ---------------- 外观 ---------------- */

function radiusSliderHTML() {
    const index = Math.max(0, RADIUS_STEPS.findIndex((step) => step.value === State.cornerRadius));
    return `
        <div class="settings-slider" id="setting-radius-slider">
            <div class="slider-track">
                <div class="slider-fill"></div>
                <div class="slider-thumb"></div>
                <input type="range" class="slider-range" min="0" max="${RADIUS_STEPS.length - 1}" step="1" value="${index}"
                    aria-label="圆角尺度" title="拖动选择圆角尺度">
            </div>
            <div class="slider-ticks">
                ${RADIUS_STEPS.map((step, i) => `<button type="button" class="slider-tick ${i === index ? 'active' : ''}" data-index="${i}">${step.label}</button>`).join('')}
            </div>
        </div>
    `;
}

function appearancePanelHTML() {
    const swatches = ACCENT_PRESETS.map((color) => {
        const selected = (State.accentColor || '') === color;
        const label = color ? color : '跟随主题';
        return `<button type="button" class="accent-swatch ${color ? '' : 'accent-swatch-default'} ${selected ? 'selected' : ''}"
                    data-accent="${color}" title="${label}"
                    ${color ? `style="--swatch-color: ${color}"` : ''}></button>`;
    }).join('');

    return `
        ${panelHeader('外观', '界面布局、缩放、主题与主题色，改动立即生效并保存在本浏览器', 'palette')}
        <div class="settings-section">
            <div class="settings-section-title">界面</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">布局风格</span>
                    <span class="settings-row-desc">现代布局不排标题栏，标签页移到工作区顶部、入口悬浮到右上角；经典布局保留标题栏与标签栏</span>
                </div>
                <select class="settings-select" id="setting-ui-mode">
                    <option value="modern">现代布局</option>
                    <option value="classic">经典布局</option>
                </select>
            </div>
            <div class="settings-row settings-row-modern-only">
                <div class="settings-row-info">
                    <span class="settings-row-label">禁用标签页</span>
                    <span class="settings-row-desc">仅现代布局：收起整条标签栏，内容直达窗口上沿；标签状态不会丢失，关闭开关即恢复</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-tabs-disabled" ${State.tabsDisabled ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">缩放比例<span class="settings-value" id="ui-scale-value">100%</span>
                        <button type="button" class="settings-inline-toggle" id="btn-ui-scale-custom-toggle"
                                aria-expanded="false" aria-controls="ui-scale-custom-row" title="输入五档之外的比例">自定义</button>
                    </span>
                    <span class="settings-row-desc">按比例缩放整张界面（浏览器里落在根元素的 CSS 缩放上，与桌面版的窗口缩放同档），修改后立即生效</span>
                </div>
                ${uiScaleSliderHTML()}
            </div>
            <div class="settings-row settings-row-sub hidden" id="ui-scale-custom-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">自定义比例</span>
                    <span class="settings-row-desc">填写 ${Math.round(UI_SCALE_MIN * 100)} ~ ${Math.round(UI_SCALE_MAX * 100)} 的整数百分比，回车或点「应用」生效；生效后弹窗确认是否保留，点「回到默认」则恢复为默认的 100%</span>
                </div>
                <div class="settings-scale-custom">
                    <input type="text" class="settings-number-input" id="ui-scale-custom" inputmode="numeric"
                           maxlength="3" placeholder="50 ~ 200" spellcheck="false" aria-label="自定义缩放比例（百分比）">
                    <span class="settings-number-suffix">%</span>
                    <button class="settings-btn primary" type="button" id="btn-ui-scale-custom">应用</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">圆角尺度</span>
                    <span class="settings-row-desc">影响按钮、卡片、输入框与浮层，并与主题风格叠加</span>
                </div>
                ${radiusSliderHTML()}
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">侧边栏默认收起</span>
                    <span class="settings-row-desc">收起后只保留一条窄条，筛选入口仅显示图标</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-sidebar-collapsed" ${State.sidebarCollapsed ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">主题</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">明暗模式</span>
                    <span class="settings-row-desc">跟随系统时按操作系统的深浅色偏好自动切换</span>
                </div>
                <select class="settings-select" id="setting-theme">
                    <option value="system">跟随系统</option>
                    <option value="dark">深色</option>
                    <option value="light">浅色</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">界面风格</span>
                    <span class="settings-row-desc">默认配色，或 Alom 风格（柔和投影、更大圆角与半透明材质）</span>
                </div>
                <select class="settings-select" id="setting-theme-style">
                    <option value="default">默认</option>
                    <option value="alom">Alom 风格</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">左上角应用名</span>
                    <span class="settings-row-desc">左上角「EsprinNemo」的文字颜色</span>
                </div>
                <select class="settings-select" id="setting-brand-color">
                    <option value="brand">品牌色</option>
                    <option value="mono">跟随明暗（黑白）</option>
                    <option value="accent">跟随主题色</option>
                </select>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">主题色</div>
            <div class="accent-swatches">${swatches}</div>
            <div class="accent-custom">
                <input type="color" class="accent-color-input" id="setting-accent-picker" value="${State.accentColor || '#58a6ff'}">
                <input type="text" class="accent-hex-input" id="setting-accent-hex" maxlength="7" placeholder="#RRGGBB" value="${escapeHTML(State.accentColor)}">
                <span class="accent-custom-hint">自定义颜色按十六进制填写，留空表示跟随主题</span>
                <button class="settings-btn" type="button" id="setting-accent-reset">跟随主题</button>
            </div>
        </div>

    `;
}

/* 自绘滑块：轨道左侧已选部分用主题色填充，档位文字可点选。
   拖动时取消补间保持跟手，松手吸附到最近档位（步长 1 已经是档位）。 */
function setSliderPosition(container, index, count = RADIUS_STEPS.length) {
    const ratio = count > 1 ? index / (count - 1) : 0;
    container.style.setProperty('--slider-pos', String(ratio));
    container.style.setProperty('--slider-fill', `${ratio * 100}%`);
}

/* 缩放比例（界面尺寸）：浏览器里落在根元素的 CSS 缩放上（取值整理在 boot.js）。
   五档之外的尺寸走折叠着的「自定义比例」那一行。 */
function uiScaleSliderHTML() {
    const current = normalizeUiScale(State.uiScale);
    const index = nearestUiScaleStopIndex(current);
    return `
        <div class="settings-slider" id="setting-ui-scale-slider">
            <div class="slider-track">
                <div class="slider-fill"></div>
                <div class="slider-thumb"></div>
                <input type="range" class="slider-range" min="0" max="${UI_SCALE_STEPS.length - 1}" step="1" value="${index}"
                    aria-label="缩放比例" title="拖动选择缩放比例">
            </div>
            <div class="slider-ticks">
                ${UI_SCALE_STEPS.map((step, i) => `<button type="button" class="slider-tick ${i === index ? 'active' : ''}" data-index="${i}">${step.label}<span class="slider-tick-value">${step.ratio}</span></button>`).join('')}
            </div>
        </div>
    `;
}

// 离当前值最近的档位下标：整档自然是自己，自定义比例就近落位
function nearestUiScaleStopIndex(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STEPS.reduce((best, step, index) => (
        Math.abs(step.value - current) < Math.abs(UI_SCALE_STEPS[best].value - current) ? index : best
    ), 0);
}

// 当前值是否正好落在某个整档上（自定义比例不算）
function isUiScaleStop(value) {
    const current = normalizeUiScale(value);
    return UI_SCALE_STEPS.some((step) => Math.abs(step.value - current) < 0.0001);
}

// 行内百分比徽标与自定义输入框按当前值刷新；滑块本身只在拖动时动，这里不重建控件
function syncUiScaleReadout() {
    const current = normalizeUiScale(State.uiScale);
    const readout = document.getElementById('ui-scale-value');
    if (readout) readout.textContent = `${Math.round(current * 100)}%`;
    const input = document.getElementById('ui-scale-custom');
    // 用户正在里面输入时不动它：同步也可能由别处触发
    if (input && document.activeElement !== input) {
        input.value = isUiScaleStop(current) ? '' : String(Math.round(current * 100));
    }
    // 不在整档上（自定义比例）时展开输入行，否则用户看不到自己设的值
    if (!isUiScaleStop(current)) setUiScaleCustomOpen(true);
}

function bindUiScaleSlider() {
    const container = document.getElementById('setting-ui-scale-slider');
    if (!container) return;
    const range = container.querySelector('.slider-range');
    const ticks = Array.from(container.querySelectorAll('.slider-tick'));

    const applyIndex = (index, persist) => {
        const step = UI_SCALE_STEPS[Math.max(0, Math.min(UI_SCALE_STEPS.length - 1, index))];
        ticks.forEach((tick, i) => tick.classList.toggle('active', i === index));
        setSliderPosition(container, index, UI_SCALE_STEPS.length);
        State.uiScale = step.value;
        applyUiScale();
        syncUiScaleReadout();
        if (persist) saveConfig();
    };

    setSliderPosition(container, Number(range.value), UI_SCALE_STEPS.length);
    range.addEventListener('input', () => {
        container.classList.add('is-dragging');
        applyIndex(Number(range.value), false);
    });
    range.addEventListener('change', () => {
        container.classList.remove('is-dragging');
        applyIndex(Number(range.value), true);
    });
    ticks.forEach((tick, index) => {
        tick.onclick = () => {
            range.value = String(index);
            applyIndex(index, true);
        };
    });
}

/* 自定义比例：平时收在「缩放比例」那一行的「自定义」按钮后面，点开才展开输入行；
   当前值不在整档上（配置里存着 113% 这类尺寸）时默认展开。展开状态不落盘。 */
function setUiScaleCustomOpen(open) {
    const row = document.getElementById('ui-scale-custom-row');
    if (row) row.classList.toggle('hidden', !open);
    const toggle = document.getElementById('btn-ui-scale-custom-toggle');
    if (toggle) {
        toggle.classList.toggle('active', !!open);
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
}

function toggleUiScaleCustomRow() {
    const row = document.getElementById('ui-scale-custom-row');
    const open = !!row && row.classList.contains('hidden');
    setUiScaleCustomOpen(open);
    if (open) {
        const input = document.getElementById('ui-scale-custom');
        if (input) input.focus();
    }
}

/* 自定义比例：先把输入值套到界面上（能直接看到效果），再弹窗问是否保留；
   点「保持」才写进配置，点「回到默认」或十秒内没有回应都回到默认的 100%——
   自定义比例是五档之外的尺寸，回退时按默认处理最不容易让人找不回原样。 */
async function commitCustomUiScale() {
    const el = document.getElementById('ui-scale-custom');
    if (!el) return;
    const min = Math.round(UI_SCALE_MIN * 100);
    const max = Math.round(UI_SCALE_MAX * 100);

    const text = el.value.trim();
    const raw = Number(text);
    if (!text || !Number.isFinite(raw)) {
        showToast(`请输入 ${min} ~ ${max} 之间的数字`);
        el.value = isUiScaleStop(State.uiScale) ? '' : String(Math.round(normalizeUiScale(State.uiScale) * 100));
        return;
    }

    // 夹到范围内并取整：输入 320 按 200% 处理，输入 133.6 按 134% 处理
    const percent = Math.min(Math.max(Math.round(raw), min), max);
    el.value = String(percent);

    if (percent === Math.round(normalizeUiScale(State.uiScale) * 100)) {
        setUiScale(percent / 100);
        return;
    }

    State.uiScale = percent / 100;
    applyUiScale();
    syncUiScaleReadout();

    const keep = await showConfirm(`保留缩放比例 ${percent}%？`, {
        title: '保持更改',
        detail: `界面已按 ${percent}% 缩放。\n`
            + `· 点「保持」：沿用 ${percent}%；\n`
            + `· 点「回到默认」：恢复为默认的 100%。`,
        icon: 'zoom_in',
        confirmLabel: '保持',
        cancelLabel: '回到默认'
    });

    if (keep) {
        setUiScale(percent / 100);
        el.value = isUiScaleStop(percent / 100) ? '' : String(percent);
        showToast(`缩放比例已设为 ${percent}%`);
        return;
    }
    setUiScale(UI_SCALE_DEFAULT);
    el.value = '';
    showToast('缩放比例已恢复为默认 100%');
}

// 自定义比例输入框：回车与「应用」都能提交，输入期间只保留数字
function initUiScaleCustomInput() {
    const el = document.getElementById('ui-scale-custom');
    const button = document.getElementById('btn-ui-scale-custom');
    if (el) {
        el.oninput = () => {
            const digits = el.value.replace(/[^0-9]/g, '').slice(0, 3);
            if (digits !== el.value) el.value = digits;
        };
        el.onkeydown = (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commitCustomUiScale();
        };
    }
    if (button) button.onclick = () => commitCustomUiScale();
    const toggle = document.getElementById('btn-ui-scale-custom-toggle');
    if (toggle) toggle.onclick = () => toggleUiScaleCustomRow();
}

function bindRadiusSlider() {
    const container = document.getElementById('setting-radius-slider');
    if (!container) return;
    const range = container.querySelector('.slider-range');
    const ticks = Array.from(container.querySelectorAll('.slider-tick'));

    const applyIndex = (index, persist) => {
        const step = RADIUS_STEPS[Math.max(0, Math.min(RADIUS_STEPS.length - 1, index))];
        ticks.forEach((tick, i) => tick.classList.toggle('active', i === index));
        setSliderPosition(container, index);
        applyCornerRadius(step.value);
        if (persist) saveConfig();
    };

    setSliderPosition(container, Number(range.value));
    range.addEventListener('input', () => {
        container.classList.add('is-dragging');
        applyIndex(Number(range.value), false);
    });
    range.addEventListener('change', () => {
        container.classList.remove('is-dragging');
        applyIndex(Number(range.value), true);
    });
    ticks.forEach((tick, index) => {
        tick.onclick = () => {
            range.value = String(index);
            applyIndex(index, true);
        };
    });
}

function bindAppearancePanel() {
    const theme = document.getElementById('setting-theme');
    theme.value = State.theme;
    theme.onchange = () => setTheme(theme.value);

    const style = document.getElementById('setting-theme-style');
    style.value = normalizeThemeStyle(State.themeStyle);
    style.onchange = () => setThemeStyle(style.value);

    const brand = document.getElementById('setting-brand-color');
    brand.value = State.brandColor;
    brand.onchange = () => setBrandColor(brand.value);

    const uiMode = document.getElementById('setting-ui-mode');
    uiMode.value = normalizeUiMode(State.uiMode);
    uiMode.onchange = () => toggleUiMode(uiMode.value);

    const tabsDisabled = document.getElementById('setting-tabs-disabled');
    tabsDisabled.onchange = () => toggleTabsDisabled(tabsDisabled.checked);

    bindRadiusSlider();
    // 缩放比例：滑块、自定义输入行与行内徽标都按当前值初始化一次
    bindUiScaleSlider();
    initUiScaleCustomInput();
    syncUiScaleReadout();

    const collapsed = document.getElementById('setting-sidebar-collapsed');
    collapsed.onchange = () => {
        State.sidebarCollapsed = collapsed.checked;
        applySidebarCollapsed(true);
        saveConfig();
    };

    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
        swatch.onclick = () => setAccentColor(swatch.dataset.accent || '');
    });

    const picker = document.getElementById('setting-accent-picker');
    const hex = document.getElementById('setting-accent-hex');
    picker.oninput = () => {
        setAccentColor(picker.value, false);
        hex.value = State.accentColor;
    };
    hex.onchange = () => {
        setAccentColor(hex.value, false);
        if (State.accentColor) picker.value = State.accentColor;
    };
    document.getElementById('setting-accent-reset').onclick = () => setAccentColor('');

    // 同步刷新下拉的自绘触发器
    CUSTOM_SELECTS.forEach((entry) => {
        if ([theme, style, brand, uiMode].includes(entry.select)) refreshCustomSelect(entry);
    });
}

// 不重建面板的前提下同步色板选中态与两个输入框的值
function syncAccentSelection() {
    document.querySelectorAll('.accent-swatch').forEach((swatch) => {
        swatch.classList.toggle('selected', (State.accentColor || '') === (swatch.dataset.accent || ''));
    });
    const hex = document.getElementById('setting-accent-hex');
    if (hex && State.accentColor) hex.value = State.accentColor;
}

/* ---------------- 编辑器 ---------------- */

function editorPanelHTML() {
    return `
        ${panelHeader('编辑器', '编辑与预览的行为设置', 'edit_note')}
        <div class="settings-section">
            <div class="settings-section-title">编辑器与文本</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">拼写检查</span>
                    <span class="settings-row-desc">打开后浏览器会对正文内容做拼写检查（仅对本次会话生效）</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-spellcheck" ${State.spellcheck ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">默认视图</span>
                    <span class="settings-row-desc">打开条目时的初始视图，可在编辑区顶栏随时切换</span>
                </div>
                <select class="settings-select" id="setting-view-mode">
                    <option value="edit">编辑</option>
                    <option value="split">分屏</option>
                    <option value="preview">预览</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">废纸篓自动清理</span>
                    <span class="settings-row-desc">依据最后一次编辑时间清理废纸篓内容，0 表示永不自动清理</span>
                </div>
                <select class="settings-select" id="setting-trash-retention">
                    <option value="0">永不清理</option>
                    <option value="10">保留 10 天</option>
                    <option value="30">保留 30 天</option>
                    <option value="60">保留 60 天</option>
                    <option value="365">保留 365 天</option>
                </select>
            </div>
        </div>
    `;
}

function bindEditorPanel() {
    const spellcheck = document.getElementById('setting-spellcheck');
    spellcheck.onchange = () => {
        State.spellcheck = spellcheck.checked;
        document.getElementById('textarea-note-content').spellcheck = State.spellcheck;
        saveConfig();
    };

    const viewMode = document.getElementById('setting-view-mode');
    viewMode.value = State.viewMode;
    viewMode.onchange = () => setViewMode(viewMode.value);

    const retention = document.getElementById('setting-trash-retention');
    retention.value = String(State.trashRetentionDays);
    retention.onchange = () => {
        State.trashRetentionDays = Number(retention.value) || 0;
        saveConfig();
        const removed = purgeExpiredTrashItems();
        if (removed > 0) {
            renderApp();
            showToast(`已清理 ${removed} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
        } else {
            showToast('自动清理设置已保存');
        }
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if ([viewMode, retention].includes(entry.select)) refreshCustomSelect(entry);
    });
}

/* ---------------- 秘密本 ----------------
   条目列表由 scripts/secret.js 的 syncSecretSettingsUI 渲染（本面板每次重建都会重列一次） */

function secretPanelHTML() {
    return `
        ${panelHeader('秘密本', '隐藏或已加密的文档：隐藏的条目不进任何列表、搜索与 AI 提问范围，只能在这里找到', 'lock')}
        <div class="settings-section">
            <div class="settings-section-title">隐藏与加密的文档</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">秘密本</span>
                    <span class="settings-row-desc">在列表中右键一篇笔记或待办即可隐藏或设置密码。设置密码的条目正文以 AES-256-GCM 加密后落盘（浏览器里由页面自己完成加解密，口令不上传也不保存），打开时需输入密码；标题、文件夹、标签与时间等元数据保持明文。密码无法找回，忘记后正文无法恢复</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="btn-secret-refresh" title="重新扫描隐藏与加密状态">刷新</button>
                </div>
            </div>
            <div class="secret-list" id="secret-list"></div>
            <div class="settings-row-desc sync-status" id="secret-status">正在读取隐藏与加密状态…</div>
        </div>
    `;
}

/* ---------------- 数据与同步 ---------------- */

function dataPanelHTML() {
    const noteCount = State.notes.length;
    const todoCount = State.todos.length;
    const bytes = [...FileStore.memory.entries()]
        .filter(([path]) => path.startsWith('notes/') || path.startsWith('todos/'))
        .reduce((total, [, text]) => total + utf8Bytes(text).length, 0);

    // 本地模式（页面不由 EsprinSync 托管）里没有自建同步这回事：这一整节都不排出来
    const syncSection = Sync.supportsSync() ? `
        <div class="settings-section">
            <div class="settings-section-title">服务器与同步</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">连接状态</span>
                    <span class="settings-hint" id="data-sync-status"></span>
                </div>
                <div class="settings-path" id="data-sync-url"></div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">账户</span>
                    <span class="settings-row-desc">服务端上的账户决定看到哪一份笔记与待办；本地副本、待推送队列与同步位置都按账户各存一份。换账户请先退出登录：上一个账户的条目会从界面上清掉（重新登录后还在），不至于把它的内容推到下一个账户里</span>
                </div>
                <div class="settings-path" id="data-sync-account"></div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">自动同步</span>
                    <span class="settings-row-desc">到点自动执行「拉取 → 重放 → 推送」；本地改动在编辑停止后仍会立即推送</span>
                </div>
                <div class="row-controls">
                    <select class="settings-select" id="data-sync-auto">
                        <option value="off">关闭</option>
                        <option value="5s">每 5 秒</option>
                        <option value="1m">每 1 分钟</option>
                        <option value="5m">每 5 分钟</option>
                        <option value="startup">每次启动时</option>
                        <option value="custom">自定义</option>
                    </select>
                    <input class="settings-input mono short" id="data-sync-seconds" type="number" min="5"
                        value="${Number(State.sync.autoSyncSeconds) || 60}" title="自定义间隔（秒）">
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">同步操作</span>
                    <span class="settings-row-desc">登录、立即同步或退出登录；未登录时无法读写服务端，退出后需重新登录（可以换另一个账户）才能继续使用</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-sync-login">登录 / 填写令牌</button>
                    <button class="settings-btn" type="button" id="data-sync-now">立即同步</button>
                    <button class="settings-btn danger" type="button" id="data-sync-logout">退出登录</button>
                </div>
            </div>
        </div>
    ` : '';

    return `
        ${panelHeader(categoryLabel('data', '数据与同步'), Sync.supportsSync()
            ? '本地只保留一份副本（缓存）用于离线阅读与加速启动；连接服务端后，内容的权威副本在 EsprinSync 上'
            : '笔记与待办只存在本浏览器，离线可用；导出备份可以把全部内容带走', 'folder')}
        ${syncSection}
        <div class="settings-section">
            <div class="settings-section-title">数据与存储</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">本地副本</span>
                    <span class="settings-row-desc">笔记 ${noteCount} 篇 · 待办 ${todoCount} 项 · 约 ${(bytes / 1024).toFixed(1)} KB</span>
                </div>
                <div class="settings-path" id="data-summary">存储方式：${FileStore.mode === 'idb' ? 'IndexedDB' : 'localStorage'}</div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">导出备份</span>
                    <span class="settings-row-desc">导出全部条目（含文件夹、标签、置顶与废纸篓状态）为一份 JSON 文件</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-export-backup">导出 JSON 备份</button>
                    <button class="settings-btn" type="button" id="data-export-markdown">导出全部为 Markdown</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">导入备份</span>
                    <span class="settings-row-desc">读取此前导出的 JSON 备份，与现有条目合并；id 冲突的条目会分配新 id</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="data-import-backup">选择备份文件</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">清空本地副本</span>
                    <span class="settings-row-desc">删除本浏览器内的副本并清空待推送队列。已连接到服务端时，下次同步会把服务器上的内容重新拉回来</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn danger" type="button" id="data-clear">清空本地副本</button>
                </div>
            </div>
        </div>
    `;
}

function bindDataPanel() {
    document.getElementById('data-export-backup').onclick = () => {
        flushPendingSave();
        const backup = exportBackup();
        downloadText(`esprinnemo-backup-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(backup, null, 2), 'application/json');
        showToast('备份已导出');
    };

    document.getElementById('data-export-markdown').onclick = () => {
        flushPendingSave();
        const parts = [];
        [...State.notes, ...State.todos].forEach((item) => {
            const heading = `# ${itemDisplayTitle(item)}`;
            const meta = isTodoItem(item)
                ? `> 待办 · 文件夹：${item.folder}${item.isDone ? ' · 已完成' : ''}`
                : `> 笔记 · 文件夹：${item.folder}`;
            parts.push(`${heading}\n\n${meta}\n\n${item.content || ''}\n`);
        });
        downloadText(`esprinnemo-${new Date().toISOString().slice(0, 10)}.md`, parts.join('\n---\n\n'));
        showToast('已导出为 Markdown');
    };

    document.getElementById('data-import-backup').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.display = 'none';
        input.addEventListener('change', async () => {
            const file = input.files && input.files[0];
            input.remove();
            if (!file) return;
            try {
                const parsed = JSON.parse(await file.text());
                const imported = importBackup(parsed);
                if (!imported) {
                    showToast('导入失败：备份里没有可识别的条目');
                    return;
                }
                saveConfig();
                renderApp();
                showToast(`已导入 ${imported} 条`);
            } catch (error) {
                console.error(`[ERROR] [Backup] 备份解析失败 (file=${file.name}, detail=${error && error.message})`);
                showToast('导入失败：备份文件不是有效的 JSON');
            }
        });
        document.body.appendChild(input);
        input.click();
    };

    document.getElementById('data-clear').onclick = async () => {
        const confirmed = await showConfirm('清空本浏览器内的副本？', {
            title: '清空本地副本',
            detail: '本浏览器内当前账户的全部笔记与待办都会被删除，此操作无法撤销（其他账户的副本不受影响）。'
                + '已连接到服务端时，服务器上的内容不受影响，下次同步会重新拉回来；'
                + '仍然排队的本地改动会一并丢弃。',
            type: 'warning',
            icon: 'delete_forever',
            confirmLabel: '清空',
            danger: true
        });
        if (!confirmed) return;
        await clearAllData();
        renderApp();
        renderSettingsView();
        showToast('本地副本已清空');
    };

    bindDataSyncPanel();
}

/* 服务端连接：状态行、地址、自动同步节奏与三个操作按钮。
   登录走既有的连接层（同源管理密码会话，或改用访问令牌），与启动时的行为一致。 */
function bindDataSyncPanel() {
    const status = document.getElementById('data-sync-status');
    if (status) {
        const online = State.sync.enabled && Sync.connection === 'ready';
        const local = Sync.connection === 'local';
        const detail = Sync.connectionMessage || Sync.lastError || '';
        status.textContent = online
            ? `已连接：${Sync.outbox.length ? `${Sync.outbox.length} 条改动待推送` : '本地与服务器已同步'}`
                + `${State.sync.lastSyncAt ? `；上次同步 ${formatDateTime(State.sync.lastSyncAt)}` : ''}`
            : local
                ? `本地模式：${detail || '本页不由 EsprinSync 托管'}，笔记与待办只存在本浏览器`
                : (detail ? `未连接：${detail}` : '未连接：请先登录或填写访问令牌');
        status.classList.toggle('is-error', !online && !local && !!detail);
    }

    const account = document.getElementById('data-sync-account');
    if (account) {
        account.textContent = State.sync.account
            ? `当前账户：${State.sync.account}${State.sync.token ? '（访问令牌）' : ''}`
            : '未登录';
    }

    const url = document.getElementById('data-sync-url');
    if (url) {
        const base = Sync.baseUrl();
        url.textContent = base ? `${base}${SYNC_PATH}` : '本页不由 EsprinSync 托管，没有同步接口';
    }

    const auto = document.getElementById('data-sync-auto');
    // 本地模式（页面不由 EsprinSync 托管）里这一节整段不排出来（见 dataPanelHTML）：到这儿就收工
    if (!auto) return;
    const seconds = document.getElementById('data-sync-seconds');
    auto.value = State.sync.autoSync;
    const syncSecondsDisabled = () => {
        seconds.disabled = State.sync.autoSync !== 'custom';
        seconds.style.opacity = seconds.disabled ? '0.45' : '';
    };
    syncSecondsDisabled();

    auto.onchange = () => {
        State.sync.autoSync = auto.value;
        saveConfig();
        syncSecondsDisabled();
        Sync.applyAutoSyncRuntime();
        showToast('自动同步设置已保存');
    };
    seconds.onchange = () => {
        State.sync.autoSyncSeconds = Math.max(5, Number(seconds.value) || 60);
        seconds.value = String(State.sync.autoSyncSeconds);
        saveConfig();
        Sync.applyAutoSyncRuntime();
    };

    document.getElementById('data-sync-login').onclick = () => showConnectGate();
    document.getElementById('data-sync-now').onclick = async () => {
        if (!State.sync.enabled) {
            showConnectGate('尚未连接服务端，请先登录或填写访问令牌');
            return;
        }
        const result = await Sync.syncNow({ reason: '手动' });
        showToast(result.ok ? `同步完成：${result.summary}` : `同步失败：${result.error}`);
        renderSyncIndicator();
        renderSettingsView();
    };
    document.getElementById('data-sync-logout').onclick = async () => {
        const confirmed = await showConfirm('退出登录？', {
            title: '退出登录',
            detail: '退出后界面上的本地副本会清空并回到连接层，服务器的内容不受影响；'
                + '已排队的改动会留在本账户的队列里，重新登录后再上传，也可以直接登录另一个账户。',
            type: 'warning',
            icon: 'logout',
            confirmLabel: '退出',
            danger: true
        });
        if (!confirmed) return;
        await Sync.logout();
        renderSettingsView();
        // 凭据一律必需：退出之后立刻回到连接层，不允许在未登录状态下继续用界面
        showConnectGate('已退出登录：请重新登录，或换成另一个账户');
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if (entry.select === auto) refreshCustomSelect(entry);
    });
}

/* ---------------- AI 助手 ----------------
   桌面版把 API Key 交给系统密钥链、请求由主进程代理；网页版只能由页面直连站点，
   密钥保存在本浏览器里，且可能受站点的 CORS 策略限制——面板里把这几点写清楚。 */

const AI_QUICK_SITES = [
    { label: 'DeepSeek', url: 'https://api.deepseek.com' },
    { label: 'Ollama', url: 'http://localhost:11434' }
];

function aiPanelHTML() {
    return `
        ${panelHeader('AI 助手', '填写兼容 OpenAI 协议的站点、密钥与模型即可使用问答面板', 'chat_bubble')}
        <div class="settings-section">
            <div class="settings-section-title">总开关</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">启用 AI 助手</span>
                    <span class="settings-row-desc">关闭后标题栏入口与对话面板一并隐藏，不再发起任何请求，配置保留</span>
                </div>
                <label class="switch">
                    <input type="checkbox" id="setting-ai-enabled" ${isAiEnabled() ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
            </div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">接口配置</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">API 站点</span>
                    <span class="settings-row-desc">兼容 OpenAI 协议的站点地址；带 /v1 或不带都可以</span>
                </div>
                <div class="ai-input-stack">
                    <input class="settings-input mono" id="setting-ai-base-url" value="${escapeHTML(State.ai.baseUrl)}"
                        placeholder="https://api.deepseek.com" spellcheck="false">
                    <div class="ai-quick-fill">
                        <span class="ai-quick-fill-label">快捷填入</span>
                        ${AI_QUICK_SITES.map((site) => `<button class="ai-quick-chip" type="button" data-ai-site="${site.url}">${site.label}</button>`).join('')}
                    </div>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">API Key</span>
                    <span class="settings-row-desc">保存在本浏览器（localStorage），共享这台浏览器即等于共享密钥；本地站点留空即可</span>
                </div>
                <input class="settings-input mono" id="setting-ai-key" type="password" autocomplete="off"
                    value="${escapeHTML(State.ai.apiKey)}" placeholder="sk-…" spellcheck="false">
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">模型</span>
                    <span class="settings-row-desc">例如 deepseek-chat、qwen2.5、llama3.1</span>
                </div>
                <div class="ai-input-group">
                    <input class="settings-input mono" id="setting-ai-model" list="ai-model-options"
                        value="${escapeHTML(State.ai.model)}" placeholder="模型名称" spellcheck="false">
                    <datalist id="ai-model-options"></datalist>
                    <button class="settings-btn" type="button" id="setting-ai-fetch-models">拉取候选</button>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">连接测试</span>
                    <span class="settings-row-desc">发送一条最短请求，验证站点 / 密钥 / 模型是否可用</span>
                </div>
                <div class="settings-actions">
                    <button class="settings-btn" type="button" id="setting-ai-test">测试连接</button>
                </div>
            </div>
            <div class="settings-hint ai-status" id="setting-ai-status">${escapeHTML(aiDescribeConfigState())}</div>
        </div>

        <div class="settings-section">
            <div class="settings-section-title">提问上下文</div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">默认附带范围</span>
                    <span class="settings-row-desc">提问时默认一并发送的笔记范围，可在面板输入框下方随时改</span>
                </div>
                <select class="settings-select" id="setting-ai-scope">
                    <option value="current">仅当前笔记</option>
                    <option value="all">全部笔记</option>
                    <option value="none">不附带笔记</option>
                </select>
            </div>
            <div class="settings-row">
                <div class="settings-row-info">
                    <span class="settings-row-label">单次最多附带笔记</span>
                    <span class="settings-row-desc">「全部笔记」时最多附带多少篇（1–50）</span>
                </div>
                <input class="settings-input mono short" id="setting-ai-max-notes" type="number" min="1" max="50"
                    value="${Number(State.ai.maxNotes) || 10}">
            </div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">系统提示词</span>
                    <span class="settings-row-desc">约束 AI 的身份与回答风格，留空则使用内置提示词</span>
                </div>
                <textarea class="settings-input wide textarea" id="setting-ai-system" rows="4"
                    placeholder="例如：你是我的读书笔记助手，回答尽量简短，必要时引用笔记原文" spellcheck="false">${escapeHTML(State.ai.systemPrompt)}</textarea>
            </div>
        </div>
    `;
}

function aiDescribeConfigState() {
    if (!isAiEnabled()) return 'AI 助手当前已关闭。';
    if (!isAiConfigured()) return '尚未填写 API 站点或模型，填写后即可在右侧面板里提问。';
    return `已配置：${State.ai.model}${State.ai.apiKey ? '' : '（未填 API Key，本地站点无需填写）'}`;
}

function setAiStatus(text, tone = '') {
    const status = document.getElementById('setting-ai-status');
    if (!status) return;
    status.textContent = text;
    if (tone) status.dataset.tone = tone;
    else delete status.dataset.tone;
}

function scheduleAiConfigSave() {
    saveConfig();
}

// 拉取模型候选：GET {base}/models
async function fetchAiModels() {
    const endpoint = aiBuildEndpoint(State.ai.baseUrl, 'models');
    if (!endpoint) {
        setAiStatus('拉取失败：请先填写 API 站点', 'error');
        return;
    }
    setAiStatus('正在拉取模型候选…');
    try {
        const response = await fetch(endpoint, { headers: aiHeaders() });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const list = Array.isArray(payload.data) ? payload.data : [];
        const options = document.getElementById('ai-model-options');
        options.innerHTML = list
            .map((item) => (item && item.id ? `<option value="${escapeHTML(String(item.id))}"></option>` : ''))
            .join('');
        setAiStatus(list.length ? `已拉取 ${list.length} 个模型候选，点模型输入框即可选。` : '站点没有返回模型列表。', list.length ? 'ok' : '');
    } catch (error) {
        const detail = error && error.message ? error.message : '未知错误';
        setAiStatus(`拉取失败：${detail}（站点可能需要允许跨域访问）`, 'error');
    }
}

// 连接测试：发一条最短请求
async function testAiConnection() {
    if (!isAiConfigured()) {
        setAiStatus('测试失败：请先填写 API 站点与模型', 'error');
        return;
    }
    setAiStatus('正在测试连接…');
    try {
        const endpoint = aiBuildEndpoint(State.ai.baseUrl, 'chat/completions');
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: aiHeaders(),
            body: JSON.stringify({
                model: State.ai.model,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
                stream: false
            })
        });
        if (!response.ok) {
            let detail = '';
            try {
                const payload = await response.json();
                detail = payload && payload.error ? (payload.error.message || JSON.stringify(payload.error)) : '';
            } catch (error) {
                detail = '';
            }
            throw new Error(detail || `HTTP ${response.status}`);
        }
        setAiStatus(`连接正常：站点与模型 ${State.ai.model} 均可用。`, 'ok');
    } catch (error) {
        const detail = error && error.message ? error.message : '未知错误';
        setAiStatus(`测试失败：${detail}`, 'error');
    }
}

function bindAiPanel() {
    const enabled = document.getElementById('setting-ai-enabled');
    enabled.onchange = () => {
        State.ai.enabled = enabled.checked;
        scheduleAiConfigSave();
        applyAiEnabledState();
        showToast(enabled.checked ? 'AI 助手已开启' : 'AI 助手已关闭');
    };

    const baseUrl = document.getElementById('setting-ai-base-url');
    baseUrl.onchange = () => {
        State.ai.baseUrl = baseUrl.value.trim();
        scheduleAiConfigSave();
        updateAiModelChip();
        setAiStatus(aiDescribeConfigState());
    };
    document.querySelectorAll('[data-ai-site]').forEach((chip) => {
        chip.onclick = () => {
            baseUrl.value = chip.dataset.aiSite;
            State.ai.baseUrl = baseUrl.value;
            scheduleAiConfigSave();
            updateAiModelChip();
            setAiStatus(aiDescribeConfigState());
        };
    });

    const key = document.getElementById('setting-ai-key');
    key.onchange = () => {
        State.ai.apiKey = key.value.trim();
        scheduleAiConfigSave();
        setAiStatus(aiDescribeConfigState());
    };

    const model = document.getElementById('setting-ai-model');
    model.onchange = () => {
        State.ai.model = model.value.trim();
        scheduleAiConfigSave();
        updateAiModelChip();
        setAiStatus(aiDescribeConfigState());
    };

    document.getElementById('setting-ai-fetch-models').onclick = fetchAiModels;
    document.getElementById('setting-ai-test').onclick = testAiConnection;

    const scope = document.getElementById('setting-ai-scope');
    scope.value = State.ai.scope || 'current';
    scope.onchange = () => {
        State.ai.scope = AI_SCOPE_VALUES.includes(scope.value) ? scope.value : 'current';
        scheduleAiConfigSave();
        const panelSelect = document.getElementById('ai-scope-select');
        if (panelSelect) panelSelect.value = State.ai.scope;
        updateAiScopeOptions();
    };

    const maxNotes = document.getElementById('setting-ai-max-notes');
    maxNotes.onchange = () => {
        State.ai.maxNotes = Math.max(1, Math.min(50, Number(maxNotes.value) || 10));
        maxNotes.value = String(State.ai.maxNotes);
        scheduleAiConfigSave();
        updateAiScopeOptions();
    };

    const system = document.getElementById('setting-ai-system');
    system.onchange = () => {
        State.ai.systemPrompt = system.value;
        scheduleAiConfigSave();
    };

    CUSTOM_SELECTS.forEach((entry) => {
        if (entry.select === scope) refreshCustomSelect(entry);
    });
}

/* ---------------- 系统 ---------------- */

function systemPanelHTML() {
    const shortcuts = [
        ['新建笔记', 'Ctrl + N'],
        ['新建待办', 'Ctrl + Shift + N'],
        ['搜索', 'Ctrl + K'],
        ['保存当前条目', 'Ctrl + S'],
        ['关闭当前标签页', 'Ctrl + W'],
        ['切换标签页', 'Ctrl + Tab'],
        ['回到笔记列表', 'Esc'],
        ['小本本：保存（未关联时新建为笔记）', 'Ctrl + S'],
        ['小本本：选择笔记', 'Ctrl + O']
    ];
    return `
        ${panelHeader('系统', 'EsprinNemo 网页版，由 EsprinSync 托管', 'info')}
        <div class="settings-section">
            <div class="settings-section-title">版本信息</div>
            <div class="settings-row is-column">
                <div class="settings-row-info">
                    <span class="settings-row-label">EsprinNemo Web</span>
                    <span class="settings-row-desc">界面与桌面版 EsprinNemo 共用同一套设计令牌与 Markdown 渲染规则，
                        数据格式（notes/{id}.md 的内嵌元数据注释）也完全一致，因此两端可以互推互认</span>
                </div>
                <div class="settings-path">服务端：${escapeHTML(Sync.baseUrl())}${escapeHTML(SYNC_PATH)}</div>
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-section-title">快捷键</div>
            <div class="shortcut-list">
                ${shortcuts.map(([label, keys]) => `
                    <div class="shortcut-row">
                        <span>${label}</span>
                        <span class="shortcut-keys">${keys}</span>
                    </div>
                `).join('')}
            </div>
        </div>
        <div class="settings-section">
            <div class="settings-section-title">说明</div>
            <div class="settings-hint">
                网页版把托管它的 EsprinSync 直接当存储：本地只保留一份用于离线阅读的副本，
                读写最终都落在服务端的操作日志上；桌面客户端拉取同一份日志即可看到这些改动。
                首次登录需要服务端的管理密码（在 /admin 设置），也可以改用访问令牌。
            </div>
            <div class="settings-hint">
                与桌面版的两处差异：AI 助手的 API Key 只能存在本浏览器里（桌面版交给系统密钥链），
                请求也由页面直连站点，可能受站点的跨域策略限制；秘密本只保留隐藏与加密两项元数据——
                加密正文只能在桌面版输入密码解开，网页版不提供解密流程。
                托盘与驻留后台、开机自启、应用自更新、数据存放位置属于桌面端能力，浏览器里由浏览器
                与系统本身接管（缩放比例已按桌面版的五档提供，落在根元素的 CSS 缩放上）。
            </div>
        </div>
    `;
}
