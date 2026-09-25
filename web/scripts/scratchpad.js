/* 小本本：贴在右下角的一块便利贴。
   桌面版的「小本本」是一个始终置顶的独立窗口；浏览器里没有置顶窗口，
   网页版把它做成页面内一块可拖动、可最小化的浮层，行为与桌面版一致：

     - 未关联笔记时，内容属于小本本自身（数据目录下的 scratchpad.json），点「保存」即在后台新建一篇笔记并自动关联；
     - 选择「选择」可搜索并打开已有笔记，此后小本本编辑的即为该篇笔记；
     - 编辑自动保存，Ctrl + S 立即保存。

   数据只落在本浏览器（IndexedDB），不进同步队列（见 scripts/store.js 的说明）。 */

const SCRATCHPAD_SAVE_DELAY = 600;

let scratchpadTimer = null;
let scratchpadDrag = null;
let scratchpadReady = false;

function scratchpadPanel() {
    return document.getElementById('scratchpad-panel');
}

function scratchpadLinkedItem() {
    if (!State.scratchpadLinkedId) return null;
    return getItemById(State.scratchpadLinkedId);
}

function setScratchpadState(text) {
    const el = document.getElementById('scratchpad-state');
    if (el) el.textContent = text;
}

function updateScratchpadCount() {
    const content = document.getElementById('scratchpad-content').value || '';
    document.getElementById('scratchpad-count').textContent = `${content.length} 字`;
}

function updateScratchpadLinkLabel() {
    const item = scratchpadLinkedItem();
    const label = document.getElementById('scratchpad-link-text');
    const button = document.getElementById('scratchpad-link');
    if (!item) {
        label.textContent = '未关联';
        button.title = '选择要编辑的笔记';
        return;
    }
    label.textContent = itemDisplayTitle(item);
    button.title = `正在编辑《${itemDisplayTitle(item)}》，点击可换一篇`;
}

// 打开小本本时载入内容：已关联则取那篇笔记，否则取 scratchpad.json
function loadScratchpadContent() {
    const item = scratchpadLinkedItem();
    // 已关联的笔记正文加密时小本本不接管：网页版解不开密文，接管只会看到一串密文
    if (item && isSecretLocked(item)) {
        State.scratchpadLinkedId = '';
        document.getElementById('scratchpad-title').value = '';
        document.getElementById('scratchpad-content').value = '';
        updateScratchpadLinkLabel();
        updateScratchpadCount();
        setScratchpadState('只读 · 原笔记正文已加密（需在桌面版解锁）');
        return;
    }

    const payload = item
        ? { title: item.title || '', content: item.content || '' }
        : loadScratchpadFile();

    if (!item && payload.linkedId && getItemById(payload.linkedId) && !isSecretLocked(getItemById(payload.linkedId))) {
        // 上次关联的笔记还在：继续编辑它
        State.scratchpadLinkedId = payload.linkedId;
        const linked = getItemById(payload.linkedId);
        document.getElementById('scratchpad-title').value = linked.title || '';
        document.getElementById('scratchpad-content').value = linked.content || '';
    } else {
        document.getElementById('scratchpad-title').value = payload.title || '';
        document.getElementById('scratchpad-content').value = payload.content || '';
    }

    updateScratchpadLinkLabel();
    updateScratchpadCount();
    setScratchpadState('就绪');
}

// 自动保存：已关联写回那篇笔记，未关联写 scratchpad.json
function scheduleScratchpadSave() {
    updateScratchpadCount();
    setScratchpadState('保存中…');
    clearTimeout(scratchpadTimer);
    scratchpadTimer = setTimeout(() => {
        scratchpadTimer = null;
        commitScratchpadSave();
    }, SCRATCHPAD_SAVE_DELAY);
}

function scratchpadValues() {
    return {
        title: document.getElementById('scratchpad-title').value,
        content: document.getElementById('scratchpad-content').value
    };
}

