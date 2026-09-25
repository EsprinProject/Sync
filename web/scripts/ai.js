/* AI 助手：工作区右侧的问答面板。
   与桌面版同一套面板行为与文案（对话记录、附带范围、附件、Agent 模式、流式回答），
   两处差异来自运行环境：
     1. 桌面版由主进程代理请求、密钥存在系统密钥链里；网页版只能由页面直连站点，
        密钥保存在本浏览器（localStorage），并可能受站点的 CORS 策略限制；
     2. 对话文件（ai_chats/{id}.json）落在本浏览器的 IndexedDB 里，不进同步队列，
        因此不会把对话记进服务器的操作日志（见 scripts/store.js 的说明）。 */

const AI_DEFAULT_SYSTEM_PROMPT = '你是 EsprinNemo 内置的笔记助手。回答尽量简洁、准确，'
    + '使用中文，并按 Markdown 排版。结合用户提供的笔记内容作答，不要编造笔记里没有的事实。';
const AI_AGENT_MAX_STEPS = 6;
const AI_AGENT_READ_CHAR_LIMIT = 20000;
const AI_AGENT_LIST_LIMIT = 100;
const AI_CONTEXT_MAX_NOTES = 10;
const AI_CONTEXT_MAX_CHARS = 4000;
const AI_ATTACH_MAX_BYTES = 8 * 1024 * 1024;
const AI_IMAGE_TYPES = /^image\//i;
const AI_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

/* ---------------- 接口地址与请求头 ----------------
   用户填写的是「API 站点」，可能带 /v1、也可能直接是完整的 /chat/completions 端点，
   这里统一折算为完整 URL（与桌面版 src/main/ai_service.js 的 buildEndpoint 同一套规则） */

function aiBuildEndpoint(baseUrl, suffix) {
    let base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';

    if (/\/chat\/completions$/i.test(base)) {
        if (suffix === 'chat/completions') return base;
        base = base.replace(/\/chat\/completions$/i, '');
    }
    // 已经写到版本号一级（如 https://api.openai.com/v1）时直接拼接
    if (/\/v\d+[a-z]*$/i.test(base)) return `${base}/${suffix}`;
    return `${base}/v1/${suffix}`;
}

function aiHeaders() {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json'
    };
    // 本地服务（Ollama 等）无需鉴权，留空时不发 Authorization 头
    if (State.ai.apiKey) headers.Authorization = `Bearer ${State.ai.apiKey}`;
    return headers;
}

function isAiConfigured() {
    return !!(State.ai.baseUrl && State.ai.model);
}

function isAiEnabled() {
    return State.ai.enabled !== false;
}

/* ---------------- Agent 工具定义 ---------------- */

const AI_AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'list_notes',
            description: '列出笔记（可按文件夹、标签或关键词过滤），返回每篇笔记的 id、标题、文件夹、标签与修改时间。修改笔记前先用它找到目标笔记。',
            parameters: {
                type: 'object',
                properties: {
                    folder: { type: 'string', description: '只看该文件夹下的笔记，留空表示不限' },
                    tag: { type: 'string', description: '只看带该标签的笔记，不要带 # 前缀' },
                    keyword: { type: 'string', description: '标题或正文中包含该关键词' },
                    limit: { type: 'integer', description: '最多返回多少篇，默认 20，最大 100' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_note',
            description: '读取指定笔记的完整正文（正文过长时会被截断）。',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: '笔记 id，也可用笔记标题代替' } },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_note',
            description: '新建一篇笔记，返回新笔记的 id。',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '笔记标题' },
                    content: { type: 'string', description: '笔记正文（Markdown）' },
                    folder: { type: 'string', description: '所属文件夹，必须是已存在的文件夹，默认“默认”' },
                    tags: { type: 'array', items: { type: 'string' }, description: '标签列表，不要带 # 前缀' },
                    pinned: { type: 'boolean', description: '是否置顶' }
                },
                required: ['content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_note_content',
            description: '修改笔记正文：mode 为 replace 时整体替换，为 append 时追加到正文末尾。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' },
                    content: { type: 'string', description: '新的正文内容（Markdown）' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: '默认为 replace' }
                },
                required: ['id', 'content']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'update_note_meta',
            description: '修改笔记的标题、文件夹、标签或置顶状态，只传需要改动的字段。标签可用 tags 整体替换，或用 add_tags / remove_tags 增删。',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: '笔记 id，也可用笔记标题代替' },
                    title: { type: 'string', description: '新的标题' },
                    folder: { type: 'string', description: '新的文件夹，必须是已存在的文件夹' },
                    tags: { type: 'array', items: { type: 'string' }, description: '整体替换标签列表，不要带 # 前缀' },
                    add_tags: { type: 'array', items: { type: 'string' }, description: '要添加的标签' },
                    remove_tags: { type: 'array', items: { type: 'string' }, description: '要移除的标签' },
                    pinned: { type: 'boolean', description: '是否置顶' }
                },
                required: ['id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'create_folder',
            description: '新建一个文件夹，已存在同名文件夹时不会重复创建。',
            parameters: {
                type: 'object',
                properties: { name: { type: 'string', description: '文件夹名称' } },
                required: ['name']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'trash_note',
            description: '把笔记移入废纸篓（用户可在废纸篓中恢复）。仅在用户明确要求删除笔记时使用，执行前会向用户确认。',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string', description: '笔记 id，也可用笔记标题代替' } },
                required: ['id']
            }
        }
    }
];

function isAiAgentMode() {
    return !!State.ai.agentMode;
}

function buildAiAgentToolPayload() {
    return isAiAgentMode() ? AI_AGENT_TOOLS : [];
}

function syncAiAgentToggle() {
    const toggle = document.getElementById('ai-agent-toggle');
    if (!toggle) return;
    // 外观沿用标题栏 AI 助手按钮那一套：开启时挂 .active，颜色与底色由 .btn-action-icon.active 给
    const on = isAiAgentMode();
    toggle.classList.toggle('active', on);
    toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
}

// 直接切换开关，不再弹确认框；开启后的风险由每条操作自带的「撤销」承担
function toggleAiAgentMode(enabled) {
    State.ai.agentMode = !!enabled;
    saveConfig();
    syncAiAgentToggle();
    showToast(enabled ? 'Agent 模式已开启：AI 可以修改笔记' : 'Agent 模式已关闭');
}

// 会话内的撤销快照：stepId -> { label, undo() }
const aiAgentUndoEntries = new Map();

