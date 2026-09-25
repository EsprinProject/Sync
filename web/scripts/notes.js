/* 条目操作：新建、标签页、自动保存、置顶 / 废纸篓 / 导出，以及文件夹与标签的维护。
   笔记与待办共用同一套标签页与编辑器，取用当前条目一律走 getActiveItem()。 */

function getActiveTodo() {
    if (!State.activeNoteId) return null;
    return State.todos.find((item) => item.id === State.activeNoteId) || null;
}

function getActiveNote() {
    if (!State.activeNoteId) return null;
    return State.notes.find((item) => item.id === State.activeNoteId) || null;
}

function getActiveItem() {
    if (State.activeNoteId === 'settings') return null;
    return getActiveTodo() || getActiveNote();
}

function openTab(itemId) {
    if (!itemId) return;
    // 设置页不是条目：离开它去开别的条目时，把它那一枚标签一并收掉
    if (itemId !== 'settings') {
        State.openNoteIds = State.openNoteIds.filter((id) => id !== 'settings');
    }
    if (!State.openNoteIds.includes(itemId)) State.openNoteIds.push(itemId);
    State.activeNoteId = itemId;
}

function openSettingsTab() {
    if (!State.openNoteIds.includes('settings')) State.openNoteIds.push('settings');
    State.activeNoteId = 'settings';
    // 窄屏的设置是两级：每次进来先落在分类列表上，而不是上次那个分类的面板（见 scripts/settings.js）
    setSettingsSubpageOpen(false);
    renderApp();
}

function closeTab(itemId) {
    State.openNoteIds = State.openNoteIds.filter((id) => id !== itemId);
    if (State.activeNoteId === itemId) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }
}

// 新建条目的默认归属：沿用当前筛选（在文件夹 / 标签视图下新建时直接落进该分类）
function newItemDefaults() {
    const filter = State.currentFilter;
    return {
        folder: filter.startsWith('folder:') ? filter.slice(7) : DEFAULT_FOLDER,
        tags: filter.startsWith('tag:') ? [filter.slice(4)] : []
    };
}

function buildNewItem(isTodo) {
    const defaults = newItemDefaults();
    const now = Date.now();
    const item = {
        id: generateUniqueItemId(isTodo ? 'todo' : 'note'),
        title: '',
        content: '',
        folder: State.folders.includes(defaults.folder) ? defaults.folder : DEFAULT_FOLDER,
        tags: defaults.tags,
        isPinned: false,
        isTrashed: false,
        createdAt: now,
        updatedAt: now
    };
    if (isTodo) item.isDone = false;
    markItemKind(item, isTodo ? 'todo' : 'note');
    return item;
}

function createNewNote() {
    return createNewItem(false);
}

function createNewTodo() {
    return createNewItem(true);
}

function createNewItem(isTodo) {
    flushPendingSave();
    const item = buildNewItem(isTodo);
    saveItem(item);
    State[isTodo ? 'todos' : 'notes'].unshift(item);
    // 在另一类的视图下新建时切回对应视图，否则新条目不会出现在列表里
    if (isTodo && (State.currentFilter === 'all')) State.currentFilter = 'todos';
    if (!isTodo && State.currentFilter === 'todos') State.currentFilter = 'all';
    openTab(item.id);
    renderApp();

    setTimeout(() => {
        const titleInput = document.getElementById('input-note-title');
        if (titleInput) titleInput.focus();
    }, 30);

    showToast(isTodo ? '已创建新待办' : '已创建新笔记');
    return item;
}

/* ---------------- 自动保存 ---------------- */

let pendingSave = null;

function autoSaveActiveItem() {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item)) return;

    pendingSave = {
        itemId: item.id,
        title: document.getElementById('input-note-title').value,
        content: document.getElementById('textarea-note-content').value
    };

    document.getElementById('save-status').textContent = '保存中...';
    clearTimeout(State.saveTimer);
    State.saveTimer = setTimeout(() => {
        State.saveTimer = null;
        commitPendingSave();
        renderTabs();
        renderListPanel();
        updateStats();
        document.getElementById('save-status').textContent = '已保存';
    }, 300);
}

