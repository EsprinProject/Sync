/* 界面渲染：侧边栏计数、文件夹与标签、标签页、中栏列表、工作区编辑器与同步状态。
   渲染函数只读 State，不修改数据；所有改动走 scripts/notes.js 里的条目操作。 */

let contextMenuItemId = null;

function renderApp() {
    renderCounts();
    renderFolders();
    renderTags();
    renderTabs();
    renderListPanel();
    renderWorkspace();
    renderSyncIndicator();
}

/* ---------------- 侧边栏 ---------------- */

function renderCounts() {
    let activeNoteCount = 0;
    let activeTodoCount = 0;
    let pinnedCount = 0;
    let trashedCount = 0;

    State.notes.forEach((note) => {
        if (isSecretHidden(note)) return;
        if (note.isTrashed) trashedCount += 1;
        else {
            activeNoteCount += 1;
            if (note.isPinned) pinnedCount += 1;
        }
    });
    State.todos.forEach((todo) => {
        if (isSecretHidden(todo)) return;
        if (todo.isTrashed) trashedCount += 1;
        else {
            activeTodoCount += 1;
            if (todo.isPinned) pinnedCount += 1;
        }
    });

    document.getElementById('count-all').textContent = activeNoteCount;
    document.getElementById('count-todos').textContent = activeTodoCount;
    document.getElementById('count-pinned').textContent = pinnedCount;
    document.getElementById('count-trash').textContent = trashedCount;
    document.getElementById('sidebar-stat').textContent = `共 ${activeNoteCount} 篇笔记 · ${activeTodoCount} 项待办`;

    document.querySelectorAll('.nav-section-main .nav-item').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-filter') === State.currentFilter);
    });
    // 手机端底部导航与侧边栏是同一套筛选：选中态跟着一起走（见 styles/mobile.css）
    document.querySelectorAll('.mobile-tab[data-filter]').forEach((el) => {
        el.classList.toggle('active', el.getAttribute('data-filter') === State.currentFilter);
    });
    // 同一枚「新建」在废纸篓下换成「清空」（图标、title 与展开哪张面板一起换）
    applyMobileFabMode(State.currentFilter === 'trash');
    // 列表表头的筛选：落在文件夹 / 标签上时点亮（其余四页的入口在底栏里）
    const filterToggle = document.getElementById('btn-list-filter');
    if (filterToggle) filterToggle.classList.toggle('active', isCategoryFilter(State.currentFilter));

    const clearBtn = document.getElementById('btn-empty-trash');
    clearBtn.classList.toggle('hidden', State.currentFilter !== 'trash');
    document.getElementById('panel-category-title').textContent = panelCategoryTitle(State.currentFilter);
}

/* 窄屏底栏中间那一枚：平时是「新建」（滑开二选一面板），切到废纸篓时改成「清空」
   （滑开确认面板）。展开态与两张面板的显隐交给 styles/mobile.css 的 .sheet-open /
   .trash-mode；这里同步图标、提示文字与 aria-controls，图标的换字形走一次淡入淡出。 */
const FAB_ICON_FADE_MS = 120;   // 与 mobile.css 里 .fab-circle .ms-icon 的 opacity 过渡（--motion-fast）成对改

let fabIconTimer = 0;

function applyMobileFabMode(trashMode) {
    const bar = document.getElementById('mobile-tabbar');
    const fab = document.getElementById('btn-mobile-fab');
    const icon = document.getElementById('btn-mobile-fab-icon');
    if (!bar || !fab || !icon) return;

    bar.classList.toggle('trash-mode', trashMode);
    swapFabIcon(fab, icon, trashMode ? 'delete_forever' : 'add');
    fab.title = trashMode ? '清空废纸篓' : '新建笔记或待办';
    fab.setAttribute('aria-controls', trashMode ? 'mobile-trash-sheet' : 'mobile-new-sheet');
}

/* 把图标淡掉、换字形、再淡回来。淡出期间又切一次（连着点两个页面）只保留最后一次：
   清掉计时器，字形等最后一次一起换；若两次切换正好抵回原字形（淡出还没走完），
   这里直接摘掉淡出态，图标原地淡回来即可 */
function swapFabIcon(button, icon, glyph) {
    clearTimeout(fabIconTimer);
    fabIconTimer = 0;
    if (icon.textContent === glyph) {
        button.classList.remove('icon-fading');
        return;
    }
    button.classList.add('icon-fading');
    fabIconTimer = setTimeout(() => {
        fabIconTimer = 0;
        icon.textContent = glyph;
        button.classList.remove('icon-fading');
    }, FAB_ICON_FADE_MS);
}

function renderFolders() {
    const container = document.getElementById('sidebar-folder-list');
    container.innerHTML = '';

    State.folders.forEach((folder) => {
        const isSelected = State.currentFilter === `folder:${folder}`;
        const item = document.createElement('div');
        item.className = `nav-item folder-item ${isSelected ? 'active' : ''}`;
        item.innerHTML = `
            <div class="nav-item-left">
                <span class="ms-icon sm">folder</span>
                <span class="nav-text">${escapeHTML(folder)}</span>
            </div>
        `;

        item.addEventListener('click', () => {
            State.currentFilter = `folder:${folder}`;
            renderApp();
        });

        // 改名与删除统一收进右键菜单，条目上不再挂删除按钮
        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            showFolderContextMenu(event.clientX, event.clientY, folder);
        });
        container.appendChild(item);
    });
}