function registerAiAgentUndo(stepId, entry) {
    if (!stepId || !entry) return;
    aiAgentUndoEntries.set(stepId, entry);
}

function undoAiAgentStep(stepId) {
    const entry = aiAgentUndoEntries.get(stepId);
    if (!entry) return false;
    entry.undo();
    aiAgentUndoEntries.delete(stepId);
    renderApp();
    return true;
}

/* ---------------- 对话模型 ---------------- */

function generateAiChatId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(10);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => chars.charAt(byte % chars.length)).join('');
}

function createAiConversation() {
    const now = Date.now();
    const chat = { id: generateAiChatId(), title: '', createdAt: now, updatedAt: now, messages: [] };
    State.aiConversations.unshift(chat);
    State.aiActiveConversationId = chat.id;
    saveAiChatFile(chat);
    return chat;
}

function ensureAiConversations() {
    if (!State.aiConversations.length) createAiConversation();
    if (!findAiConversation(State.aiActiveConversationId)) {
        State.aiActiveConversationId = State.aiConversations[0].id;
    }
    return State.aiActiveConversationId;
}

function findAiConversation(id) {
    return State.aiConversations.find((chat) => chat.id === id) || null;
}

function activeAiConversation() {
    return findAiConversation(State.aiActiveConversationId);
}

function activeAiMessages() {
    const chat = activeAiConversation();
    return chat ? chat.messages : [];
}

function touchAiConversation(chat) {
    if (!chat) return;
    chat.updatedAt = Date.now();
    saveAiChatFile(chat);
}

function aiChatDisplayTitle(chat) {
    return (chat && chat.title) || '未命名对话';
}

function sortAiConversations() {
    State.aiConversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ---------------- 附带笔记 ---------------- */

function collectAiContextNotes() {
    const scope = State.ai.scope || 'current';
    if (scope === 'none') return [];

    if (scope === 'current') {
        const item = getActiveItem();
        // 加密且未解锁的条目正文是密文，附上去没有意义
        return item && !isSecretLocked(item) ? [item] : [];
    }

    const limit = Math.max(1, Math.min(50, Number(State.ai.maxNotes) || AI_CONTEXT_MAX_NOTES));
    // 隐藏与加密的条目都不进提问范围
    return [...State.notes, ...State.todos]
        .filter((item) => !item.isTrashed && !isSecretHidden(item) && !isSecretLocked(item))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, limit);
}

function buildAiContextMessage() {
    const notes = collectAiContextNotes();
    if (!notes.length) return null;

    const parts = [];
    let used = 0;
    notes.forEach((item) => {
        const body = String(item.content || '');
        const remaining = AI_CONTEXT_MAX_CHARS * notes.length - used;
        if (remaining <= 0) return;
        const text = body.length > remaining ? `${body.slice(0, remaining)}…（已截断）` : body;
        used += text.length;
        parts.push(`【${itemKindLabel(item)}｜${itemDisplayTitle(item)}｜id=${item.id}｜文件夹=${item.folder}】\n${text}`);
    });
    if (!parts.length) return null;

    return `以下是用户当前的笔记内容，请结合它们回答：\n\n${parts.join('\n\n---\n\n')}`;
}

/* 输入框里那条下拉：附带范围的选项文字与可选项都跟着「当前打开的笔记」走。
   开着笔记时第一项写作「附带当前笔记：<笔记名>」；没有打开的笔记时这一项直接收起来，
   下拉里只剩「附带全部笔记 / 不附带笔记」。

   收起时范围会临时让给「不附带笔记」——取不到笔记时这两项效果完全一样（都拿不到上下文），
   但用户的偏好还得记着：等重新打开笔记，范围自动回到「附带当前笔记」（标记见下）。
   用户自己动手改过范围就作数，标记随之清掉，不再自动改回去。 */
let aiScopeParkedForMissingNote = false;

function updateAiScopeOptions() {
    const select = document.getElementById('ai-scope-select');
    if (!select) return;

    const item = getActiveItem();
    const currentOption = select.querySelector('option[value="current"]');

    if (item) {
        const label = `附带当前笔记：${itemDisplayTitle(item)}`;
        if (!currentOption) {
            const option = document.createElement('option');
            option.value = 'current';
            option.textContent = label;
            select.insertBefore(option, select.firstElementChild);
        } else if (currentOption.textContent !== label) {
            // 改的是选项文字：自绘下拉的触发器与菜单都跟着这个原生 select 走（见 scripts/ui.js）
            currentOption.textContent = label;
        }
        if (aiScopeParkedForMissingNote) {
            aiScopeParkedForMissingNote = false;
            State.ai.scope = 'current';
        }
    } else if (currentOption) {
        currentOption.remove();
        if (State.ai.scope === 'current') {
            aiScopeParkedForMissingNote = true;
            State.ai.scope = 'none';
        }
    }

    // 原生 select 是自绘下拉的数据源：范围与选项文字都可能刚变过，触发器与菜单一并刷新
    if (select.value !== State.ai.scope) select.value = State.ai.scope;
    const entry = CUSTOM_SELECTS.find((item) => item.select === select);
    markCustomSelectDirty(entry);
    refreshCustomSelect(entry);
}

/* ---------------- 面板开关 ---------------- */

/* 面板的显隐只有一个出口（与桌面版一致）：开关状态、是否被用户打开、是否在设置页。
   renderApp 每次都会调它一次，因此打开设置页时面板会被就地收起，退出设置页再展开。 */
let aiPanelExpanded = false;
let aiPanelHideTimer = null;
let aiPanelHideListener = null;

// 取消「正在进行的收起」：清掉兜底定时器，并摘掉挂在面板上的 transitionend
function cancelAiPanelHide(panel) {
    clearTimeout(aiPanelHideTimer);
    aiPanelHideTimer = null;
    if (aiPanelHideListener && panel) panel.removeEventListener('transitionend', aiPanelHideListener);
    aiPanelHideListener = null;
}

/* 收起：位移过渡真的走完再挂 .hidden —— display: none 会当场把过渡切断，
   而写死一个时长（原为 300ms）在手机上会被掉帧拖成「滑到一半就消失」。
   定时器只当兜底：过渡未触发时（例如系统开了「减少动态效果」）仍能收尾。 */
