const API_BASE = '/admin/api';

const $ = (id) => document.getElementById(id);

const LIGHT_QUERY = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme() {
    document.documentElement.classList.toggle('light', LIGHT_QUERY.matches);
}

function initTheme() {
    applyTheme();
    LIGHT_QUERY.addEventListener('change', applyTheme);
}

let toastTimer = 0;

function toast(text, tone = 'ok') {
    const element = $('toast');
    element.textContent = text;
    element.dataset.tone = tone;
    element.hidden = false;
    requestAnimationFrame(() => element.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        element.classList.remove('show');
        setTimeout(() => { element.hidden = true; }, 220);
    }, 2600);
}

function setMessage(id, text, tone = '') {
    const element = $(id);
    element.textContent = text;
    element.dataset.tone = tone;
}

function formatTime(stamp) {
    if (!stamp) return '未使用过';
    const date = new Date(Number(stamp));
    if (Number.isNaN(date.getTime())) return '未使用过';
    return date.toLocaleString('zh-CN', { hour12: false });
}

async function copyText(text, button) {
    const value = String(text || '').trim();
    if (!value) {
        toast('这里还没有内容可复制', 'error');
        return false;
    }

    let copied = false;
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(value);
            copied = true;
        } catch (error) {
            copied = false;
        }
    }
    if (!copied) copied = legacyCopy(value);

    if (button) flashCopied(button, copied);
    toast(copied ? '已复制到剪贴板' : '复制失败，请手动选中后复制', copied ? 'ok' : 'error');
    return copied;
}

function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, area.value.length);

    let copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    area.remove();
    return copied;
}

function flashCopied(button, copied) {
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    button.dataset.idleLabel = button.textContent;
    button.textContent = copied ? '已复制 ✓' : '复制失败';
    button.classList.toggle('is-copied', copied);

    setTimeout(() => {
        button.textContent = button.dataset.idleLabel || '复制';
        button.dataset.busy = '';
        button.classList.remove('is-copied');
    }, 1400);
}

function copyElement(id, button) {
    const element = $(id);
    return copyText(element ? element.textContent : '', button);
}

function selectAllOnClick(id) {
    const element = $(id);
    element.addEventListener('click', () => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
    });
}

function armConfirm(button, label, action) {
    if (button.dataset.armed === '1') {
        button.dataset.armed = '';
        button.textContent = button.dataset.idle || button.textContent;
        button.classList.remove('danger-solid');
        action();
        return;
    }

    button.dataset.armed = '1';
    button.dataset.idle = button.textContent;
    button.textContent = label;
    button.classList.add('danger-solid');

    setTimeout(() => {
        if (button.dataset.armed !== '1') return;
        button.dataset.armed = '';
        button.textContent = button.dataset.idle;
        button.classList.remove('danger-solid');
    }, 4000);
}