function commitPendingSave() {
    const pending = pendingSave;
    pendingSave = null;
    if (!pending) return false;

    const item = getItemById(pending.itemId);
    if (!item) return false;

    const titleChanged = item.title !== pending.title;
    item.title = pending.title;
    item.content = pending.content;
    item.updatedAt = Date.now();
    saveItem(item);

    // 标题变化会影响标签页与列表卡片，因此由调用方决定是否重画；这里只落数据
    if (titleChanged) renderTabs();
    return true;
}

function flushPendingSave() {
    if (State.saveTimer) {
        clearTimeout(State.saveTimer);
        State.saveTimer = null;
    }
    if (commitPendingSave()) {
        const status = document.getElementById('save-status');
        const item = getActiveItem();
        if (item && !isReadOnlyItem(item)) status.textContent = '已保存';
    }
}

/* ---------------- 置顶 / 废纸篓 / 导出 ---------------- */

function togglePin(itemId) {
    const item = getItemById(itemId);
    if (!item || item.isTrashed) return;
    item.isPinned = !item.isPinned;
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
    showToast(item.isPinned ? '已置顶' : '已取消置顶');
}

function moveToTrash(itemId) {
    const item = getItemById(itemId);
    if (!item || item.isTrashed) return;
    item.isTrashed = true;
    closeTab(itemId);
    saveItem(item);
    renderApp();
    showToast('已移入废纸篓');
}

function restoreFromTrash(itemId) {
    const item = getItemById(itemId);
    if (!item || !item.isTrashed) return;
    item.isTrashed = false;
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
    showToast('已恢复');
}

function toggleTodoDone(itemId) {
    const item = getItemById(itemId);
    if (!item || !isTodoItem(item) || item.isTrashed) return;
    item.isDone = !item.isDone;
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
    showToast(item.isDone ? '已标记为完成' : '已标记为未完成');
}

// 导出为 .md：元数据内嵌在文件里，这里只导出正文，与桌面版的行为一致
async function exportItemMarkdown(itemId) {
    if (State.activeNoteId === itemId) flushPendingSave();
    // 加密条目先解锁：导出的是正文，不是密文信封
    if (!await ensureItemRevealed(itemId)) return;
    const item = getItemById(itemId);
    if (!item) return;
    const name = `${item.title || `无标题${itemKindLabel(item)}`}.md`;
    downloadText(name, item.content || '');
    showToast('已导出 Markdown');
}

async function copyItemContent(itemId) {
    if (State.activeNoteId === itemId) flushPendingSave();
    if (!await ensureItemRevealed(itemId)) return;
    const item = getItemById(itemId);
    if (!item) return;
    const ok = await copyText(item.content || '');
    showToast(ok ? '正文已复制' : '复制失败：浏览器拒绝了剪贴板写入');
}

async function purgeItem(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    const label = itemKindLabel(item);
    const confirmed = await showConfirm(`彻底删除“${itemDisplayTitle(item)}”？`, {
        title: `彻底删除${label}`,
        detail: `该${label}将从本地与服务器日志中移除（服务器上已有的历史操作不会被回滚），此操作无法撤销。`,
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '彻底删除',
        danger: true
    });
    if (!confirmed) return;
    permanentlyDeleteItem(itemId);
}

function permanentlyDeleteItem(itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    deleteItemFile(item);
    State.notes = State.notes.filter((entry) => entry.id !== itemId);
    State.todos = State.todos.filter((entry) => entry.id !== itemId);
    closeTab(itemId);
    renderApp();
    showToast('已彻底删除');
}

async function clearTrash() {
    const confirmed = await showConfirm('确认清空废纸篓吗？', {
        title: '清空废纸篓',
        detail: '废纸篓中的所有笔记与待办都将被永久删除，此操作无法撤销。',
        type: 'warning',
        icon: 'delete_forever',
        confirmLabel: '清空',
        danger: true
    });
    if (!confirmed) return;

    performClearTrash();
}