function scheduleAiPanelHide(panel) {
    cancelAiPanelHide(panel);
    // 收起用的位移/宽度两种情形：窄屏是 transform，桌面是 width
    const collapseProps = ['transform', 'width'];
    aiPanelHideListener = (event) => {
        if (event.target !== panel || !collapseProps.includes(event.propertyName)) return;
        cancelAiPanelHide(panel);
        if (!aiPanelExpanded) panel.classList.add('hidden');
    };
    panel.addEventListener('transitionend', aiPanelHideListener);
    aiPanelHideTimer = setTimeout(() => {
        cancelAiPanelHide(panel);
        if (!aiPanelExpanded) panel.classList.add('hidden');
    }, 600);
}

function applyAiPanelVisibility() {
    const panel = document.getElementById('ai-panel');
    if (!panel) return;

    const inSettings = State.activeNoteId === 'settings';
    const visible = isAiEnabled() && !!State.aiPanelOpen && !inSettings;
    // 标题栏那枚与窄屏编辑器顶栏那枚同步显隐与点亮
    document.querySelectorAll('#btn-ai-assistant, #btn-editor-ai').forEach((button) => {
        button.classList.toggle('hidden', !isAiEnabled());
        button.classList.toggle('active', visible);
    });

    if (visible === aiPanelExpanded) {
        // 已经到位（或正往同一方向动）：不重启过渡，只补上「不显示时顺手收起抽屉」
        if (!visible) closeAiDrawer();
        return;
    }
    aiPanelExpanded = visible;

    if (visible) {
        cancelAiPanelHide(panel);
        panel.classList.remove('hidden');
        // 先以收起态入场，下一帧再展开：否则宽度过渡没有起点，面板会「啪」地出现
        if (panel.classList.contains('ai-collapsed')) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                if (aiPanelExpanded) panel.classList.remove('ai-collapsed');
            }));
        }
        return;
    }

    closeAiDrawer();
    panel.classList.add('ai-collapsed');
    if (inSettings) {
        // 设置页占据整个窗口：这一下属于「页面切换」而不是「收起面板」，与侧边栏一样瞬间到位
        cancelAiPanelHide(panel);
        panel.classList.add('hidden');
        return;
    }
    // .hidden 是 display: none，一旦先挂上就没机会播过渡，因此等位移走完再收
    scheduleAiPanelHide(panel);
}

function openAiPanel() {
    if (!isAiEnabled()) {
        showToast('AI 助手已在设置中关闭');
        return;
    }
    State.aiPanelOpen = true;
    ensureAiConversations();
    applyAiPanelVisibility();
    renderAiMessages();
    renderAiChatList();
    updateAiModelChip();
    updateAiScopeOptions();
    scrollAiToBottom();
}

function closeAiPanel() {
    State.aiPanelOpen = false;
    applyAiPanelVisibility();
}

function toggleAiPanel() {
    if (State.aiPanelOpen) closeAiPanel();
    else openAiPanel();
}

// AI 助手关闭时（设置里关掉开关）面板与入口一并收起
function applyAiEnabledState() {
    applyAiPanelVisibility();
}

function openAiDrawer() {
    document.getElementById('ai-drawer').classList.remove('hidden');
    renderAiChatList();
}

function closeAiDrawer() {
    const drawer = document.getElementById('ai-drawer');
    if (drawer) drawer.classList.add('hidden');
}

/* ---------------- 渲染：消息区 ---------------- */

function updateAiModelChip() {
    const chip = document.getElementById('ai-panel-model');
    if (!chip) return;
    const model = String(State.ai.model || '').trim();
    chip.textContent = model || '未配置模型';
    chip.title = model || '在「设置 → AI 助手」里填写 API 站点与模型';
}

function scrollAiToBottom() {
    const box = document.getElementById('ai-messages');
    if (box) box.scrollTop = box.scrollHeight;
}

function renderAiMarkdownInto(element, text) {
    element.innerHTML = Markdown.parse(text || '');
}