function commitScratchpadSave() {
    const values = scratchpadValues();
    const item = scratchpadLinkedItem();

    if (item) {
        if (isSecretLocked(item)) {
            setScratchpadState('只读 · 正文已加密（需在桌面版解锁）');
            return false;
        }
        if (isReadOnlyItem(item)) {
            setScratchpadState('只读 · 位于废纸篓');
            return false;
        }
        if (item.title === values.title && item.content === values.content) {
            setScratchpadState('已保存');
            return false;
        }
        item.title = values.title;
        item.content = values.content;
        item.updatedAt = Date.now();
        saveItem(item);
    } else {
        saveScratchpadFile({ title: values.title, content: values.content, linkedId: '' });
    }

    setScratchpadState('已保存');
    renderTabs();
    renderListPanel();
    return true;
}

function flushScratchpadSave() {
    if (scratchpadTimer) {
        clearTimeout(scratchpadTimer);
        scratchpadTimer = null;
    }
    return commitScratchpadSave();
}

// 「保存」按钮：未关联时新建一篇笔记并自动关联（与桌面版一致）
function saveScratchpadAsNote() {
    const values = scratchpadValues();
    if (!values.title.trim() && !values.content.trim()) {
        showToast('小本本还是空的，没有可保存的内容');
        return;
    }

    const item = scratchpadLinkedItem();
    if (item) {
        flushScratchpadSave();
        showToast(`已保存到《${itemDisplayTitle(item)}》`);
        return;
    }

    const now = Date.now();
    const note = {
        id: generateUniqueItemId('note'),
        title: values.title.trim() || deriveTitle(values.content) || '小本本',
        content: values.content,
        folder: DEFAULT_FOLDER,
        tags: [],
        isPinned: false,
        isTrashed: false,
        createdAt: now,
        updatedAt: now
    };
    markItemKind(note, 'note');
    State.notes.unshift(note);
    saveItem(note);
    State.scratchpadLinkedId = note.id;
    if (!State.folders.includes(note.folder)) State.folders.push(note.folder);
    saveConfig();
    // 内容已经进了笔记文件，小本本自身那份清掉，免得下次打开又冒出旧内容
    saveScratchpadFile({ title: '', content: '', linkedId: note.id });
    updateScratchpadLinkLabel();
    setScratchpadState('已保存到笔记');
    renderApp();
    showToast(`已新建笔记《${itemDisplayTitle(note)}》并关联小本本`);
}

/* ---------------- 选择笔记 ---------------- */

function renderScratchpadPicker() {
    const list = document.getElementById('scratchpad-list');
    const keyword = String(document.getElementById('scratchpad-search').value || '').trim().toLowerCase();
    list.innerHTML = '';

    const notes = State.notes
        .filter((item) => !item.isTrashed && !isSecretHidden(item) && !isSecretLocked(item))
        .filter((item) => !keyword || itemSearchText(item).includes(keyword))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 100);

    if (!notes.length) {
        list.innerHTML = '<div class="note-picker-empty">没有匹配的笔记</div>';
        return;
    }

    notes.forEach((note) => {
        const item = document.createElement('div');
        item.className = `note-picker-item ${note.id === State.scratchpadLinkedId ? 'active' : ''}`;
        item.innerHTML = `<span class="ms-icon sm">description</span>`
            + `<span class="note-picker-item-title">${escapeHTML(itemDisplayTitle(note))}</span>`;
        item.onclick = () => linkScratchpadToNote(note.id);
        list.appendChild(item);
    });
}

function openScratchpadPicker() {
    document.getElementById('scratchpad-picker').classList.remove('hidden');
    document.getElementById('scratchpad-search').value = '';
    renderScratchpadPicker();
    setTimeout(() => document.getElementById('scratchpad-search').focus(), 20);
}

function closeScratchpadPicker() {
    const picker = document.getElementById('scratchpad-picker');
    if (picker) picker.classList.add('hidden');
}