function renderTags() {
    const container = document.getElementById('sidebar-tag-list');
    container.innerHTML = '';
    const tags = allTags();
    if (!tags.length) {
        container.innerHTML = '<span style="font-size: 11px; color: var(--text-muted); padding: 4px;">无标签</span>';
        return;
    }

    tags.forEach((tag) => {
        const isSelected = State.currentFilter === `tag:${tag}`;
        const pill = document.createElement('span');
        pill.className = `tag-pill ${isSelected ? 'active' : ''}`;
        pill.textContent = `#${tag}`;
        pill.title = `按标签 #${tag} 过滤`;
        pill.addEventListener('click', () => {
            State.currentFilter = isSelected ? 'all' : `tag:${tag}`;
            renderApp();
        });
        container.appendChild(pill);
    });
}

/* 现存标签（不含废纸篓与加密条目）：侧边栏的标签栏与窄屏的筛选面板共用 */
function allTags() {
    const tagSet = new Set();
    [...State.notes, ...State.todos].forEach((item) => {
        if (item.isTrashed || isSecretHidden(item)) return;
        if (Array.isArray(item.tags)) item.tags.forEach((tag) => { if (tag) tagSet.add(tag); });
    });
    return Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

/* ---------------- 标签页 ---------------- */

function tabTitle(id) {
    if (id === 'settings') return '设置';
    const item = getItemById(id);
    return item ? itemDisplayTitle(item) : '已删除的条目';
}

function tabIcon(id) {
    if (id === 'settings') return 'settings';
    const item = getItemById(id);
    return item && isTodoItem(item) ? 'check_box' : 'description';
}

/* 两个标签容器同时存在于页面里（标题栏一个、工作区顶部一个），
   渲染时只往当前布局的那一个里写，另一个当场清空——否则切回经典布局时
   会看到两排标签叠在一起。判定依据是 <html> 上的 .modern-layout（见 scripts/mode.js）。 */
function currentTabsContainer() {
    const modern = isModernLayout();
    const container = document.getElementById(modern ? 'workspace-tabs' : 'titlebar-tabs');
    const other = document.getElementById(modern ? 'titlebar-tabs' : 'workspace-tabs');
    if (other && other.childElementCount) {
        other.innerHTML = '';
        delete other.dataset.signature;
        other.classList.remove('tabs-fade-left', 'tabs-fade-right');
    }
    return container;
}

/* 标签栏两端的渐隐：只在「那一侧确实还有被截断的标签」时挂上类名，
   否则标签没排满、或已经滚到那一端时不该淡（见 styles/mode.css 的渐变遮罩）。 */
function updateTabsFade(container) {
    if (!container) return;
    const maxScroll = container.scrollWidth - container.clientWidth;
    container.classList.toggle('tabs-fade-left', maxScroll > 1 && container.scrollLeft > 1);
    container.classList.toggle('tabs-fade-right', maxScroll > 1 && container.scrollLeft < maxScroll - 1);
}

/* 标签栏的拖动排序：按住标签左右拖到别的标签上就换位，
   拖动期间只动 DOM 顺序（不重建），松手时把新顺序写回 State.openNoteIds。
   位移小于 4px 当作普通点击，交给标签自己的 click 处理。 */
let tabDrag = null;

function bindTabDrag(tab, container) {
    tab.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        if (event.target.closest('.tab-close-btn')) return;
        tabDrag = { id: tab.dataset.tabId, tab, container, startX: event.clientX, startY: event.clientY, started: false };
    });

    tab.addEventListener('pointermove', (event) => {
        if (!tabDrag || tabDrag.tab !== tab) return;
        if (!tabDrag.started) {
            const dx = Math.abs(event.clientX - tabDrag.startX);
            const dy = Math.abs(event.clientY - tabDrag.startY);
            if (dx < 4 || dx < dy) return;
            tabDrag.started = true;
            tab.classList.add('is-dragging');
            container.classList.add('is-dragging');
            tab.setPointerCapture(event.pointerId);
        }
        const siblings = Array.from(container.querySelectorAll('.tab-item'));
        const dragged = tab.getBoundingClientRect();
        const center = dragged.left + dragged.width / 2;
        let target = null;
        siblings.forEach((sibling) => {
            if (sibling === tab) return;
            const box = sibling.getBoundingClientRect();
            // 指针越过某标签的中线，就把它排到那个标签的前 / 后
            if (center < box.left + box.width / 2) {
                if (!target || box.left < target.getBoundingClientRect().left) target = sibling;
            }
        });
        if (target) {
            if (target.previousElementSibling !== tab) container.insertBefore(tab, target);
        } else if (container.lastElementChild !== tab) {
            container.appendChild(tab);
        }
        updateTabsFade(container);
    });

    const finishDrag = () => {
        if (!tabDrag || tabDrag.tab !== tab) return;
        const started = tabDrag.started;
        const activeContainer = tabDrag.container;
        tabDrag = null;
        tab.classList.remove('is-dragging');
        activeContainer.classList.remove('is-dragging');
        if (!started) return;
        // 把 DOM 顺序写回状态：拖动后的排列即为新顺序
        const order = Array.from(activeContainer.querySelectorAll('.tab-item')).map((el) => el.dataset.tabId);
        if (order.length === State.openNoteIds.length) State.openNoteIds = order;
        updateTabsFade(activeContainer);
    };

    tab.addEventListener('pointerup', finishDrag);
    tab.addEventListener('pointercancel', finishDrag);

    // 中键关闭：与浏览器标签页一致的习惯
    tab.addEventListener('auxclick', (event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        flushPendingSave();
        closeTab(tab.dataset.tabId);
        renderApp();
    });
}