function createAiMessageElement(msg, index) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ai-msg-${msg.role === 'user' ? 'user' : 'assistant'}`;
    if (msg.error) wrapper.classList.add('ai-msg-failed');
    if (msg.canceled) wrapper.classList.add('ai-msg-canceled');
    if (msg.agent) wrapper.classList.add('ai-msg-agent');

    const role = document.createElement('div');
    role.className = 'ai-msg-role';
    role.innerHTML = `<span class="ms-icon xs">${msg.role === 'user' ? 'person' : 'smart_toy'}</span>`
        + `<span>${msg.role === 'user' ? '我' : 'AI'}</span>`
        + (msg.context ? `<span class="ai-msg-context">${escapeHTML(msg.context)}</span>` : '');
    wrapper.appendChild(role);

    const body = document.createElement('div');
    body.className = 'ai-msg-body';
    const content = document.createElement('div');
    content.className = 'ai-msg-content';
    body.appendChild(content);
    wrapper.appendChild(body);

    // 附件：图片显示缩略图，文本文件显示文件名与大小
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    if (attachments.length) {
        const list = document.createElement('div');
        list.className = 'ai-attach-list';
        attachments.forEach((file) => list.appendChild(buildAiAttachmentChip(file, false)));
        body.appendChild(list);
    }

    if (msg.agent && Array.isArray(msg.steps)) {
        const steps = document.createElement('div');
        steps.className = 'ai-agent-steps';
        msg.steps.forEach((step) => steps.appendChild(createAiAgentStepElement(step)));
        body.appendChild(steps);
        if (msg.content) steps.insertBefore(content, steps.firstChild);
    } else if (msg.role === 'user') {
        content.textContent = msg.content || '';
    } else {
        renderAiMarkdownInto(content, msg.content || '');
    }

    if (msg.streaming) {
        const typing = document.createElement('span');
        typing.className = 'ai-typing';
        typing.textContent = '…';
        content.appendChild(typing);
    }

    if (msg.role === 'assistant' && !msg.streaming && msg.content) {
        wrapper.appendChild(createAiMessageActions(msg, index));
    }
    return wrapper;
}

function createAiAgentStepElement(step) {
    const el = document.createElement('div');
    el.className = `ai-step ${step.status === 'running' ? 'running' : step.status === 'failed' ? 'failed' : ''}`;
    const icon = step.status === 'running' ? 'progress_activity' : step.status === 'failed' ? 'error' : 'check_circle';
    el.innerHTML = `<span class="ms-icon sm">${icon}</span>`
        + '<div class="ai-step-info">'
        + `<div class="ai-step-label">${escapeHTML(step.label || step.name || '')}</div>`
        + (step.detail ? `<div class="ai-step-detail">${escapeHTML(step.detail)}</div>` : '')
        + '</div>';
    if (step.undoable && step.status !== 'running') {
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.className = 'ai-msg-action';
        undo.innerHTML = '<span class="ms-icon xs">undo</span><span>撤销</span>';
        undo.onclick = () => {
            if (undoAiAgentStep(step.id)) {
                step.undoable = false;
                undo.remove();
                showToast('已撤销这一步');
            } else {
                showToast('这一步无法撤销');
            }
        };
        el.appendChild(undo);
    }
    return el;
}

function createAiMessageActions(msg, index) {
    const actions = document.createElement('div');
    actions.className = 'ai-msg-actions';

    const make = (icon, label, handler) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-msg-action';
        button.innerHTML = `<span class="ms-icon xs">${icon}</span><span>${label}</span>`;
        button.onclick = handler;
        actions.appendChild(button);
    };

    make('content_copy', '复制', async () => {
        const ok = await copyText(msg.content || '');
        showToast(ok ? '回答已复制' : '复制失败：浏览器拒绝了剪贴板写入');
    });
    make('playlist_add', '插入当前笔记', () => insertAiAnswerToNote(msg));
    make('note_add', '存为新笔记', () => saveAiAnswerAsNote(msg));
    return actions;
}

// 把回答追加到当前笔记末尾（没有打开任何笔记时给出提示）
function insertAiAnswerToNote(msg) {
    const item = getActiveItem();
    if (!item) {
        showToast('请先打开一篇笔记，再插入回答');
        return;
    }
    if (isReadOnlyItem(item)) {
        showToast(isSecretLocked(item) ? '正文已加密：解锁后才能写入' : '废纸篓中的条目为只读，无法插入');
        return;
    }
    const addition = msg.content || '';
    item.content = item.content ? `${item.content}\n\n${addition}` : addition;
    item.updatedAt = Date.now();
    saveItem(item);
    renderApp();
    showToast('已插入当前笔记');
}

// 把回答存成一篇新笔记
function saveAiAnswerAsNote(msg) {
    const title = (msg.content || '').split(/\r?\n/).find((line) => line.trim()) || 'AI 回答';
    const now = Date.now();
    const item = {
        id: generateUniqueItemId('note'),
        title: title.replace(/^#+\s*/, '').slice(0, 60),
        content: msg.content || '',
        folder: DEFAULT_FOLDER,
        tags: [],
        isPinned: false,
        isTrashed: false,
        createdAt: now,
        updatedAt: now
    };
    markItemKind(item, 'note');
    State.notes.unshift(item);
    saveItem(item);
    renderApp();
    showToast('已存为新笔记');
}

function renderAiMessages() {
    const box = document.getElementById('ai-messages');
    if (!box) return;
    const messages = activeAiMessages();
    box.innerHTML = '';

    if (!messages.length) {
        box.appendChild(buildAiEmptyState());
        return;
    }
    messages.forEach((msg, index) => box.appendChild(createAiMessageElement(msg, index)));
}

function buildAiEmptyState() {
    const empty = document.createElement('div');
    empty.className = 'ai-empty';
    empty.innerHTML = `
        <span class="ms-icon">forum</span>
        <p>问点什么吧，AI 会结合你的笔记回答</p>
        <div class="ai-example">
            <button class="ai-example-chip" type="button" data-prompt="帮我总结一下当前笔记的要点">总结当前笔记</button>
            <button class="ai-example-chip" type="button" data-prompt="根据我的笔记，列出其中还没有完成的待办项">找出笔记中的待办</button>
            <button class="ai-example-chip" type="button" data-prompt="我的笔记里主要在关注哪些主题？请归类整理">笔记主题归类</button>
        </div>
        <p class="ai-empty-hint">回答可以复制、插入当前笔记，或直接存为新笔记；图片与文本文件可拖进来一起发。</p>
    `;
    empty.querySelectorAll('.ai-example-chip').forEach((chip) => {
        chip.onclick = () => {
            // 点了只填进输入框，用户可再编辑（与桌面版 scripts/ai.js 一致）
            const input = document.getElementById('ai-input');
            input.value = chip.dataset.prompt || '';
            updateAiComposerState();
            input.focus();
        };
    });
    return empty;
}

/* ---------------- 渲染：对话记录列表 ---------------- */

function renderAiChatList() {
    const list = document.getElementById('ai-chat-list');
    if (!list) return;
    list.innerHTML = '';

    if (!State.aiConversations.length) {
        list.innerHTML = '<div class="ai-chat-empty">还没有对话</div>';
        return;
    }

    sortAiConversations();
    State.aiConversations.forEach((chat) => {
        const item = document.createElement('div');
        item.className = `ai-chat-item ${chat.id === State.aiActiveConversationId ? 'active' : ''}`;

        const main = document.createElement('div');
        main.className = 'ai-chat-item-main';
        const streaming = State.aiStreaming && State.aiStreamingChatId === chat.id;
        main.innerHTML = `<div class="ai-chat-item-title">${escapeHTML(aiChatDisplayTitle(chat))}</div>`
            + `<div class="ai-chat-item-meta ${streaming ? 'streaming' : ''}">`
            + `${streaming ? '生成中…' : `${chat.messages.length} 条 · ${formatDate(chat.updatedAt)}`}</div>`;
        main.onclick = () => {
            if (State.aiStreaming) {
                showToast('正在生成回答，请先停止或等待完成');
                return;
            }
            State.aiActiveConversationId = chat.id;
            closeAiDrawer();
            renderAiMessages();
            updateAiScopeOptions();
            scrollAiToBottom();
        };

        const actions = document.createElement('div');
        actions.className = 'ai-chat-item-actions';
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'ai-chat-action';
        rename.title = '重命名';
        rename.innerHTML = '<span class="ms-icon xs">edit</span>';
        rename.onclick = async (event) => {
            event.stopPropagation();
            const name = await showPrompt('重命名对话', {
                title: '重命名对话',
                icon: 'edit',
                label: '对话标题',
                value: chat.title || '',
                confirmLabel: '保存'
            });
            if (name === null) return;
            chat.title = name;
            touchAiConversation(chat);
            renderAiChatList();
        };

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-chat-action danger';
        remove.title = '删除对话';
        remove.innerHTML = '<span class="ms-icon xs">delete</span>';
        remove.onclick = async (event) => {
            event.stopPropagation();
            const confirmed = await showConfirm(`删除对话“${aiChatDisplayTitle(chat)}”？`, {
                title: '删除对话',
                detail: '该对话与其中的消息将被删除，此操作无法撤销。',
                type: 'warning',
                icon: 'delete',
                confirmLabel: '删除',
                danger: true
            });
            if (!confirmed) return;
            deleteAiChatFile(chat.id);
            State.aiConversations = State.aiConversations.filter((entry) => entry.id !== chat.id);
            if (State.aiActiveConversationId === chat.id) {
                State.aiActiveConversationId = State.aiConversations.length ? State.aiConversations[0].id : '';
                ensureAiConversations();
                renderAiMessages();
            }
            renderAiChatList();
        };

        actions.append(rename, remove);
        item.append(main, actions);
        list.appendChild(item);
    });
}

/* ---------------- 附件 ---------------- */

function aiAttachmentIcon(kind) {
    if (kind === 'image') return 'image';
    if (kind === 'text') return 'description';
    return 'draft';
}

function formatAiFileSize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAiAttachmentChip(file, removable) {
    const chip = document.createElement('div');
    chip.className = `ai-attach-chip ${file.kind === 'image' ? 'image' : ''}`;

    if (file.kind === 'image' && file.dataUrl) {
        const thumb = document.createElement('img');
        thumb.className = 'ai-attach-thumb';
        thumb.src = file.dataUrl;
        thumb.alt = file.name || '图片';
        chip.appendChild(thumb);
    } else {
        const icon = document.createElement('span');
        icon.className = 'ms-icon sm';
        icon.textContent = aiAttachmentIcon(file.kind);
        chip.appendChild(icon);
    }

    const info = document.createElement('div');
    info.className = 'ai-attach-info';
    info.innerHTML = `<div class="ai-attach-name">${escapeHTML(file.name || '附件')}</div>`
        + `<div class="ai-attach-meta">${file.kind === 'image' ? '图片' : '文本'} · ${formatAiFileSize(file.size)}</div>`;
    chip.appendChild(info);

    if (removable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'ai-attach-remove';
        remove.title = '移除';
        remove.innerHTML = '<span class="ms-icon xs">close</span>';
        remove.onclick = () => {
            State.aiPendingAttachments = State.aiPendingAttachments.filter((entry) => entry !== file);
            renderAiAttachments();
        };
        chip.appendChild(remove);
    }
    return chip;
}

function renderAiAttachments() {
    const strip = document.getElementById('ai-attachment-strip');
    if (!strip) return;
    strip.innerHTML = '';
    strip.classList.toggle('hidden', !State.aiPendingAttachments.length);
    State.aiPendingAttachments.forEach((file) => strip.appendChild(buildAiAttachmentChip(file, true)));
    updateAiComposerState();
}

async function importAiAttachments(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    for (const file of files) {
        if (file.size > AI_ATTACH_MAX_BYTES) {
            showToast(`附件过大（上限 ${formatAiFileSize(AI_ATTACH_MAX_BYTES)}）：${file.name}`);
            continue;
        }
        try {
            const isImage = AI_IMAGE_TYPES.test(file.type) || AI_IMAGE_EXTENSIONS.test(file.name);
            if (isImage) {
                const dataUrl = await readFileAsDataUrl(file);
                State.aiPendingAttachments.push({
                    kind: 'image',
                    name: file.name,
                    size: file.size,
                    type: file.type || 'image/png',
                    dataUrl
                });
            } else {
                const text = await file.text();
                State.aiPendingAttachments.push({
                    kind: 'text',
                    name: file.name,
                    size: file.size,
                    type: file.type || 'text/plain',
                    text
                });
            }
        } catch (error) {
            console.error(`[ERROR] [AI] 附件读取失败 (file=${file.name}, detail=${error && error.message})`);
            showToast(`附件读取失败：${file.name}`);
        }
    }
    renderAiAttachments();
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('读取失败'));
        reader.readAsDataURL(file);
    });
}

function pickAiAttachments() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.txt,.md,.markdown,.json,.csv,text/plain';
    input.style.display = 'none';
    input.addEventListener('change', () => {
        if (input.files && input.files.length) importAiAttachments(input.files);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

/* ---------------- 请求 ---------------- */

function buildAiUserMessage(text, attachments) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });

    let contextNote = '';
    (attachments || []).forEach((file) => {
        if (file.kind === 'image') {
            if (file.dataUrl) parts.push({ type: 'image_url', image_url: { url: file.dataUrl } });
        } else {
            contextNote += `\n\n【附件：${file.name}】\n${String(file.text || '').slice(0, AI_AGENT_READ_CHAR_LIMIT)}`;
        }
    });
    if (contextNote) {
        if (!parts.length) parts.push({ type: 'text', text: contextNote.trim() });
        else parts[0].text += contextNote;
    }
    // 纯图片提问：补一句说明，免得模型只看到图没有任何文字
    if (!parts.some((part) => part.type === 'text')) parts.unshift({ type: 'text', text: '请看这张图片。' });
    return parts.length === 1 && parts[0].type === 'text' ? { role: 'user', content: parts[0].text } : { role: 'user', content: parts };
}

// 只保留最近的若干轮，避免请求体无限增长
const AI_HISTORY_MAX_MESSAGES = 20;

function collectAiHistoryMessages(chat) {
    const history = [];
    chat.messages.slice(-AI_HISTORY_MAX_MESSAGES).forEach((msg) => {
        if (msg.error || msg.canceled) return;
        if (msg.role === 'user') {
            history.push(buildAiUserMessage(msg.content, msg.attachments));
        } else if (msg.agent) {
            history.push({ role: 'assistant', content: msg.content || '' });
        } else if (msg.content) {
            history.push({ role: 'assistant', content: msg.content });
        }
    });
    return history;
}

function buildAiRequestMessages(chat) {
    const messages = [{ role: 'system', content: String(State.ai.systemPrompt || '').trim() || AI_DEFAULT_SYSTEM_PROMPT }];
    const context = buildAiContextMessage();
    if (context) messages.push({ role: 'system', content: context });
    return messages.concat(collectAiHistoryMessages(chat));
}

/* 流式请求：逐行解析 SSE 的 data: 负载，累计正文与工具调用。
   返回 { content, toolCalls }；调用方负责把增量画到界面上。 */
async function streamAiChat(body, { onDelta, signal }) {
    const endpoint = aiBuildEndpoint(State.ai.baseUrl, 'chat/completions');
    if (!endpoint) throw new Error('尚未填写 API 站点');

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: aiHeaders(),
        body: JSON.stringify({ ...body, model: State.ai.model, stream: true }),
        signal
    });

    if (!response.ok) {
        let detail = '';
        try {
            const payload = await response.json();
            detail = payload && payload.error ? (payload.error.message || JSON.stringify(payload.error)) : '';
        } catch (error) {
            detail = '';
        }
        throw new Error(detail || `请求失败（HTTP ${response.status}）`);
    }
    if (!response.body) throw new Error('当前浏览器不支持流式读取');

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let content = '';
    const toolCalls = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf('\n');
            if (!line || !line.startsWith('data:')) continue;

            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let parsed = null;
            try {
                parsed = JSON.parse(payload);
            } catch (error) {
                continue;
            }
            const choice = parsed.choices && parsed.choices[0];
            if (!choice) continue;
            const delta = choice.delta || choice.message || {};

            if (typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                if (onDelta) onDelta(content);
            }
            if (Array.isArray(delta.tool_calls)) {
                delta.tool_calls.forEach((call, index) => {
                    const slot = toolCalls[index] || (toolCalls[index] = { id: '', name: '', arguments: '' });
                    if (call.id) slot.id = call.id;
                    if (call.function && call.function.name) slot.name = call.function.name;
                    if (call.function && typeof call.function.arguments === 'string') slot.arguments += call.function.arguments;
                });
            }
        }
    }
    return { content, toolCalls: toolCalls.filter((call) => call && call.name) };
}

/* ---------------- 发送 ---------------- */

async function sendAiMessage() {
    if (State.aiStreaming) return;
    const input = document.getElementById('ai-input');
    const text = String(input.value || '').trim();
    const attachments = State.aiPendingAttachments.slice();
    if (!text && !attachments.length) return;

    if (!isAiConfigured()) {
        showToast('请先在「设置 → AI 助手」里填写 API 站点与模型');
        return;
    }

    ensureAiConversations();
    const chat = activeAiConversation();
    const userMessage = {
        role: 'user',
        content: text,
        attachments,
        context: aiScopeLabel(),
        time: Date.now()
    };
    chat.messages.push(userMessage);
    if (!chat.title) chat.title = (text || attachments[0]?.name || '图片提问').slice(0, 40);
    touchAiConversation(chat);

    input.value = '';
    State.aiPendingAttachments = [];
    renderAiAttachments();
    renderAiMessages();
    scrollAiToBottom();

    const assistantMessage = { role: 'assistant', content: '', streaming: true, time: Date.now() };
    chat.messages.push(assistantMessage);
    renderAiMessages();
    scrollAiToBottom();

    State.aiStreaming = true;
    State.aiStreamingChatId = chat.id;
    State.aiAbort = new AbortController();
    updateAiComposerState();
    renderAiChatList();

    try {
        if (isAiAgentMode()) {
            await runAiAgentTurn(chat, assistantMessage);
        } else {
            const messages = buildAiRequestMessages(chat);
            const result = await streamAiChat({ messages }, {
                signal: State.aiAbort.signal,
                onDelta: (content) => {
                    assistantMessage.content = content;
                    updateStreamingBubble(assistantMessage);
                }
            });
            assistantMessage.content = result.content;
        }
    } catch (error) {
        if (error && error.name === 'AbortError') {
            assistantMessage.canceled = true;
            if (!assistantMessage.content) assistantMessage.content = '（已停止生成）';
        } else {
            assistantMessage.error = true;
            const detail = error && error.message ? error.message : '未知错误';
            assistantMessage.content = `请求失败：${detail}`;
            console.error('[ERROR] [AI] 请求失败: ' + detail);
        }
    } finally {
        assistantMessage.streaming = false;
        State.aiStreaming = false;
        State.aiStreamingChatId = '';
        State.aiAbort = null;
        updateAiComposerState();
        touchAiConversation(chat);
        renderAiMessages();
        renderAiChatList();
        scrollAiToBottom();
    }
}

// 流式过程中只更新同一个气泡里的内容，不整块重建（否则滚动位置会被打断）
function updateStreamingBubble(message) {
    const box = document.getElementById('ai-messages');
    if (!box) return;
    const last = box.lastElementChild;
    if (!last) return;
    const content = last.querySelector('.ai-msg-content');
    if (!content) return;

    // 用户正在气泡里拖选时不重写：innerHTML 一换选区就没了，
    // 回答还在流式输出时就会怎么拖都选不住。
    // 返回不等丢内容——下一个增量还会调进来，流结束时还会走一次完整渲染
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && content.contains(selection.anchorNode)) return;

    content.innerHTML = Markdown.parse(message.content || '');
    scrollAiToBottom();
}

function aiScopeLabel() {
    const scope = State.ai.scope || 'current';
    if (scope === 'none') return '不附带笔记';
    if (scope === 'all') return '全部笔记';
    return '当前笔记';
}

/* 输入区的可用状态：输入为空时发送按钮置灰，生成期间整枚收起只留「停止」，
   附件按钮跟随 AI 助手总开关。与桌面版 scripts/ai.js 的 updateAiComposerState 一致。 */
function updateAiComposerState() {
    const input = document.getElementById('ai-input');
    const sendBtn = document.getElementById('btn-ai-send');
    const stopBtn = document.getElementById('btn-ai-stop');
    const attachBtn = document.getElementById('btn-ai-attach');
    const hasContent = !!input && (input.value.trim().length > 0 || State.aiPendingAttachments.length > 0);

    if (sendBtn) {
        sendBtn.classList.toggle('hidden', State.aiStreaming);
        sendBtn.disabled = !hasContent;
    }
    if (stopBtn) stopBtn.classList.toggle('hidden', !State.aiStreaming);
    if (attachBtn) attachBtn.disabled = !isAiEnabled();
}

function stopAiStreaming() {
    if (State.aiAbort) State.aiAbort.abort();
}

function clearAiChat() {
    const chat = activeAiConversation();
    if (!chat || !chat.messages.length) {
        showToast('当前对话还没有内容');
        return;
    }
    chat.messages = [];
    touchAiConversation(chat);
    renderAiMessages();
    renderAiChatList();
    showToast('已清空当前对话');
}

/* ---------------- Agent 模式：工具循环 ---------------- */

function findNoteById(id) {
    return getItemById(String(id || '').trim());
}

// 工具里允许用标题代替 id（隐藏与加密的条目不做标题兜底匹配）
function resolveAiAgentNote(rawId) {
    const text = String(rawId || '').trim();
    if (!text) return null;
    const byId = findNoteById(text);
    if (byId) return byId;
    return [...State.notes, ...State.todos].find((item) => itemDisplayTitle(item) === text
        && !isSecretHidden(item)
        && !isSecretLocked(item)) || null;
}

function normalizeTagList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((tag) => String(tag || '').replace(/^#/, '').trim()).filter(Boolean);
}

function aiAgentToolResult(ok, message, extra = {}) {
    return { ok, message, ...extra };
}

async function executeAiAgentTool(name, args) {
    const input = args && typeof args === 'object' ? args : {};

    if (name === 'list_notes') {
        const limit = Math.max(1, Math.min(AI_AGENT_LIST_LIMIT, Number(input.limit) || 20));
        const folder = String(input.folder || '').trim();
        const tag = String(input.tag || '').replace(/^#/, '').trim();
        const keyword = String(input.keyword || '').trim().toLowerCase();
        const list = [...State.notes, ...State.todos]
            .filter((item) => !item.isTrashed && !isSecretHidden(item) && !isSecretLocked(item))
            .filter((item) => !folder || item.folder === folder)
            .filter((item) => !tag || (Array.isArray(item.tags) && item.tags.includes(tag)))
            .filter((item) => !keyword || `${item.title}\n${item.content}`.toLowerCase().includes(keyword))
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, limit)
            .map((item) => ({
                id: item.id,
                kind: itemKindLabel(item),
                title: itemDisplayTitle(item),
                folder: item.folder,
                tags: item.tags || [],
                updatedAt: item.updatedAt
            }));
        return aiAgentToolResult(true, `列出 ${list.length} 篇笔记`, { data: list });
    }

    if (name === 'read_note') {
        const item = resolveAiAgentNote(input.id);
        if (!item) return aiAgentToolResult(false, `没有找到笔记：${input.id}`);
        if (isSecretLocked(item)) return aiAgentToolResult(false, `《${itemDisplayTitle(item)}》正文已加密：解锁后才能读取`);
        const content = String(item.content || '');
        return aiAgentToolResult(true, `读取《${itemDisplayTitle(item)}》`, {
            data: {
                id: item.id,
                title: itemDisplayTitle(item),
                folder: item.folder,
                tags: item.tags || [],
                content: content.length > AI_AGENT_READ_CHAR_LIMIT ? `${content.slice(0, AI_AGENT_READ_CHAR_LIMIT)}…（已截断）` : content
            }
        });
    }

    if (name === 'create_note') {
        const folder = State.folders.includes(String(input.folder || '').trim()) ? String(input.folder).trim() : DEFAULT_FOLDER;
        const now = Date.now();
        const item = {
            id: generateUniqueItemId('note'),
            title: String(input.title || '').trim(),
            content: String(input.content || ''),
            folder,
            tags: normalizeTagList(input.tags),
            isPinned: !!input.pinned,
            isTrashed: false,
            createdAt: now,
            updatedAt: now
        };
        markItemKind(item, 'note');
        State.notes.unshift(item);
        saveItem(item);
        renderApp();
        return aiAgentToolResult(true, `已新建笔记《${itemDisplayTitle(item)}》`, { data: { id: item.id } });
    }

    if (name === 'update_note_content') {
        const item = resolveAiAgentNote(input.id);
        if (!item) return aiAgentToolResult(false, `没有找到笔记：${input.id}`);
        if (isSecretLocked(item)) return aiAgentToolResult(false, `《${itemDisplayTitle(item)}》正文已加密：解锁后才能改写`);
        const before = String(item.content || '');
        const next = String(input.content || '');
        const undo = () => {
            item.content = before;
            item.updatedAt = Date.now();
            saveItem(item);
        };
        item.content = input.mode === 'append' ? (before ? `${before}\n\n${next}` : next) : next;
        item.updatedAt = Date.now();
        saveItem(item);
        renderApp();
        return aiAgentToolResult(true, `已更新《${itemDisplayTitle(item)}》的正文`, { undo, data: { id: item.id } });
    }

    if (name === 'update_note_meta') {
        const item = resolveAiAgentNote(input.id);
        if (!item) return aiAgentToolResult(false, `没有找到笔记：${input.id}`);
        const before = {
            title: item.title,
            folder: item.folder,
            tags: (item.tags || []).slice(),
            isPinned: !!item.isPinned
        };
        const undo = () => {
            item.title = before.title;
            item.folder = before.folder;
            item.tags = before.tags.slice();
            item.isPinned = before.isPinned;
            item.updatedAt = Date.now();
            saveItem(item);
        };

        if (typeof input.title === 'string') item.title = input.title;
        if (typeof input.folder === 'string' && State.folders.includes(input.folder)) item.folder = input.folder;
        if (Array.isArray(input.tags)) item.tags = normalizeTagList(input.tags);
        if (Array.isArray(input.add_tags)) {
            item.tags = Array.from(new Set([...(item.tags || []), ...normalizeTagList(input.add_tags)]));
        }
        if (Array.isArray(input.remove_tags)) {
            const drop = new Set(normalizeTagList(input.remove_tags));
            item.tags = (item.tags || []).filter((tag) => !drop.has(tag));
        }
        if (typeof input.pinned === 'boolean') item.isPinned = input.pinned;

        item.updatedAt = Date.now();
        saveItem(item);
        renderApp();
        return aiAgentToolResult(true, `已更新《${itemDisplayTitle(item)}》的属性`, { undo, data: { id: item.id } });
    }

    if (name === 'create_folder') {
        const name = String(input.name || '').trim();
        if (!name) return aiAgentToolResult(false, '文件夹名称不能为空');
        if (State.folders.includes(name)) return aiAgentToolResult(true, `文件夹「${name}」已存在`);
        State.folders.push(name);
        saveConfig();
        renderApp();
        return aiAgentToolResult(true, `已新建文件夹「${name}」`);
    }

    if (name === 'trash_note') {
        const item = resolveAiAgentNote(input.id);
        if (!item) return aiAgentToolResult(false, `没有找到笔记：${input.id}`);
        const confirmed = await showConfirm(`AI 想把《${itemDisplayTitle(item)}》移入废纸篓`, {
            title: 'Agent 操作确认',
            detail: '移入废纸篓后可以在废纸篓里恢复。是否允许这一步？',
            type: 'warning',
            icon: 'delete',
            confirmLabel: '移入废纸篓',
            danger: true
        });
        if (!confirmed) return aiAgentToolResult(false, '用户拒绝了这一步');
        const undo = () => {
            item.isTrashed = false;
            item.updatedAt = Date.now();
            saveItem(item);
        };
        item.isTrashed = true;
        item.updatedAt = Date.now();
        closeTab(item.id);
        saveItem(item);
        renderApp();
        return aiAgentToolResult(true, `已将《${itemDisplayTitle(item)}》移入废纸篓`, { undo, data: { id: item.id } });
    }

    return aiAgentToolResult(false, `未知工具：${name}`);
}

/* Agent 模式：一轮提问内最多 AI_AGENT_MAX_STEPS 步工具调用，
   每一步都以「操作卡片」列在回答里，写操作附带撤销。 */
async function runAiAgentTurn(chat, assistantMessage) {
    assistantMessage.agent = true;
    assistantMessage.steps = [];
    const tools = buildAiAgentToolPayload();
    const messages = buildAiRequestMessages(chat);

    for (let step = 0; step < AI_AGENT_MAX_STEPS; step++) {
        const result = await streamAiChat({ messages, tools }, {
            signal: State.aiAbort.signal,
            onDelta: (content) => {
                assistantMessage.content = content;
                updateStreamingBubble(assistantMessage);
            }
        });

        assistantMessage.content = result.content;
        if (!result.toolCalls.length) return;

        const calls = result.toolCalls.map((call, index) => ({
            id: call.id || `call_${step}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: call.arguments }
        }));
        messages.push({ role: 'assistant', content: result.content || '', tool_calls: calls });

        for (const call of calls) {
            let args = {};
            try {
                args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            } catch (error) {
                args = {};
            }
            const label = describeAiAgentStep(call.function.name, args);
            const stepEntry = { id: call.id, name: call.function.name, label, status: 'running' };
            assistantMessage.steps.push(stepEntry);
            renderAiMessages();
            scrollAiToBottom();

            let outcome;
            try {
                outcome = await executeAiAgentTool(call.function.name, args);
            } catch (error) {
                outcome = aiAgentToolResult(false, error && error.message ? error.message : '执行失败');
            }

            stepEntry.status = outcome.ok ? 'done' : 'failed';
            stepEntry.detail = outcome.message;
            if (outcome.undo) {
                stepEntry.undoable = true;
                registerAiAgentUndo(call.id, { label, undo: outcome.undo });
            }
            renderAiMessages();
            scrollAiToBottom();

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify({ ok: outcome.ok, message: outcome.message, data: outcome.data || null })
            });
        }
    }
}

