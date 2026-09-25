/* 通用工具与浮层：HTML 转义、时间格式化、Toast、消息弹窗、自绘下拉与文件下载 */

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => HTML_ESCAPE_MAP[m]);
}

/* ---------------- 时间显示 ---------------- */

const DATE_TEXT_CACHE = new Map();
const DATE_TEXT_CACHE_LIMIT = 512;

function buildDateTexts(time) {
    const d = new Date(time);
    return {
        day: d.toDateString(),
        time: d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        date: `${d.getMonth() + 1}月${d.getDate()}日`,
        year: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    };
}

// 当天显示时刻，其余显示月日
function formatDate(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time) || time <= 0) return '';
    const minuteKey = Math.floor(time / 60000);
    let entry = DATE_TEXT_CACHE.get(minuteKey);
    if (!entry) {
        entry = buildDateTexts(time);
        if (DATE_TEXT_CACHE.size >= DATE_TEXT_CACHE_LIMIT) DATE_TEXT_CACHE.clear();
        DATE_TEXT_CACHE.set(minuteKey, entry);
    }
    return entry.day === new Date().toDateString() ? entry.time : entry.date;
}

// 完整日期时间：同步状态等场景使用
function formatDateTime(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time) || time <= 0) return '尚未同步';
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- Toast ---------------- */

const TOAST_VISIBLE_MS = 1800;
const TOAST_LEAVE_MS = 200;

function showToast(msg) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const item = document.createElement('div');
    item.className = 'toast-item';
    item.innerHTML = `<span class="ms-icon sm">info</span><span>${escapeHTML(msg)}</span>`;
    container.appendChild(item);
    setTimeout(() => {
        item.classList.add('is-leaving');
        setTimeout(() => item.remove(), TOAST_LEAVE_MS);
    }, TOAST_VISIBLE_MS);
}

/* ---------------- 消息弹窗 ----------------
   桌面版由主进程另开一个窗口渲染弹窗，网页版改为覆盖式浮层，
   视觉沿用 dialog.html 里的同一套类名与取值。 */

let dialogResolve = null;

function closeDialog(result) {
    const mask = document.getElementById('dialog-mask');
    mask.classList.add('hidden');
    const resolve = dialogResolve;
    dialogResolve = null;
    if (resolve) resolve(result);
}

function openDialog(options = {}) {
    const mask = document.getElementById('dialog-mask');
    const icon = document.getElementById('dialog-icon');
    const message = document.getElementById('dialog-message');
    const detail = document.getElementById('dialog-detail');
    const field = document.getElementById('dialog-field');
    const fieldLabel = document.getElementById('dialog-field-label');
    const input = document.getElementById('dialog-input');
    const actions = document.getElementById('dialog-actions');

    icon.textContent = options.icon || 'help';
    icon.className = `ms-icon dialog-icon ${options.type === 'warning' ? 'warning' : options.type === 'error' ? 'error' : ''}`;
    message.textContent = options.message || '';
    detail.textContent = options.detail || '';
    detail.classList.toggle('hidden', !options.detail);

    const hasInput = !!options.input;
    field.classList.toggle('hidden', !hasInput);
    if (hasInput) {
        fieldLabel.textContent = options.input.label || '名称';
        input.value = options.input.value || '';
        input.placeholder = options.input.placeholder || '';
        input.type = options.input.type || 'text';
        input.autocomplete = options.input.autocomplete || 'off';
    }

    actions.innerHTML = '';
    (options.buttons || []).forEach((button) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `dialog-btn ${button.variant || 'default'}`;
        el.textContent = button.label;
        el.onclick = () => {
            if (button.id === 'cancel') closeDialog(null);
            else closeDialog(hasInput ? { id: button.id, value: input.value } : { id: button.id });
        };
        actions.appendChild(el);
    });

    mask.classList.remove('hidden');
    const focusTarget = actions.querySelector('.dialog-btn.primary') || actions.lastElementChild;
    setTimeout(() => {
        if (hasInput) {
            input.focus();
            input.select();
        } else if (focusTarget) {
            focusTarget.focus();
        }
    }, 20);

    return new Promise((resolve) => {
        dialogResolve = resolve;
    });
}

// 确认框：返回是否点了确认按钮
async function showConfirm(message, options = {}) {
    const result = await openDialog({
        type: options.type || 'question',
        icon: options.icon || 'help',
        message,
        detail: options.detail || '',
        buttons: [
            { id: 'cancel', label: options.cancelLabel || '取消', variant: 'default' },
            { id: 'confirm', label: options.confirmLabel || '确定', variant: options.danger ? 'danger' : 'primary' }
        ]
    });
    return !!result && result.id === 'confirm';
}