function renderTabs() {
    const container = currentTabsContainer();
    // 关掉已经不存在的条目留下的标签
    State.openNoteIds = State.openNoteIds.filter((id) => !!getItemById(id));
    if (State.activeNoteId && State.activeNoteId !== 'settings' && !getItemById(State.activeNoteId)) {
        State.activeNoteId = State.openNoteIds[State.openNoteIds.length - 1] || null;
    }

    const signature = `${State.activeNoteId}\u0001${State.openNoteIds.map((id) => `${id}:${tabTitle(id)}`).join('\u0002')}`;
    if (container.dataset.signature === signature) return;
    container.dataset.signature = signature;

    container.innerHTML = '';
    State.openNoteIds.forEach((id) => {
        const tab = document.createElement('div');
        tab.className = `tab-item ${id === State.activeNoteId ? 'active' : ''}`;
        tab.dataset.tabId = id;
        tab.title = tabTitle(id);
        tab.innerHTML = `
            <span class="ms-icon xs tab-icon">${tabIcon(id)}</span>
            <span class="tab-title">${escapeHTML(tabTitle(id))}</span>
            <button class="tab-close-btn" type="button" title="关闭标签页">
                <span class="ms-icon xs">close</span>
            </button>
        `;

        tab.addEventListener('click', (event) => {
            if (event.target.closest('.tab-close-btn')) return;
            flushPendingSave();
            State.activeNoteId = id;
            renderApp();
        });

        tab.querySelector('.tab-close-btn').addEventListener('click', (event) => {
            event.stopPropagation();
            flushPendingSave();
            closeTab(id);
            renderApp();
        });

        tab.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            showTabContextMenu(event.clientX, event.clientY, id);
        });

        bindTabDrag(tab, container);
        container.appendChild(tab);
    });

    updateTabsFade(container);
}

/* ---------------- 中栏列表 ---------------- */

/* 列表进场：整列错开落位（关键帧见 styles/motion.css 的 #notes-list-box.list-enter）。
   只在「列表上下文变了」时挂上：筛选、排序、搜索词，以及条目集合的增删。
   不带时间戳、也不看列表顺序——编辑正文时自动保存每 300ms 刷新一次列表，
   若跟着挂类，打字过程中卡片会反复淡入。 */
let listEnterTimer = null;

function playListEnter(container, key) {
    if (container.dataset.enterKey === key) return;
    container.dataset.enterKey = key;
    container.classList.remove('list-enter');
    // 先摘再挂、并强制一次布局，同一个类名才会重新触发动画
    void container.offsetWidth;
    container.classList.add('list-enter');
    clearTimeout(listEnterTimer);
    listEnterTimer = setTimeout(() => container.classList.remove('list-enter'), 340);
}

function renderListPanel() {
    const container = document.getElementById('notes-list-box');

    const searchInput = document.getElementById('input-search');
    // 桌面端补上快捷键那截；窄屏的软键盘上没有修饰键，只留正文
    const placeholder = searchPlaceholderText(State.currentFilter) + (isNarrowScreen() ? '' : ' (Ctrl+K)');
    if (searchInput.placeholder !== placeholder) searchInput.placeholder = placeholder;
    searchInput.value = State.searchQuery;
    document.getElementById('btn-search-clear').classList.toggle('hidden', !State.searchQuery);
    document.getElementById('select-sort').value = State.sortBy;

    const list = fillListContainer(container, State.currentFilter);
    // 空列表不挂进场动画：一句说明没什么可错开落位的
    if (!list.length) return;

    playListEnter(container, `${State.currentFilter}\u0001${State.sortBy}\u0001${State.searchQuery}\u0001`
        + list.map((item) => item.id).sort().join(','));
}

/* 把某个筛选下的卡片铺进容器（空则一句说明），返回该筛选下的条目。
   与窄屏滑动切页时那张「相邻页」共用，两处因此永远长得一样（见 scripts/app.js 的 bindFilterSwipe） */
function fillListContainer(container, filter) {
    const list = getFilteredItems(filter);
    const isTrashView = filter === 'trash';

    container.innerHTML = '';
    if (!list.length) {
        container.innerHTML = `
            <div class="list-empty">
                ${State.searchQuery ? '无匹配内容' : '暂无内容<br>点「新建」创建笔记或待办'}
            </div>
        `;
        return list;
    }

    const fragment = document.createDocumentFragment();
    list.forEach((item) => {
        fragment.appendChild(isTodoItem(item) ? createTodoCard(item, isTrashView) : createNoteCard(item, isTrashView));
    });
    container.appendChild(fragment);
    return list;
}

/* 相邻页：与列表同一套样式（类名相同）的一整页卡片，滑动时临时挂在列表旁边 */
function buildListPage(filter) {
    const page = document.createElement('div');
    page.className = 'notes-list';
    fillListContainer(page, filter);
    return page;
}