// 真正的清空。确认步骤由调用方负责：侧边栏那枚走 showConfirm 弹窗，
// 手机底栏那枚（废纸篓下由「新建」换成「清空」）用贴底面板确认，两者不叠加。
function performClearTrash() {
    [...State.notes, ...State.todos].filter((item) => item.isTrashed).forEach((item) => deleteItemFile(item));
    State.openNoteIds = State.openNoteIds.filter((id) => !!getItemById(id));
    State.notes = State.notes.filter((item) => !item.isTrashed);
    State.todos = State.todos.filter((item) => !item.isTrashed);
    renderApp();
    showToast('已清空废纸篓');
}

// 废纸篓自动清理：按最后一次编辑时间判断是否过期
function purgeExpiredTrashItems() {
    const days = Number(State.trashRetentionDays) || 0;
    if (!days) return 0;

    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const expired = [...State.notes, ...State.todos].filter((item) => item.isTrashed && (item.updatedAt || 0) < cutoff);
    if (!expired.length) return 0;

    expired.forEach((item) => deleteItemFile(item));
    const ids = new Set(expired.map((item) => item.id));
    State.notes = State.notes.filter((item) => !ids.has(item.id));
    State.todos = State.todos.filter((item) => !ids.has(item.id));
    State.openNoteIds = State.openNoteIds.filter((id) => !ids.has(id));
    if (ids.has(State.activeNoteId)) State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    return ids.size;
}

/* ---------------- 文件夹与标签 ---------------- */

async function addFolder() {
    const name = await showPrompt('新建文件夹', {
        title: '新建文件夹',
        detail: '文件夹用于给笔记与待办分组，删除文件夹不会删除其中的内容。',
        icon: 'create_new_folder',
        label: '文件夹名称',
        placeholder: '例如：工作',
        confirmLabel: '创建'
    });
    if (name === null) return;
    if (!name) {
        showToast('创建失败：文件夹名称不能为空');
        return;
    }
    if (State.folders.includes(name)) {
        showToast('创建失败：同名文件夹已存在');
        return;
    }
    State.folders.push(name);
    saveConfig();
    State.currentFilter = `folder:${name}`;
    renderApp();
    showToast(`已创建文件夹「${name}」`);
}

async function renameFolder(folder) {
    const name = await showPrompt('重命名文件夹', {
        title: '重命名文件夹',
        detail: '文件夹中的笔记与待办会一并跟随新名称，内容本身不变。',
        icon: 'edit',
        label: '文件夹名称',
        value: folder,
        placeholder: '例如：工作',
        confirmLabel: '重命名'
    });
    if (name === null) return;
    if (!name) {
        showToast('重命名失败：文件夹名称不能为空');
        return;
    }
    if (name === folder) return;
    if (State.folders.includes(name)) {
        showToast('重命名失败：同名文件夹已存在');
        return;
    }

    State.folders = State.folders.map((item) => (item === folder ? name : item));
    [...State.notes, ...State.todos].forEach((item) => {
        if (item.folder !== folder) return;
        item.folder = name;
        item.updatedAt = Date.now();
        saveItem(item);
    });
    // 正停在该文件夹的视图跟着换到新名字上，否则筛选条件会指向一个已不存在的文件夹
    if (State.currentFilter === `folder:${folder}`) State.currentFilter = `folder:${name}`;
    saveConfig();
    renderApp();
    showToast(`已重命名为「${name}」`);
}

async function removeFolder(folder) {
    const confirmed = await showConfirm(`删除文件夹“${folder}”？`, {
        title: '删除文件夹',
        detail: '该文件夹中的笔记与待办将移入“默认”文件夹，内容本身不会被删除。',
        type: 'warning',
        icon: 'delete',
        confirmLabel: '删除',
        danger: true
    });
    if (!confirmed) return;

    State.folders = State.folders.filter((name) => name !== folder);
    [...State.notes, ...State.todos].forEach((item) => {
        if (item.folder !== folder) return;
        item.folder = DEFAULT_FOLDER;
        item.updatedAt = Date.now();
        saveItem(item);
    });
    if (State.currentFilter === `folder:${folder}`) State.currentFilter = 'all';
    saveConfig();
    renderApp();
    showToast('已删除文件夹');
}