async function api(path, body) {
    const options = { credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const response = await fetch(API_BASE + path, options);
    let data = {};
    try { data = await response.json(); } catch (error) { data = {}; }
    return { status: response.status, data };
}

const state = {
    passwordSet: false,
    loggedIn: false,
    admin: false,
    // 当前登录的账户（任何账户登录都会填上，管理面板只对管理员展示）
    user: null,
    accountCount: 0,
    tokenCount: 0,
    users: [],
    // 正在管理的账户 id：令牌与日志两节都作用在它上面
    account: '',
};

// 数据与日志一节的常驻说明：登录前、出错时都会回到这句
const JOURNAL_IDLE_HINT = '下载得到的是当前账户那份 journal.log 的快照；这个账户的全部笔记与待办就在其中。';

// 管理面板只对管理员账户开放
function panelReady() {
    return state.loggedIn && state.admin;
}

function render() {
    $('view-setup').hidden = state.passwordSet;
    $('view-login').hidden = !state.passwordSet || panelReady();
    $('view-panel').hidden = !panelReady();
    $('logout-btn').hidden = !state.loggedIn;

    if (panelReady()) {
        $('header-desc').textContent = '当前账户 ' + (state.user ? state.user.name : '')
            + ' · 共 ' + state.accountCount + ' 个账户 · ' + state.tokenCount + ' 个访问令牌。'
            + '令牌明文只在创建或重置的那一瞬间出现，服务端只保存摘要。';
    } else {
        if (state.loggedIn && state.user) {
            setMessage('login-msg', '当前登录的账户「' + state.user.name
                + '」不是管理员，进不了管理后台。请先退出，再用管理员账户登录。', 'error');
        }
        $('journal-summary').textContent = '登录后可以查看与下载日志';
        $('journal-summary').title = '';
        $('journal-download').disabled = true;
        $('journal-compact').disabled = true;
        setMessage('journal-status', JOURNAL_IDLE_HINT);
    }
}

async function refresh() {
    const { data } = await api('/status');
    state.passwordSet = !!data.passwordSet;
    state.loggedIn = !!data.loggedIn;
    state.admin = !!data.admin;
    state.user = data.user || null;
    state.accountCount = Number(data.accountCount) || 0;
    state.tokenCount = Number(data.tokenCount) || 0;
    render();

    if (!panelReady()) return;
    await loadUsers();
    await loadTokens();
    await loadJournal();
}

/* ---------------- 账户 ---------------- */

function accountQuery() {
    return state.account ? '?user=' + encodeURIComponent(state.account) : '';
}

function accountById(id) {
    return state.users.find((item) => item.id === id) || null;
}

function fillAccountSelect() {
    const select = $('account-select');
    select.textContent = '';
    state.users.forEach((record) => {
        const option = document.createElement('option');
        option.value = record.id;
        option.textContent = record.name + (record.admin ? '（管理员）' : '')
            + (record.enabled ? '' : '（已停用）');
        select.append(option);
    });
    select.value = state.account;
    if (select.value !== state.account && state.users.length) {
        state.account = state.users[0].id;
        select.value = state.account;
    }
    renderAccountMeta();
}

function renderAccountMeta() {
    const record = accountById(state.account);
    const meta = $('account-meta');
    if (!record) {
        meta.textContent = '';
        return;
    }
    const journal = record.journal || {};
    meta.textContent = 'id ' + record.id + ' · ' + Number(record.tokenCount) + ' 个令牌'
        + ' · ' + Number(journal.ops || 0) + ' 条操作 · ' + Number(journal.files || 0)
        + ' 个存活文件 · ' + formatFileSize(journal.size);
}

function userRow(record) {
    const row = document.createElement('div');
    row.className = 'settings-row token-row';

    const head = document.createElement('div');
    head.className = 'token-head';

    const role = document.createElement('span');
    role.className = 'badge';
    role.textContent = record.builtIn ? '内置账户' : (record.admin ? '管理员' : '普通账户');
    if (!record.admin) role.dataset.off = '1';

    const name = document.createElement('span');
    name.className = 'token-name';
    name.textContent = record.name;

    const actions = document.createElement('span');
    actions.className = 'settings-actions';

    head.append(role);
    if (!record.enabled) {
        const off = document.createElement('span');
        off.className = 'badge';
        off.dataset.off = '1';
        off.textContent = '已停用';
        head.append(off);
    }
    head.append(name, actions);

    const journal = record.journal || {};
    const meta = document.createElement('div');
    meta.className = 'token-meta';
    const metaText = document.createElement('span');
    metaText.textContent = '创建于 ' + formatTime(record.createdAt) + ' · 最近登录 ' + formatTime(record.lastLoginAt)
        + ' · ' + Number(record.tokenCount) + ' 个令牌 · ' + Number(journal.ops || 0) + ' 条操作 · '
        + Number(journal.files || 0) + ' 个存活文件 · ' + formatFileSize(journal.size);
    meta.append(metaText);

    const fields = document.createElement('div');
    fields.className = 'row-controls';

    const nameInput = document.createElement('input');
    nameInput.className = 'settings-input';
    nameInput.type = 'text';
    nameInput.maxLength = 32;
    nameInput.placeholder = '账户名';
    nameInput.value = record.name;
    if (record.builtIn) {
        // 内置账户的名字同时是它的数据目录名，不允许改
        nameInput.disabled = true;
        nameInput.title = '内置账户 admin 不能改名';
    }

    const passwordInput = document.createElement('input');
    passwordInput.className = 'settings-input';
    passwordInput.type = 'password';
    passwordInput.autocomplete = 'new-password';
    passwordInput.placeholder = '重设密码（至少 8 位）';

    fields.append(nameInput, passwordInput);

    const saveButton = document.createElement('button');
    saveButton.className = 'settings-btn';
    saveButton.type = 'button';
    saveButton.textContent = '保存改名';
    saveButton.disabled = true;
    const syncSaveState = () => {
        saveButton.disabled = record.builtIn || nameInput.value.trim() === record.name;
    };
    nameInput.addEventListener('input', syncSaveState);
    saveButton.addEventListener('click', async () => {
        const { status, data } = await api('/users/update', { id: record.id, name: nameInput.value.trim() });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '改名失败', 'error');
        toast('账户名已改为 ' + data.user.name);
        await reloadUsers();
    });

    const resetButton = document.createElement('button');
    resetButton.className = 'settings-btn';
    resetButton.type = 'button';
    resetButton.textContent = '重设密码';
    resetButton.addEventListener('click', async () => {
        const value = passwordInput.value;
        if (value.length < 8) return toast('新密码至少 8 位', 'error');
        const { status, data } = await api('/users/password', { id: record.id, password: value });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '重设失败', 'error');
        passwordInput.value = '';
        toast('已重设「' + record.name + '」的密码，该账户已登录的浏览器会退出');
        await reloadUsers();
    });

    if (!record.builtIn) {
        const roleButton = document.createElement('button');
        roleButton.className = 'settings-btn';
        roleButton.type = 'button';
        roleButton.textContent = record.admin ? '取消管理员' : '设为管理员';
        roleButton.addEventListener('click', async () => {
            const { status, data } = await api('/users/update', { id: record.id, admin: !record.admin });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '操作失败', 'error');
            toast(record.admin ? '已取消管理员权限' : '已设为管理员');
            await reloadUsers();
        });

        const toggleButton = document.createElement('button');
        toggleButton.className = 'settings-btn';
        toggleButton.type = 'button';
        toggleButton.textContent = record.enabled ? '停用' : '启用';
        toggleButton.addEventListener('click', async () => {
            const { status, data } = await api('/users/update', { id: record.id, enabled: !record.enabled });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '操作失败', 'error');
            toast(record.enabled ? '账户已停用，它的令牌与登录会话都已失效' : '账户已重新启用');
            await reloadUsers();
        });

        const deleteButton = document.createElement('button');
        deleteButton.className = 'settings-btn danger';
        deleteButton.type = 'button';
        deleteButton.textContent = '删除';
        deleteButton.addEventListener('click', () => {
            armConfirm(deleteButton, '确认删除账户与数据', async () => {
                const { status, data } = await api('/users/delete', { id: record.id });
                if (status === 401) return refresh();
                if (status !== 200) return toast(data.error || '删除失败', 'error');
                toast('已删除账户「' + record.name + '」及其全部数据');
                await reloadUsers();
            });
        });

        actions.append(saveButton, resetButton, roleButton, toggleButton, deleteButton);
    } else {
        actions.append(resetButton);
    }

    row.append(head, meta, fields);
    return row;
}