function createNoteCard(note) {
    const card = document.createElement('div');
    card.className = `note-card ${note.id === State.activeNoteId ? 'active' : ''}`;
    card.innerHTML = `
        <div class="note-card-title">
            <span>${escapeHTML(note.title || '未命名笔记')}</span>
            ${note.locked === true ? '<span class="ms-icon xs fill" style="color: var(--accent);">lock</span>' : ''}
            ${note.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
        </div>
        <div class="note-card-preview">${escapeHTML(itemPreviewText(note))}</div>
        <div class="note-card-footer">
            <span>${formatDate(note.updatedAt)}</span>
            <span class="note-card-folder">${escapeHTML(note.folder)}</span>
        </div>
    `;
    bindCardEvents(card, note);
    return card;
}

function createTodoCard(todo, isTrashView) {
    const card = document.createElement('div');
    card.className = `note-card todo-card ${todo.id === State.activeNoteId ? 'active' : ''} ${todo.isDone ? 'done' : ''}`;
    card.innerHTML = `
        <button class="todo-check" type="button" title="${todo.isDone ? '标记为未完成' : '标记为已完成'}">
            <span class="ms-icon sm ${todo.isDone ? 'fill' : ''}">${todo.isDone ? 'check_circle' : 'radio_button_unchecked'}</span>
        </button>
        <div class="todo-card-body">
            <div class="note-card-title">
                <span>${escapeHTML(todo.title || '未命名待办')}</span>
                ${todo.locked === true ? '<span class="ms-icon xs fill" style="color: var(--accent);">lock</span>' : ''}
                ${todo.isPinned ? '<span class="ms-icon xs fill" style="color: var(--accent);">push_pin</span>' : ''}
            </div>
            <div class="note-card-preview">${escapeHTML(itemPreviewText(todo))}</div>
            <div class="note-card-footer">
                <span>${formatDate(todo.updatedAt)}</span>
                <span class="note-card-folder">${escapeHTML(todo.folder)}</span>
            </div>
        </div>
    `;
    card.querySelector('.todo-check').addEventListener('click', (event) => {
        event.stopPropagation();
        if (isTrashView || isReadOnlyItem(todo)) return;
        toggleTodoDone(todo.id);
    });
    bindCardEvents(card, todo);
    return card;
}

function bindCardEvents(card, item) {
    // 长按弹出的菜单会紧接着收到一次 click：那一下不算「打开条目」，也不让它冒到 document
    let suppressClick = false;

    card.addEventListener('click', (event) => {
        if (suppressClick) {
            suppressClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        openTab(item.id);
        renderApp();
    });
    card.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        showItemContextMenu(event.clientX, event.clientY, item.id);
    });

    // 手机端没有右键：卡片右上角的「更多」与长按都落到同一套菜单（按钮只在窄屏排出来）
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'note-card-more';
    more.title = '更多操作';
    more.innerHTML = '<span class="ms-icon sm">more_vert</span>';
    more.addEventListener('click', (event) => {
        event.stopPropagation();
        const box = more.getBoundingClientRect();
        showItemContextMenu(box.right - 6, box.bottom + 4, item.id);
    });
    card.appendChild(more);

    let pressTimer = 0;
    const cancelPress = () => {
        if (!pressTimer) return;
        clearTimeout(pressTimer);
        pressTimer = 0;
    };
    card.addEventListener('touchstart', (event) => {
        if (event.touches.length !== 1) return;
        const touch = event.touches[0];
        pressTimer = setTimeout(() => {
            pressTimer = 0;
            suppressClick = true;
            // 长按与右键同义：轻震一下给出「已经触发」的反馈
            if (navigator.vibrate) navigator.vibrate(10);
            showItemContextMenu(touch.clientX, touch.clientY, item.id);
        }, 500);
    }, { passive: true });
    card.addEventListener('touchmove', cancelPress, { passive: true });
    card.addEventListener('touchend', cancelPress);
    card.addEventListener('touchcancel', cancelPress);
}

/* ---------------- 工作区 ---------------- */