// 操作卡片的标题：按工具与参数拼一句人话
function describeAiAgentStep(name, args) {
    const input = args || {};
    if (name === 'list_notes') return '查找笔记';
    if (name === 'read_note') return `读取笔记 ${input.id || ''}`;
    if (name === 'create_note') return `新建笔记《${input.title || '未命名'}》`;
    if (name === 'update_note_content') return `修改正文（${input.mode === 'append' ? '追加' : '替换'}）`;
    if (name === 'update_note_meta') return '修改笔记属性';
    if (name === 'create_folder') return `新建文件夹「${input.name || ''}」`;
    if (name === 'trash_note') return '移入废纸篓';
    return name;
}

/* ---------------- 初始化 ---------------- */

function initAiPanel() {
    const scopeSelect = document.getElementById('ai-scope-select');
    scopeSelect.value = State.ai.scope || 'current';
    scopeSelect.onchange = () => {
        State.ai.scope = AI_SCOPE_VALUES.includes(scopeSelect.value) ? scopeSelect.value : 'current';
        // 用户自己挑过范围就不再自动改回去（见 updateAiScopeOptions）
        aiScopeParkedForMissingNote = false;
        saveConfig();
        updateAiScopeOptions();
    };

    const agentToggle = document.getElementById('ai-agent-toggle');
    agentToggle.onclick = () => toggleAiAgentMode(!isAiAgentMode());
    syncAiAgentToggle();

    document.getElementById('btn-ai-new-chat').onclick = () => {
        if (State.aiStreaming) {
            showToast('正在生成回答，请先停止或等待完成');
            return;
        }
        createAiConversation();
        renderAiMessages();
        renderAiChatList();
        showToast('已新建对话');
    };
    document.getElementById('btn-ai-history').onclick = () => {
        const drawer = document.getElementById('ai-drawer');
        if (drawer.classList.contains('hidden')) openAiDrawer();
        else closeAiDrawer();
    };
    document.getElementById('btn-ai-drawer-close').onclick = closeAiDrawer;
    document.getElementById('btn-ai-drawer-new').onclick = () => {
        createAiConversation();
        closeAiDrawer();
        renderAiMessages();
        showToast('已新建对话');
    };
    document.getElementById('btn-ai-clear').onclick = clearAiChat;
    document.getElementById('btn-ai-close').onclick = closeAiPanel;
    document.getElementById('btn-ai-send').onclick = sendAiMessage;
    document.getElementById('btn-ai-stop').onclick = stopAiStreaming;
    document.getElementById('btn-ai-attach').onclick = pickAiAttachments;

    const input = document.getElementById('ai-input');
    input.oninput = updateAiComposerState;
    input.addEventListener('keydown', (event) => {
        // Enter 发送，Shift+Enter 换行；输入法组合期间不接管
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            sendAiMessage();
        }
    });
    input.addEventListener('paste', (event) => {
        const items = event.clipboardData && event.clipboardData.files ? event.clipboardData.files : null;
        if (items && items.length) {
            event.preventDefault();
            importAiAttachments(items);
        }
    });

    // 拖拽投放：图片 / 文本文件可直接拖进面板
    const panel = document.getElementById('ai-panel');
    panel.addEventListener('dragover', (event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        panel.classList.add('drop-active');
    });
    panel.addEventListener('dragleave', (event) => {
        if (event.target === panel) panel.classList.remove('drop-active');
    });
    panel.addEventListener('drop', (event) => {
        if (!event.dataTransfer) return;
        event.preventDefault();
        panel.classList.remove('drop-active');
        if (event.dataTransfer.files && event.dataTransfer.files.length) importAiAttachments(event.dataTransfer.files);
    });

    applyAiEnabledState();
    renderAiAttachments();
    updateAiModelChip();
    updateAiScopeOptions();
    updateAiComposerState();

    if (State.aiPanelOpen) {
        State.aiPanelOpen = false;
        openAiPanel();
    }
}