// 单值输入：返回去除首尾空格的内容，取消返回 null
async function showPrompt(message, options = {}) {
    const result = await openDialog({
        type: options.type || 'question',
        icon: options.icon || 'edit',
        message,
        detail: options.detail || '',
        input: {
            value: options.value || '',
            placeholder: options.placeholder || '',
            label: options.label || '名称'
        },
        buttons: [
            { id: 'cancel', label: options.cancelLabel || '取消', variant: 'default' },
            { id: 'confirm', label: options.confirmLabel || '确定', variant: 'primary' }
        ]
    });
    if (!result || result.id !== 'confirm') return null;
    return typeof result.value === 'string' ? result.value.trim() : '';
}

/* 口令输入：与 showPrompt 同一套用法，区别是输入框不回显明文。
   返回原样输入的内容（口令不去首尾空白，空格本身也可以是口令的一部分），取消返回 null。 */
async function showPasswordPrompt(message, options = {}) {
    const result = await openDialog({
        type: options.type || 'question',
        icon: options.icon || 'lock',
        message,
        detail: options.detail || '',
        input: {
            value: options.value || '',
            placeholder: options.placeholder || '',
            label: options.label || '密码',
            type: 'password',
            autocomplete: 'off'
        },
        buttons: [
            { id: 'cancel', label: options.cancelLabel || '取消', variant: 'default' },
            { id: 'confirm', label: options.confirmLabel || '确定', variant: 'primary' }
        ]
    });
    if (!result || result.id !== 'confirm') return null;
    return typeof result.value === 'string' ? result.value : '';
}

/* ---------------- 自绘下拉 ----------------
   原生 <select> 留在原地当数据源（选项、value、change 事件都照旧），
   另外补一层触发器与弹出列表，避免浏览器原生下拉与界面风格脱节。 */

const CUSTOM_SELECTS = [];
let activeCustomSelect = null;

function bindCustomSelect(select) {
    if (!select || select.dataset.customized === '1') return null;
    select.dataset.customized = '1';

    const root = document.createElement('span');
    root.className = 'dropdown';
    select.parentNode.insertBefore(root, select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = `dropdown-trigger ${select.className}`;
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'dropdown-label';
    const arrow = document.createElement('span');
    arrow.className = 'ms-icon xs dropdown-arrow';
    arrow.textContent = 'expand_more';
    trigger.append(label, arrow);

    const menu = document.createElement('div');
    menu.className = 'dropdown-menu';
    menu.hidden = true;
    menu.setAttribute('role', 'listbox');
    if (select.classList.contains('select-folder')) menu.classList.add('new-item-menu');

    root.append(trigger);
    select.classList.add('dropdown-source');
    root.appendChild(select);
    document.body.appendChild(menu);

    const entry = { select, root, trigger, label, menu, highlight: -1 };
    CUSTOM_SELECTS.push(entry);

    trigger.addEventListener('click', (event) => {
        event.stopPropagation();
        toggleCustomSelect(entry);
    });

    // 原生 select 被程序化赋值时同步刷新触发器文字
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
        configurable: true,
        get() {
            return nativeValue.get.call(this);
        },
        set(next) {
            nativeValue.set.call(this, next);
            refreshCustomSelect(entry);
        }
    });

    refreshCustomSelect(entry);
    return entry;
}

function customSelectLabelText(select) {
    const option = select.selectedIndex >= 0 ? select.options[select.selectedIndex] : null;
    return option ? (option.textContent || '').trim() : '';
}

function buildCustomSelectMenu(entry) {
    const { select, menu } = entry;
    menu.innerHTML = '';
    Array.from(select.children).forEach((child) => {
        if (child.tagName === 'OPTGROUP') {
            const groupLabel = document.createElement('div');
            groupLabel.className = 'dropdown-group-label';
            groupLabel.textContent = child.label || '';
            menu.appendChild(groupLabel);
            Array.from(child.children).forEach((option) => menu.appendChild(createCustomSelectOption(entry, option)));
            return;
        }
        if (child.tagName === 'OPTION') menu.appendChild(createCustomSelectOption(entry, child));
    });
}

function createCustomSelectOption(entry, option) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dropdown-option';
    button.dataset.value = option.value;
    button.disabled = !!option.disabled;

    const text = document.createElement('span');
    text.className = 'dropdown-option-text';
    text.textContent = (option.textContent || '').trim();

    const check = document.createElement('span');
    check.className = 'ms-icon xs dropdown-check';
    check.textContent = 'check';

    button.append(text, check);
    button.onclick = (event) => {
        event.stopPropagation();
        chooseCustomSelectValue(entry, option.value);
    };
    return button;
}