async function loadUsers() {
    const { status, data } = await api('/users');
    if (status === 401) {
        state.loggedIn = false;
        state.admin = false;
        render();
        return;
    }
    if (status === 403) {
        state.admin = false;
        render();
        return;
    }
    if (status !== 200) {
        toast((data && data.error) || '账户列表读取失败', 'error');
        return;
    }

    state.users = Array.isArray(data.users) ? data.users : [];
    state.accountCount = state.users.length;
    // 选中的账户被删掉时落回自己
    if (!accountById(state.account)) {
        state.account = (state.user && state.user.id) || (state.users[0] ? state.users[0].id : '');
    }

    const list = $('user-list');
    list.textContent = '';
    state.users.forEach((record) => list.append(userRow(record)));
    $('user-empty').hidden = state.users.length > 1;

    fillAccountSelect();
}

async function reloadUsers() {
    await loadUsers();
    if (panelReady()) {
        await loadTokens();
        await loadJournal();
    }
}

function showSecret(id) {
    const box = $(id);
    box.hidden = false;
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function tokenRow(record) {
    const row = document.createElement('div');
    row.className = 'settings-row token-row';

    const head = document.createElement('div');
    head.className = 'token-head';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = record.enabled ? '启用中' : '已停用';
    if (!record.enabled) badge.dataset.off = '1';

    const name = document.createElement('span');
    name.className = 'token-name';
    name.textContent = record.name || '未命名设备';

    const actions = document.createElement('span');
    actions.className = 'settings-actions';

    head.append(badge, name, actions);

    const meta = document.createElement('div');
    meta.className = 'token-meta';
    const metaText = document.createElement('span');
    metaText.textContent = '创建于 ' + formatTime(record.createdAt) + ' · 最近使用 ' + formatTime(record.lastUsedAt);
    meta.append(metaText);

    const fields = document.createElement('div');
    fields.className = 'row-controls';

    const nameInput = document.createElement('input');
    nameInput.className = 'settings-input';
    nameInput.type = 'text';
    nameInput.maxLength = 40;
    nameInput.placeholder = '名称，例如：台式机';
    nameInput.value = record.name || '';

    const deviceInput = document.createElement('input');
    deviceInput.className = 'settings-input mono';
    deviceInput.type = 'text';
    deviceInput.maxLength = 40;
    deviceInput.placeholder = '绑定设备 id，留空表示不绑定';
    deviceInput.value = record.device || '';

    fields.append(nameInput, deviceInput);

    const saveButton = document.createElement('button');
    saveButton.className = 'settings-btn';
    saveButton.type = 'button';
    saveButton.textContent = '保存';
    saveButton.disabled = true;
    const syncSaveState = () => {
        saveButton.disabled = nameInput.value === (record.name || '') && deviceInput.value === (record.device || '');
    };
    nameInput.addEventListener('input', syncSaveState);
    deviceInput.addEventListener('input', syncSaveState);
    saveButton.addEventListener('click', async () => {
        const { status, data } = await api('/tokens/update', {
            user: state.account,
            id: record.id,
            name: nameInput.value,
            device: deviceInput.value,
        });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '保存失败', 'error');
        toast('已保存');
        await loadTokens();
    });

    const toggleButton = document.createElement('button');
    toggleButton.className = 'settings-btn';
    toggleButton.type = 'button';
    toggleButton.textContent = record.enabled ? '停用' : '启用';
    toggleButton.addEventListener('click', async () => {
        const { status, data } = await api('/tokens/update', {
            user: state.account, id: record.id, enabled: !record.enabled,
        });
        if (status === 401) return refresh();
        if (status !== 200) return toast(data.error || '操作失败', 'error');
        toast(record.enabled ? '该令牌已停用，继续使用将收到 401' : '该令牌已重新启用');
        await loadTokens();
    });

    const rotateButton = document.createElement('button');
    rotateButton.className = 'settings-btn';
    rotateButton.type = 'button';
    rotateButton.textContent = '重置';
    rotateButton.addEventListener('click', () => {
        armConfirm(rotateButton, '确认重置？', async () => {
            const { status, data } = await api('/tokens/rotate', { user: state.account, id: record.id });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '重置失败', 'error');
            $('reset-token').textContent = data.token || '';
            toast('令牌已重置，旧令牌立即失效');
            await loadTokens();
            showSecret('reset-secret');
        });
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'settings-btn danger';
    deleteButton.type = 'button';
    deleteButton.textContent = '删除';
    deleteButton.addEventListener('click', () => {
        armConfirm(deleteButton, '确认删除', async () => {
            const { status, data } = await api('/tokens/delete', { user: state.account, id: record.id });
            if (status === 401) return refresh();
            if (status !== 200) return toast(data.error || '删除失败', 'error');
            toast('令牌已删除');
            await loadTokens();
        });
    });

    if (record.lastDeviceId) {
        const label = document.createElement('span');
        label.textContent = '· 最近上报设备';

        const device = document.createElement('code');
        device.textContent = record.lastDeviceId;

        const bindButton = document.createElement('button');
        bindButton.className = 'settings-btn';
        bindButton.type = 'button';
        bindButton.textContent = '用这个 id 绑定';
        bindButton.addEventListener('click', () => {
            deviceInput.value = record.lastDeviceId;
            syncSaveState();
            deviceInput.focus();
            toast('已填入设备 id，点「保存」生效');
        });

        meta.append(label, device, bindButton);
    }

    actions.append(saveButton, toggleButton, rotateButton, deleteButton);
    row.append(head, meta, fields);
    return row;
}

async function loadTokens() {
    const { status, data } = await api('/tokens' + accountQuery());
    if (status === 401) {
        state.loggedIn = false;
        render();
        return;
    }
    if (status !== 200) {
        toast((data && data.error) || '令牌列表读取失败', 'error');
        return;
    }

    const list = $('token-list');
    list.textContent = '';
    const records = Array.isArray(data.tokens) ? data.tokens : [];
    records.forEach((record) => list.append(tokenRow(record)));
    $('token-empty').hidden = records.length > 0;
}

function formatFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    return (size / 1024 / 1024).toFixed(2) + ' MB';
}