function renderWorkspace() {
    const sidebar = document.getElementById('app-sidebar');
    const notesPanel = document.querySelector('.notes-panel');
    const workspace = document.getElementById('workspace-box');
    const settingsView = document.getElementById('settings-view');
    const titleArea = document.querySelector('.editor-title-area');
    const contentArea = document.querySelector('.editor-content-area');
    const footer = document.querySelector('.editor-footer');
    const topbar = document.getElementById('editor-topbar');
    const toolbar = document.getElementById('editor-toolbar');
    const emptyState = document.getElementById('empty-state');

    if (State.activeNoteId === 'settings') {
        sidebar.classList.add('hidden');
        notesPanel.classList.add('hidden');
        workspace.classList.add('hidden');
        settingsView.classList.remove('hidden');
        // 设置页占据整个窗口：AI 面板也在这一刻就地收起（见 scripts/ai.js）
        applyAiPanelVisibility();
        renderSettingsView();
        return;
    }

    sidebar.classList.remove('hidden');
    notesPanel.classList.remove('hidden');
    workspace.classList.remove('hidden');
    settingsView.classList.add('hidden');
    applyAiPanelVisibility();

    const item = getActiveItem();
    const panelElements = [topbar, toolbar, titleArea, contentArea, footer];

    if (!item) {
        // 窄屏退出编辑器时整块正在往右滑出屏幕（见 scripts/app.js 的 beginEditorLeave）：
        // 各段先原样留着，等滑完的收尾重绘再收起 —— 同一帧就收起的话，滑出去的只是一块空板子
        const leaving = isEditorLeaving();
        emptyState.classList.toggle('hidden', leaving);
        panelElements.forEach((el) => el.classList.toggle('hidden', !leaving));
        document.getElementById('editor-pane').classList.toggle('hidden', !leaving);
        document.getElementById('preview-pane').classList.toggle('hidden', !leaving);
        // 本地为空且尚未接上服务端时才提示接入，避免长期占位
        const hint = document.getElementById('empty-hint');
        const isEmpty = !State.notes.length && !State.todos.length;
        const showHint = isEmpty && !State.sync.enabled;
        hint.classList.toggle('hidden', !showHint);
        if (showHint) {
            hint.textContent = '暂无内容：登录服务端后可拉取服务器上已有的笔记';
        }
        updateAiScopeOptions();
        return;
    }

    emptyState.classList.add('hidden');
    panelElements.forEach((el) => el.classList.remove('hidden'));

    const isTodo = isTodoItem(item);
    const readOnly = isReadOnlyItem(item);
    const titleInput = document.getElementById('input-note-title');
    const contentInput = document.getElementById('textarea-note-content');

    titleInput.placeholder = isTodo ? '无标题待办...' : '无标题笔记...';
    if (document.activeElement !== titleInput) titleInput.value = item.title || '';
    // 加密条目：正文取出来的是密文信封，不往编辑器里放（由只读提示接手）
    if (document.activeElement !== contentInput) contentInput.value = isSecretLocked(item) ? '' : (item.content || '');
    contentInput.spellcheck = !!State.spellcheck;

    // 文件夹下拉
    const folderSelect = document.getElementById('editor-folder-select');
    const foldersSignature = `${item.folder}\u0001${State.folders.join('\u0001')}`;
    if (folderSelect.dataset.signature !== foldersSignature) {
        folderSelect.dataset.signature = foldersSignature;
        folderSelect.innerHTML = '';
        State.folders.forEach((folder) => {
            const option = document.createElement('option');
            option.value = folder;
            option.textContent = folder;
            folderSelect.appendChild(option);
        });
        folderSelect.value = State.folders.includes(item.folder) ? item.folder : DEFAULT_FOLDER;
        const entry = CUSTOM_SELECTS.find((select) => select.select === folderSelect);
        markCustomSelectDirty(entry);
        refreshCustomSelect(entry);
    }
    folderSelect.disabled = readOnly;

    // 标签
    const tagsContainer = document.getElementById('editor-tags-container');
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const tagsSignature = `${readOnly ? 1 : 0}\u0001${tags.join('\u0001')}`;
    if (tagsContainer.dataset.signature !== tagsSignature) {
        tagsContainer.dataset.signature = tagsSignature;
        tagsContainer.innerHTML = '';
        tags.forEach((tag) => {
            const chip = document.createElement('span');
            chip.className = 'editor-tag-chip';
            chip.innerHTML = `<span>#${escapeHTML(tag)}</span>`;
            if (!readOnly) {
                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.title = '移除标签';
                removeBtn.innerHTML = '<span class="ms-icon xs">close</span>';
                removeBtn.onclick = () => removeTag(tag);
                chip.appendChild(removeBtn);
            }
            tagsContainer.appendChild(chip);
        });
    }

    const addTagBtn = document.getElementById('btn-add-tag');
    addTagBtn.disabled = readOnly;

    // 待办完成开关
    const doneBtn = document.getElementById('btn-todo-done');
    doneBtn.classList.toggle('hidden', !isTodo);
    if (isTodo) {
        doneBtn.querySelector('.ms-icon').textContent = item.isDone ? 'check_circle' : 'radio_button_unchecked';
        doneBtn.style.color = item.isDone ? 'var(--accent)' : 'var(--text-secondary)';
        doneBtn.title = item.isDone ? '标记为未完成' : '标记为已完成';
        doneBtn.disabled = readOnly;
    }

    applyEditorReadOnly(item);
    applySecretLockUI(item);
    updateViewModeUI();
    flushRenderMarkdown();
    updateStats();
    updateSaveStatus();
    updateAiScopeOptions();
}

/* ---------------- 编辑器 ----------------
   预览刷新、字数统计、只读态与格式化插入，规则与桌面版 scripts/editor.js 一致 */

const PREVIEW_REFRESH_DELAY = 1000;
const CJK_CHAR_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{3ffff}]/gu;

let lastPreviewItemId = null;
let lastPreviewContent = null;

function isPreviewVisible() {
    return State.viewMode !== 'edit';
}

function scheduleRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = setTimeout(() => {
        State.previewTimer = null;
        renderMarkdown();
    }, PREVIEW_REFRESH_DELAY);
}

function flushRenderMarkdown() {
    clearTimeout(State.previewTimer);
    State.previewTimer = null;
    renderMarkdown(true);
}

function renderMarkdown(force = false) {
    if (!isPreviewVisible()) return;

    const item = getActiveItem();
    const itemId = item ? item.id : null;
    // 加密且未解锁的条目：正文还是密文，解析出来没有意义，预览直接留空
    if (isSecretLocked(item)) {
        lastPreviewItemId = itemId;
        lastPreviewContent = null;
        document.getElementById('preview-content').innerHTML = '';
        return;
    }
    const content = item ? (item.content || '') : '';
    if (!force && itemId === lastPreviewItemId && content === lastPreviewContent) return;
    lastPreviewItemId = itemId;
    lastPreviewContent = content;

    const container = document.getElementById('preview-content');
    if (!item) {
        container.innerHTML = '';
        return;
    }
    container.innerHTML = Markdown.parse(content || '*空内容*');

    // 预览里的勾选框可直接改任务清单：按出现顺序对应正文里的 - [ ] / - [x]
    container.querySelectorAll('input[type="checkbox"]').forEach((checkbox, index) => {
        checkbox.removeAttribute('disabled');
        checkbox.onchange = () => {
            const active = getActiveItem();
            if (!active || isReadOnlyItem(active)) return;
            let cursor = 0;
            active.content = (active.content || '').replace(/(- \[ ]|- \[x])/gi, (match) => {
                if (cursor === index) {
                    cursor += 1;
                    return checkbox.checked ? '- [x]' : '- [ ]';
                }
                cursor += 1;
                return match;
            });
            document.getElementById('textarea-note-content').value = active.content;
            autoSaveActiveItem();
        };
    });
}