// 换一篇笔记：先把当前未保存的内容落盘，再切过去
function linkScratchpadToNote(noteId) {
    const note = getItemById(noteId);
    if (!note) return;

    const current = scratchpadLinkedItem();
    if (current && current.id !== noteId) {
        flushScratchpadSave();
    } else if (!current) {
        const values = scratchpadValues();
        saveScratchpadFile({ title: values.title, content: values.content, linkedId: '' });
    }

    State.scratchpadLinkedId = noteId;
    saveConfig();
    closeScratchpadPicker();

    document.getElementById('scratchpad-title').value = note.title || '';
    document.getElementById('scratchpad-content').value = note.content || '';
    updateScratchpadLinkLabel();
    updateScratchpadCount();
    setScratchpadState(isReadOnlyItem(note) ? '只读 · 位于废纸篓' : '就绪');
    showToast(`小本本已关联《${itemDisplayTitle(note)}》`);
}

/* ---------------- 开关与拖动 ---------------- */

function openScratchpad() {
    const panel = scratchpadPanel();
    panel.classList.remove('hidden');
    panel.classList.remove('minimized');
    State.scratchpadOpen = true;
    State.scratchpadMinimized = false;
    loadScratchpadContent();
    document.getElementById('scratchpad-content').focus();
}

function closeScratchpad() {
    flushScratchpadSave();
    closeScratchpadPicker();
    scratchpadPanel().classList.add('hidden');
    State.scratchpadOpen = false;
}

function toggleScratchpad() {
    if (State.scratchpadOpen) closeScratchpad();
    else openScratchpad();
}

function toggleScratchpadMinimize() {
    const panel = scratchpadPanel();
    State.scratchpadMinimized = !State.scratchpadMinimized;
    panel.classList.toggle('minimized', State.scratchpadMinimized);
}

// 拖动：按住标题栏移动整块浮层（拖过之后就改为 left/top 定位，不再贴着右下角）
function bindScratchpadDrag() {
    const handle = document.getElementById('scratchpad-titlebar');
    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('button')) return;
        const panel = scratchpadPanel();
        const box = panel.getBoundingClientRect();
        scratchpadDrag = {
            pointerId: event.pointerId,
            offsetX: event.clientX - box.left,
            offsetY: event.clientY - box.top
        };
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = `${box.left}px`;
        panel.style.top = `${box.top}px`;
        handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', (event) => {
        if (!scratchpadDrag || scratchpadDrag.pointerId !== event.pointerId) return;
        const panel = scratchpadPanel();
        const box = panel.getBoundingClientRect();
        const left = Math.min(Math.max(0, event.clientX - scratchpadDrag.offsetX), window.innerWidth - box.width);
        const top = Math.min(Math.max(0, event.clientY - scratchpadDrag.offsetY), window.innerHeight - 40);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
    });

    const finish = () => { scratchpadDrag = null; };
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
}

function initScratchpad() {
    if (scratchpadReady) return;
    scratchpadReady = true;

    document.getElementById('scratchpad-title').addEventListener('input', scheduleScratchpadSave);
    document.getElementById('scratchpad-content').addEventListener('input', scheduleScratchpadSave);
    document.getElementById('scratchpad-save').onclick = saveScratchpadAsNote;
    document.getElementById('scratchpad-minimize').onclick = toggleScratchpadMinimize;
    document.getElementById('scratchpad-close').onclick = closeScratchpad;
    document.getElementById('scratchpad-link').onclick = openScratchpadPicker;
    document.getElementById('scratchpad-picker-close').onclick = closeScratchpadPicker;
    document.getElementById('scratchpad-search').addEventListener('input', renderScratchpadPicker);

    bindScratchpadDrag();
    updateScratchpadLinkLabel();
}

// 小本本窗口内的 Ctrl + S：立即保存；未关联时新建为笔记并关联
function handleScratchpadKeydown(event) {
    if (!State.scratchpadOpen) return false;
    const ctrl = event.ctrlKey || event.metaKey;
    if (ctrl && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveScratchpadAsNote();
        return true;
    }
    if (ctrl && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        openScratchpadPicker();
        return true;
    }
    return false;
}