function refreshCustomSelect(entry) {
    if (!entry) return;
    const { select, trigger, label, menu } = entry;
    label.textContent = customSelectLabelText(select);
    trigger.disabled = !!select.disabled;
    trigger.classList.toggle('disabled', !!select.disabled);
    menu.querySelectorAll('.dropdown-option').forEach((option) => {
        option.classList.toggle('active', option.dataset.value === select.value);
    });
}

// 选项集合被重建过（文件夹列表变化）后调用
function markCustomSelectDirty(entry) {
    if (entry) entry.dirty = true;
}

function positionCustomSelectMenu(entry) {
    const { trigger, menu } = entry;
    const anchor = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const gap = 4;
    const margin = 8;

    let left = anchor.left;
    if (left + box.width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - margin - box.width);
    }
    let top = anchor.bottom + gap;
    if (top + box.height > window.innerHeight - margin) {
        const above = anchor.top - gap - box.height;
        top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - box.height);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.minWidth = `${Math.max(120, Math.round(anchor.width))}px`;
}

function closeCustomSelect() {
    if (!activeCustomSelect) return;
    const entry = activeCustomSelect;
    activeCustomSelect = null;
    entry.menu.hidden = true;
    entry.root.classList.remove('open');
    entry.trigger.setAttribute('aria-expanded', 'false');
    entry.menu.querySelectorAll('.dropdown-option.highlight').forEach((option) => option.classList.remove('highlight'));
    entry.highlight = -1;
}

function openCustomSelect(entry) {
    if (activeCustomSelect === entry) return;
    closeCustomSelect();
    if (entry.dirty || !entry.menu.childElementCount) {
        buildCustomSelectMenu(entry);
        entry.dirty = false;
    }
    refreshCustomSelect(entry);
    entry.menu.hidden = false;
    entry.root.classList.add('open');
    entry.trigger.setAttribute('aria-expanded', 'true');
    activeCustomSelect = entry;
    positionCustomSelectMenu(entry);
}

function toggleCustomSelect(entry) {
    if (activeCustomSelect === entry) closeCustomSelect();
    else openCustomSelect(entry);
}

function chooseCustomSelectValue(entry, value) {
    const { select } = entry;
    const changed = select.value !== value;
    select.value = value;
    closeCustomSelect();
    if (!changed) return;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function moveCustomSelectHighlight(entry, delta) {
    const options = Array.from(entry.menu.querySelectorAll('.dropdown-option')).filter((option) => !option.disabled);
    if (!options.length) return;
    const current = options.findIndex((option) => option.classList.contains('highlight'));
    const next = current === -1
        ? (delta > 0 ? 0 : options.length - 1)
        : (current + delta + options.length) % options.length;
    options.forEach((option) => option.classList.remove('highlight'));
    options[next].classList.add('highlight');
    options[next].scrollIntoView({ block: 'nearest' });
    entry.highlight = next;
}

function handleCustomSelectKeydown(entry, event) {
    const isOpen = activeCustomSelect === entry;
    const options = Array.from(entry.menu.querySelectorAll('.dropdown-option')).filter((option) => !option.disabled);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!isOpen) openCustomSelect(entry);
        else moveCustomSelectHighlight(entry, event.key === 'ArrowDown' ? 1 : -1);
        return;
    }
    if (!isOpen) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        closeCustomSelect();
        return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const highlighted = entry.highlight >= 0 ? options[entry.highlight] : null;
        const target = highlighted || options.find((option) => option.classList.contains('active'));
        if (target) chooseCustomSelectValue(entry, target.dataset.value);
        else closeCustomSelect();
        return;
    }
    if (event.key === 'Tab') closeCustomSelect();
}

// 启动时升级页面里所有原生下拉；设置面板重建后会再调一次，
// 因此全局监听只挂一次（否则每开一次设置就多三份重复监听）
let customSelectGlobalsBound = false;

function initCustomSelects() {
    document.querySelectorAll('select:not(.dropdown-source)').forEach((select) => {
        const entry = bindCustomSelect(select);
        if (!entry) return;
        entry.trigger.addEventListener('keydown', (event) => handleCustomSelectKeydown(entry, event));
    });
    if (customSelectGlobalsBound) return;
    customSelectGlobalsBound = true;
    document.addEventListener('click', () => closeCustomSelect());
    window.addEventListener('resize', () => closeCustomSelect());
    window.addEventListener('scroll', () => closeCustomSelect(), true);
}

/* ---------------- 文件与剪贴板 ---------------- */

function downloadText(fileName, text, mime = 'text/markdown') {
    const blob = new Blob([text], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 复制文本：剪贴板 API 在非安全上下文（http 局域网地址）下不可用，退回临时输入框
async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (error) {
        console.warn('[WARN] [Clipboard] 剪贴板接口写入失败: ' + (error && error.message));
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
    } catch (error) {
        console.warn('[WARN] [Clipboard] 降级复制失败: ' + (error && error.message));
        return false;
    }
}