function countWords(text) {
    if (!text) return 0;
    const segments = text.split(CJK_CHAR_PATTERN);
    let words = 0;
    for (let i = 0; i < segments.length; i++) {
        const segment = segments[i].trim();
        if (segment) words += segment.split(/\s+/).length;
    }
    return (segments.length - 1) + words;
}

function updateStats() {
    const item = getActiveItem();
    if (!item) return;
    const content = isSecretLocked(item) ? '' : (item.content || '');
    document.getElementById('stat-char-count').textContent = isSecretLocked(item) ? '字符: —' : `字符: ${content.length}`;
    document.getElementById('stat-word-count').textContent = isSecretLocked(item) ? '字数: —' : `字数: ${countWords(content)}`;
    document.getElementById('stat-last-edit').textContent = `修改于 ${formatDate(item.updatedAt)}`;
}

const READONLY_STATUS_TEXT = '只读 · 位于废纸篓';
const LOCKED_STATUS_TEXT = '只读 · 正文已加密（未解锁）';

function applyEditorReadOnly(item) {
    const readOnly = isReadOnlyItem(item);
    const locked = isSecretLocked(item);
    const titleInput = document.getElementById('input-note-title');
    const contentInput = document.getElementById('textarea-note-content');
    const toolbar = document.getElementById('editor-toolbar');
    const folderSelect = document.getElementById('editor-folder-select');
    const addTagBtn = document.getElementById('btn-add-tag');

    titleInput.readOnly = readOnly;
    contentInput.readOnly = readOnly;
    folderSelect.disabled = readOnly;
    addTagBtn.disabled = readOnly;
    toolbar.classList.toggle('hidden', readOnly);

    const saveStatus = document.getElementById('save-status');
    if (readOnly) saveStatus.textContent = locked ? LOCKED_STATUS_TEXT : READONLY_STATUS_TEXT;
    else if (saveStatus.textContent === READONLY_STATUS_TEXT || saveStatus.textContent === LOCKED_STATUS_TEXT) saveStatus.textContent = '就绪';
}

function updateSaveStatus() {
    const item = getActiveItem();
    if (!item || isReadOnlyItem(item)) return;
    const status = document.getElementById('save-status');
    if (status.textContent === READONLY_STATUS_TEXT || status.textContent === LOCKED_STATUS_TEXT) {
        status.textContent = '就绪';
    }
}

function updateViewModeUI() {
    const editPane = document.getElementById('editor-pane');
    const previewPane = document.getElementById('preview-pane');

    document.getElementById('btn-mode-edit').classList.toggle('active', State.viewMode === 'edit');
    document.getElementById('btn-mode-split').classList.toggle('active', State.viewMode === 'split');
    document.getElementById('btn-mode-preview').classList.toggle('active', State.viewMode === 'preview');

    if (State.viewMode === 'edit') {
        editPane.classList.remove('hidden');
        previewPane.classList.add('hidden');
    } else if (State.viewMode === 'split') {
        editPane.classList.remove('hidden');
        previewPane.classList.remove('hidden');
    } else {
        editPane.classList.add('hidden');
        previewPane.classList.remove('hidden');
    }
}