function describeJournal(data) {
    if (!data || !data.exists || !Number(data.ops)) return '';
    // 「可复用 ID」是删除腾出来的 ID：新建条目会优先把它们再用起来
    const recyclable = Number(data.recyclable);
    return Number(data.ops) + ' 条操作 · 存活文件 ' + Number(data.files) + ' · 删除记录 ' + Number(data.deleted)
        + (recyclable ? '（可复用 ID ' + recyclable + '）' : '')
        + ' · 最新序号 ' + Number(data.latestSeq) + ' · ' + formatFileSize(data.size)
        + ' · 最后写入 ' + formatTime(data.updatedAt);
}

async function loadJournal() {
    const summary = $('journal-summary');
    const button = $('journal-download');
    const compactButton = $('journal-compact');
    const { status, data } = await api('/journal' + accountQuery());
    if (status === 401) {
        state.loggedIn = false;
        render();
        return;
    }

    if (status !== 200) {
        summary.textContent = '读取日志状态失败：' + ((data && data.error) || 'HTTP ' + status);
        summary.title = '';
        button.disabled = true;
        if (compactButton) compactButton.disabled = true;
        return;
    }

    const text = describeJournal(data);
    if (!text) {
        summary.textContent = '这个账户还没有任何操作：它同步过一次之后，日志里才会有内容';
        summary.title = '';
        button.disabled = true;
        if (compactButton) compactButton.disabled = true;
        return;
    }

    summary.textContent = text;
    // 日志身份：与客户端「诊断」报告里的同一项对得上，说明两边看的是同一份日志
    summary.title = data.journalId ? '日志身份：' + data.journalId : '';
    button.disabled = false;
    if (compactButton) compactButton.disabled = false;
}