function setItemFolder(folder) {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item)) return;
    if (!State.folders.includes(folder)) return;
    item.folder = folder;
    item.updatedAt = Date.now();
    saveItem(item);
    renderListPanel();
    showToast(`已移动到「${folder}」`);
}

async function addTag() {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item)) return;

    const name = await showPrompt('添加标签', {
        title: '添加标签',
        detail: '标签用于跨文件夹筛选，同名标签会被合并显示在左侧「标签过滤」里。',
        icon: 'label',
        label: '标签名称',
        placeholder: '例如：想法',
        confirmLabel: '添加'
    });
    if (name === null) return;
    if (!name) {
        showToast('添加失败：标签名称不能为空');
        return;
    }
    if (!Array.isArray(item.tags)) item.tags = [];
    if (item.tags.includes(name)) {
        showToast('添加失败：该标签已存在');
        return;
    }
    item.tags.push(name);
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
    showToast(`已添加标签 #${name}`);
}

function removeTag(tag) {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item) || !Array.isArray(item.tags)) return;
    item.tags = item.tags.filter((name) => name !== tag);
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
}

/* ---------------- 导入 ---------------- */

const IMPORT_FILE_MAX = 100;
const IMPORT_FILE_MAX_BYTES = 5 * 1024 * 1024;

function pickImportFiles() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    input.style.display = 'none';
    input.addEventListener('change', () => {
        if (input.files && input.files.length) importFiles(input.files);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

async function importFiles(fileList) {
    const files = Array.from(fileList).slice(0, IMPORT_FILE_MAX);
    const overflow = fileList.length - files.length;
    const defaults = newItemDefaults();
    const imported = [];
    let failed = 0;

    for (const file of files) {
        try {
            if (file.size > IMPORT_FILE_MAX_BYTES) throw new Error('文件过大');
            const raw = await file.text();
            const { meta, content } = parseItemFile(raw);
            const now = Date.now();
            const metaFolder = meta ? readMetaString(meta.folder) : '';
            const metaTags = meta ? readMetaTags(meta.tags) : [];
            const item = {
                id: generateUniqueItemId('note'),
                // 标题优先级：文件内注释 > 文件名 > 正文首个非空行
                title: (meta ? readMetaString(meta.title) : '')
                    || file.name.replace(/\.[^.]+$/, '').trim()
                    || deriveTitle(content),
                content,
                folder: metaFolder && State.folders.includes(metaFolder) ? metaFolder : defaults.folder,
                tags: metaTags.length ? metaTags : defaults.tags,
                isPinned: false,
                isTrashed: false,
                createdAt: meta ? readMetaNumber(meta.createdAt, now) : now,
                updatedAt: now
            };
            markItemKind(item, 'note');
            State.notes.unshift(item);
            saveItem(item);
            imported.push(item);
        } catch (error) {
            failed += 1;
            console.error(`[ERROR] [Import] 导入失败 (file=${file.name}, detail=${error && error.message})`);
        }
    }

    if (!imported.length) {
        showToast('导入失败：所选文件无法读取');
        return;
    }
    if (State.currentFilter === 'todos') State.currentFilter = 'all';
    if (imported.length === 1) openTab(imported[0].id);
    renderApp();

    let summary = imported.length === 1
        ? `已导入笔记《${itemDisplayTitle(imported[0])}》`
        : `已导入 ${imported.length} 个文件为笔记`;
    if (failed) summary += `，另有 ${failed} 个失败`;
    if (overflow > 0) summary += `，${overflow} 个超出单次上限未导入`;
    showToast(summary);
}

/* ---------------- 视图模式 ---------------- */

function setViewMode(mode) {
    if (!['edit', 'split', 'preview'].includes(mode)) return;
    flushPendingSave();
    State.viewMode = mode;
    saveConfig();
    updateViewModeUI();
    flushRenderMarkdown();
}