// 排版工具栏：在光标处插入对应语法
function formatMarkdown(type) {
    const textarea = document.getElementById('textarea-note-content');
    if (textarea.readOnly) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.substring(start, end);
    let insert = '';

    switch (type) {
    case 'bold': insert = `**${selected || '加粗文本'}**`; break;
    case 'italic': insert = `*${selected || '斜体文本'}*`; break;
    case 'h1': insert = `# ${selected || '一级标题'}`; break;
    case 'h2': insert = `## ${selected || '二级标题'}`; break;
    case 'h3': insert = `### ${selected || '三级标题'}`; break;
    case 'ul': insert = `- ${selected || '列表项目'}`; break;
    case 'ol': insert = `1. ${selected || '列表项目'}`; break;
    case 'task': insert = `- [ ] ${selected || '待办项'}`; break;
    case 'quote': insert = `> ${selected || '引用内容'}`; break;
    case 'code': insert = `\`\`\`javascript\n${selected || '// 代码块'}\n\`\`\``; break;
    case 'hr': insert = '\n---\n'; break;
    default: return;
    }

    textarea.value = textarea.value.substring(0, start) + insert + textarea.value.substring(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + insert.length;
    autoSaveActiveItem();
    flushRenderMarkdown();
}

/* ---------------- 同步状态 ---------------- */

function renderSyncIndicator(state) {
    const chip = document.getElementById('btn-sync-status');
    const icon = document.getElementById('sync-chip-icon');
    const text = document.getElementById('sync-chip-text');
    if (!chip) return;

    chip.classList.remove('state-online', 'state-error', 'state-busy');

    if (!State.sync.enabled) {
        if (state === 'busy' || Sync.connection === 'connecting') {
            icon.textContent = 'sync';
            text.textContent = '连接中';
            chip.classList.add('state-busy');
            chip.title = '正在连接托管本页的服务端';
            return;
        }
        if (Sync.connection === 'auth') {
            icon.textContent = 'lock';
            text.textContent = '需登录';
            chip.classList.add('state-error');
            chip.title = Sync.connectionMessage || '需要登录后才能读写服务端';
            return;
        }
        icon.textContent = 'cloud_off';
        text.textContent = Sync.outbox.length ? `未连接 · 待推送 ${Sync.outbox.length}` : '未连接';
        if (Sync.connection === 'error') {
            chip.classList.add('state-error');
            chip.title = Sync.connectionMessage || '服务端连接失败：请检查地址与网络后重试';
        } else {
            chip.title = Sync.outbox.length
                ? `未连接到服务端：${Sync.outbox.length} 条改动在队列里，登录后会自动上传`
                : '未连接到服务端：请先登录或填写访问令牌';
        }
        return;
    }
    if (state === 'busy' || Sync.running) {
        icon.textContent = 'sync';
        text.textContent = '同步中';
        chip.classList.add('state-busy');
        chip.title = '正在与服务器同步';
        return;
    }
    if (Sync.lastError) {
        icon.textContent = 'cloud_off';
        text.textContent = '同步异常';
        chip.classList.add('state-error');
        chip.title = `${Sync.lastError}（点击重试）`;
        return;
    }
    if (Sync.outbox.length) {
        icon.textContent = 'cloud_upload';
        text.textContent = `待推送 ${Sync.outbox.length}`;
        chip.classList.add('state-online');
        chip.title = '本地改动已排队，稍后推送；点击立即同步';
        return;
    }
    icon.textContent = 'cloud_done';
    text.textContent = '已连接';
    chip.classList.add('state-online');
    const who = State.sync.account ? `账户 ${State.sync.account} · ` : '';
    chip.title = State.sync.lastSyncAt
        ? `${who}上次同步 ${formatDateTime(State.sync.lastSyncAt)} · ${State.sync.lastSyncSummary}（点击立即同步）`
        : `已连接服务端（${who}尚未同步）；点击立即同步`;
}

// 远端变更落进本地后刷新界面。设置页里正在填写内容时只刷列表与状态，
// 避免整棵重建把输入框里的内容冲掉
function refreshAfterRemoteChange() {
    const active = document.activeElement;
    const settingsContent = document.getElementById('settings-content');
    if (State.activeNoteId === 'settings' && active && settingsContent && settingsContent.contains(active)) {
        renderListPanel();
        renderSyncIndicator();
        return;
    }
    renderApp();
    showToast('已应用远端变更');
}

/* ---------------- 右键菜单 ---------------- */

function hideContextMenu() {
    const menu = document.getElementById('context-menu');
    menu.classList.add('hidden');
    // data-menu-kind 留到下次 buildContextMenu 再改写：窄屏收起时整块面板还要滑一段，
    // 层级（条目菜单压在底栏之下）得继续按原来那一种菜单算，见 styles/mobile.css 第 3 节
    contextMenuItemId = null;
}

/* 菜单内容与来源：kind 用来区分「新建条目」与其它菜单，
   触发按钮据此判断再次点击时该收起还是重建 */
function buildContextMenu(x, y, entries, kind = '') {
    const menu = document.getElementById('context-menu');
    menu.innerHTML = '';
    menu.dataset.menuKind = kind;

    entries.forEach((entry) => {
        if (entry.divider) {
            const divider = document.createElement('div');
            divider.className = 'context-menu-divider';
            menu.appendChild(divider);
            return;
        }
        const button = document.createElement('div');
        button.className = `context-menu-item ${entry.danger ? 'danger' : ''} ${entry.active ? 'active' : ''}`;
        button.innerHTML = `<span class="ms-icon sm">${entry.icon}</span><span>${escapeHTML(entry.label)}</span>`
            + (entry.active ? '<span class="ms-icon sm context-menu-item-check">check</span>' : '');
        button.onclick = () => {
            hideContextMenu();
            entry.action();
        };
        menu.appendChild(button);
    });

    menu.classList.remove('hidden');
    const box = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - box.width - 8);
    const top = Math.min(y, window.innerHeight - box.height - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
}

function showItemContextMenu(x, y, itemId) {
    const item = getItemById(itemId);
    if (!item) return;
    contextMenuItemId = itemId;
    const isTodo = isTodoItem(item);

    const entries = [];
    if (item.isTrashed) {
        entries.push({ icon: 'restore_from_trash', label: '恢复', action: () => restoreFromTrash(itemId) });
        entries.push({ icon: 'content_copy', label: '复制正文', action: () => copyItemContent(itemId) });
        entries.push({ icon: 'download', label: '导出 Markdown', action: () => exportItemMarkdown(itemId) });
        entries.push({ divider: true });
        entries.push({ icon: 'delete_forever', label: '彻底删除', danger: true, action: () => purgeItem(itemId) });
    } else {
        entries.push({
            icon: item.isPinned ? 'push_pin' : 'keep',
            label: item.isPinned ? '取消置顶' : '置顶',
            action: () => togglePin(itemId)
        });
        if (isTodo) {
            entries.push({
                icon: 'check_circle',
                label: item.isDone ? '标记为未完成' : '标记为已完成',
                action: () => toggleTodoDone(itemId)
            });
        }
        /* 秘密本：隐藏与密码。隐藏后条目不再出现在任何列表里，只能去「设置 → 秘密本」找回。
           已解锁的加密条目另给一个马上重新上锁的入口 */
        entries.push({
            icon: item.isHidden === true ? 'visibility' : 'visibility_off',
            label: item.isHidden === true ? '取消隐藏' : '隐藏文档',
            action: () => toggleItemHidden(itemId)
        });
        entries.push(item.locked === true
            ? { icon: 'key_off', label: '解除密码', action: () => removeItemPassword(itemId) }
            : { icon: 'lock', label: '设置密码', action: () => setItemPassword(itemId) });
        if (item.locked === true && item.unlocked === true) {
            entries.push({ icon: 'lock', label: '立即锁定', action: () => lockItemNow(itemId) });
        }
        entries.push({ icon: 'content_copy', label: '复制正文', action: () => copyItemContent(itemId) });
        entries.push({ icon: 'download', label: '导出 Markdown', action: () => exportItemMarkdown(itemId) });
        entries.push({ divider: true });
        entries.push({ icon: 'delete', label: '移入废纸篓', danger: true, action: () => moveToTrash(itemId) });
    }
    buildContextMenu(x, y, entries, 'item');
}

/* 文件夹右键菜单：重命名与删除。
   「默认」是条目没有归属时的落脚点，既不能改名也不能删除，因此不为它开菜单 */
function showFolderContextMenu(x, y, folder) {
    if (folder === DEFAULT_FOLDER) return;
    buildContextMenu(x, y, [
        { icon: 'edit', label: '重命名文件夹', action: () => renameFolder(folder) },
        { icon: 'delete', label: '删除文件夹', danger: true, action: () => removeFolder(folder) }
    ], 'folder');
}

function showTabContextMenu(x, y, tabId) {
    buildContextMenu(x, y, [
        { icon: 'close', label: '关闭', action: () => { closeTab(tabId); renderApp(); } },
        {
            icon: 'tab_close',
            label: '关闭其他标签',
            action: () => {
                State.openNoteIds = State.openNoteIds.filter((id) => id === tabId);
                State.activeNoteId = tabId;
                renderApp();
            }
        },
        {
            icon: 'close_fullscreen',
            label: '关闭全部标签',
            action: () => {
                State.openNoteIds = [];
                State.activeNoteId = null;
                renderApp();
            }
        }
    ], 'tab');
}

function showNewItemMenu(x, y) {
    buildContextMenu(x, y, [
        { icon: 'description', label: '新建笔记', action: () => createNewNote() },
        { icon: 'check_box', label: '新建待办', action: () => createNewTodo() },
        { divider: true },
        { icon: 'upload_file', label: '导入 Markdown / 文本', action: () => pickImportFiles() }
    ], 'new-item');
}

/* 列表表头的「筛选」（窄屏专有）：手机端没有侧边栏，文件夹与标签过滤收在这一张面板里
   （四个主入口不在这里 —— 它们在底部主导航里）。当前生效的那一条带对勾；
   正筛着文件夹 / 标签时头一条是「清除筛选」，回到「全部笔记」 */
function showFilterMenu(x, y) {
    const entries = [];
    if (isCategoryFilter(State.currentFilter)) {
        entries.push({ icon: 'filter_list_off', label: '清除筛选', action: () => applyMobileFilter('all') });
        entries.push({ divider: true });
    }

    State.folders.forEach((folder) => entries.push({
        icon: 'folder',
        label: folder,
        active: State.currentFilter === `folder:${folder}`,
        action: () => applyMobileFilter(`folder:${folder}`)
    }));
    entries.push({ icon: 'create_new_folder', label: '新建文件夹', action: () => addFolder() });

    const tags = allTags();
    if (tags.length) {
        entries.push({ divider: true });
        tags.forEach((tag) => entries.push({
            icon: 'label',
            label: `#${tag}`,
            active: State.currentFilter === `tag:${tag}`,
            action: () => applyMobileFilter(`tag:${tag}`)
        }));
    }
    buildContextMenu(x, y, entries, 'filter');
}

/* 顶栏右端的菜单（窄屏专有）：深浅色、设置与导入文件收在一处
   （桌面端这三件分别在顶栏的图标、侧边栏底栏里） */
function showTopbarMenu(x, y) {
    const dark = resolvedTheme() === 'dark';
    buildContextMenu(x, y, [
        {
            icon: dark ? 'light_mode' : 'dark_mode',
            label: dark ? '切换到浅色' : '切换到深色',
            action: () => toggleTheme()
        },
        { icon: 'settings', label: '设置', action: () => openSettingsTab() },
        { icon: 'upload_file', label: '导入文件', action: () => pickImportFiles() }
    ], 'topbar');
}

/* 几处菜单入口共用：同一个入口反复点击时在展开与收起之间切换
   （kind 记在 dataset 上，改用另一个入口打开时重建） */
function toggleContextMenu(kind, build, x, y) {
    const menu = document.getElementById('context-menu');
    if (menu.dataset.menuKind === kind && !menu.classList.contains('hidden')) {
        hideContextMenu();
        return;
    }
    build(x, y);
}

// 「新建」按钮：同一个按钮反复点击时在展开与收起之间切换
function toggleNewItemMenu(x, y) {
    toggleContextMenu('new-item', showNewItemMenu, x, y);
}