function attachmentFileName(header) {
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(String(header || ''));
    if (!match) return '';
    const value = match[1].trim();
    try {
        return decodeURIComponent(value);
    } catch (error) {
        return value;
    }
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function downloadJournal() {
    const button = $('journal-download');
    if (button.disabled) return;

    let sessionLost = false;
    button.disabled = true;
    button.dataset.idle = button.textContent;
    button.textContent = '准备下载…';
    setMessage('journal-status', '正在从服务端读取日志…');

    try {
        const response = await fetch(API_BASE + '/journal/download' + accountQuery(), { credentials: 'same-origin' });
        if (!response.ok) {
            let data = {};
            try {
                data = await response.json();
            } catch (error) {
                data = {};
            }
            if (response.status === 401) {
                sessionLost = true;
                state.loggedIn = false;
                render();
                return;
            }
            const message = (data && data.error) || ('下载失败（HTTP ' + response.status + '）');
            setMessage('journal-status', message, 'error');
            toast(message, 'error');
            return;
        }

        const blob = await response.blob();
        const name = attachmentFileName(response.headers.get('Content-Disposition')) || 'journal.log';
        saveBlob(blob, name);
        setMessage('journal-status', '已下载 ' + name + '（' + formatFileSize(blob.size) + '）：在 EsprinNemo 的'
            + '「设置 → 数据与存储 → 文件日志」里可以导入它，或把它摊成一个文件夹。', 'ok');
        toast('日志已下载：' + name);
    } catch (error) {
        setMessage('journal-status', '下载失败，请检查网络后重试', 'error');
        toast('下载失败，请检查网络后重试', 'error');
    } finally {
        button.textContent = button.dataset.idle || '下载日志';
        // 下载期间可能又有新的操作写进日志：顺手刷新一次概览（它也会重新决定按钮是否可用）
        if (!sessionLost) await loadJournal();
    }
}

/* 整理日志：把已彻底删除的条目从日志里真正抹掉（每条只留一行删除标记，序号一律不变）。
   客户端推上一条删除时服务端会自动做这件事，这里是把以前积压下来的旧记录一并清掉。 */
async function compactJournal() {
    const button = $('journal-compact');
    if (!button || button.disabled) return;

    button.disabled = true;
    const idle = button.textContent;
    button.textContent = '整理中…';
    setMessage('journal-status', '正在抹掉已彻底删除条目的正文与历史…');

    try {
        const { status, data } = await api('/journal/compact', { user: state.account });
        if (status === 401) {
            state.loggedIn = false;
            render();
            return;
        }
        if (status !== 200) {
            const message = (data && data.error) || ('整理失败（HTTP ' + status + '）');
            setMessage('journal-status', message, 'error');
            toast(message, 'error');
            return;
        }

        const removed = Number(data.removed) || 0;
        if (removed) {
            const message = '已抹掉 ' + removed + ' 行（涉及 ' + Number(data.paths) + ' 条已彻底删除的条目），'
                + '日志现在 ' + Number(data.kept) + ' 行。';
            setMessage('journal-status', message, 'ok');
            toast('日志已整理：抹掉 ' + removed + ' 行');
        } else {
            setMessage('journal-status', '没有可整理的内容：已彻底删除的条目在日志里只留着一条删除标记。', 'ok');
            toast('日志无需整理');
        }
    } catch (error) {
        setMessage('journal-status', '整理失败，请检查网络后重试', 'error');
        toast('整理失败，请检查网络后重试', 'error');
    } finally {
        button.textContent = idle || '整理日志';
        await loadJournal();
    }
}

async function submitSetup() {
    const password = $('setup-pass').value;
    if (password.length < 8) return setMessage('setup-msg', '密码至少 8 位', 'error');
    if (password !== $('setup-pass2').value) return setMessage('setup-msg', '两次输入不一致', 'error');

    setMessage('setup-msg', '正在设置…');
    const { status, data } = await api('/setup-password', { password });
    if (status !== 200) return setMessage('setup-msg', data.error || '设置失败', 'error');

    $('setup-pass').value = '';
    $('setup-pass2').value = '';
    setMessage('setup-msg', '');
    toast('admin 的密码已设置');
    await refresh();
}

async function submitLogin() {
    const name = $('login-name').value.trim() || 'admin';
    setMessage('login-msg', '正在登录…');
    const { status, data } = await api('/login', {
        name,
        password: $('login-pass').value,
        // 本页只让管理员进：非管理员账户请从客户端登录
        requireAdmin: true,
    });
    if (status !== 200) return setMessage('login-msg', data.error || '登录失败', 'error');

    $('login-pass').value = '';
    setMessage('login-msg', '');
    await refresh();
}

async function submitPasswordChange() {
    const next = $('pass-new').value;
    if (next.length < 8) return toast('新密码至少 8 位', 'error');
    if (next !== $('pass-new2').value) return toast('两次输入的新密码不一致', 'error');

    const { status, data } = await api('/password', { oldPassword: $('pass-old').value, newPassword: next });
    if (status === 401) return refresh();
    if (status !== 200) return toast(data.error || '修改失败', 'error');

    $('pass-old').value = '';
    $('pass-new').value = '';
    $('pass-new2').value = '';
    toast('密码已更新，其他登录会话已失效');
}

async function createToken() {
    const { status, data } = await api('/tokens', {
        user: state.account,
        name: $('new-name').value,
        device: $('new-device').value,
    });
    if (status === 401) return refresh();
    if (status !== 200) return toast(data.error || '创建失败', 'error');

    $('new-token').textContent = data.token || '';
    $('reset-secret').hidden = true;
    $('new-name').value = '';
    $('new-device').value = '';
    toast('令牌已创建');
    await loadTokens();
    showSecret('new-secret');
}

async function createUser() {
    const name = $('user-name').value.trim();
    const password = $('user-pass').value;
    if (!name) return toast('请填写账户名', 'error');
    if (password.length < 8) return toast('账户密码至少 8 位', 'error');

    const { status, data } = await api('/users/create', {
        name,
        password,
        admin: $('user-admin').checked,
    });
    if (status === 401) return refresh();
    if (status !== 200) return toast(data.error || '新建失败', 'error');

    $('user-name').value = '';
    $('user-pass').value = '';
    $('user-admin').checked = false;
    toast('已新建账户「' + data.user.name + '」');
    // 新建的账户直接选上：接着就能给它建令牌
    state.account = data.user.id;
    await reloadUsers();
}

function bindEvents() {
    $('setup-btn').addEventListener('click', submitSetup);
    $('login-btn').addEventListener('click', submitLogin);
    $('user-create').addEventListener('click', () => {
        createUser().catch((error) => {
            console.error('新建账户失败:', error);
            toast('新建账户失败，请检查网络后重试', 'error');
        });
    });
    $('account-select').addEventListener('change', async (event) => {
        state.account = event.currentTarget.value;
        renderAccountMeta();
        // 换了账户，令牌与日志两节跟着换
        await loadTokens();
        await loadJournal();
    });
    $('new-btn').addEventListener('click', createToken);
    $('pass-btn').addEventListener('click', submitPasswordChange);
    $('logout-btn').addEventListener('click', async () => {
        await api('/logout', {});
        state.account = '';
        await refresh();
        toast('已退出登录');
    });

    $('new-copy').addEventListener('click', (event) => copyElement('new-token', event.currentTarget));
    $('reset-copy').addEventListener('click', (event) => copyElement('reset-token', event.currentTarget));
    selectAllOnClick('new-token');
    selectAllOnClick('reset-token');

    $('journal-refresh').addEventListener('click', async () => {
        await loadJournal();
        toast('日志概览已刷新');
    });
    $('journal-compact').addEventListener('click', () => {
        compactJournal().catch((error) => {
            console.error('整理日志失败:', error);
            setMessage('journal-status', '整理失败，请检查网络后重试', 'error');
        });
    });
    $('journal-download').addEventListener('click', () => {
        downloadJournal().catch((error) => {
            console.error(error);
            setMessage('journal-status', '下载失败，请检查网络后重试', 'error');
        });
    });

    [['setup-pass', 'setup-pass2', submitSetup], ['login-pass', null, submitLogin],
     ['login-name', null, submitLogin], ['pass-new', 'pass-new2', submitPasswordChange],
     ['user-pass', null, createUser]]
        .forEach(([first, second, handler]) => {
            [first, second].filter(Boolean).forEach((id) => {
                $(id).addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') handler();
                });
            });
        });
}

initTheme();
bindEvents();
refresh();
