/* 数据层：条目模型、与桌面版一致的 .md 文件格式，以及浏览器内的持久化。
   本地数据以「一份文件一段文本」的形式保存（notes/{id}.md、todos/{id}.md），
   与同步协议里的路径一一对应，推拉操作因此可以直接取用同一份文本。 */

const META_HEADER = 'EsprinData';
const META_BLOCK_PATTERN = /^<!--[ \t]*EsprinData[ \t]*\r?\n([\s\S]*?)(?:\r?\n)?[ \t]*-->[ \t]*(?=\r?\n|$)/;
const NOTE_DIR = 'notes';
const TODO_DIR = 'todos';
// AI 对话：与桌面版同名同目录，但**不**参与同步（同步只认 notes/ 与 todos/ 下的 Markdown），
// 它们只存在本浏览器里，免得把一份带密钥痕迹的对话记进服务器的操作日志
const AI_CHAT_DIR = 'ai_chats';
const DEFAULT_FOLDER = '默认';
const TITLE_MAX_LENGTH = 60;
const ITEM_KIND_KEY = '__esprinKind';

// 界面与偏好设置（体积小，直接放 localStorage）
const CONFIG_KEY = 'esprin.nemo.config';
const OUTBOX_KEY = 'esprin.nemo.outbox';
// 数据文件：优先 IndexedDB（容量大），不可用时退回 localStorage
const IDB_NAME = 'esprin-nemo';
const IDB_VERSION = 1;
const IDB_STORE = 'files';
const LS_FILES_KEY = 'esprin.nemo.files';
// 打开本地副本的上限：个别环境里 indexedDB.open 的回调一直不来（file:// 下的无痕式限制、
// 隐私模式、存储被策略拦下），等下去就是静静地卡在启动那一步，到点按不可用处理
const IDB_OPEN_TIMEOUT_MS = 2500;
// 同步游标（已应用到第几号、日志身份、自推序号、上次同步时间）：按账户命名空间各存一份
const SYNC_STATE_KEY = 'esprin.nemo.sync';

/* ---------------- 本地副本的账户命名空间 ----------------
   服务端支持多个账户，同一台浏览器可能先后登录不同账户：两个账户的本地副本、待推送队列与
   同步游标必须各存一份。混在一起的话，换账户登录会把这个账户的条目当成「服务端没见过的
   本地文件」推上去，也会把新账户的内容拉进旧副本。
   命名空间 = 账户名 + 服务端地址；旧版（没有账户概念的）那一份由首个对得上的账户认领，
   认领之后继续用原来的位置，升级上来不必搬数据。
   scope 为空串表示「还没认领的旧版命名空间」，SIGNED_OUT_SCOPE 表示已退出登录。*/
const SCOPE_STORE_KEY = 'esprin.nemo.local.scope';
const SCOPE_OWNER_KEY = 'esprin.nemo.local.scopeOwner';
const SIGNED_OUT_SCOPE = 'signed-out';
const SCOPE_SEPARATOR = '::';
// 旧版写在通用配置里的那一份游标，由 loadConfig 填上（认领旧命名空间的账户继续用它）
let LEGACY_SYNC_STATE = null;

function scopedStorageName(base, scope) {
    return `${base}${SCOPE_SEPARATOR}${scope || 'legacy'}`;
}

function scopeStorageNames(scope) {
    // 认领了旧版命名空间的账户继续用原来的键名与库名
    if (!scope || scopeOwnsLegacy(scope)) {
        return { idb: IDB_NAME, files: LS_FILES_KEY, outbox: OUTBOX_KEY, sync: scopedStorageName(SYNC_STATE_KEY, scope) };
    }
    return {
        idb: `${IDB_NAME}${SCOPE_SEPARATOR}${scope}`,
        files: scopedStorageName(LS_FILES_KEY, scope),
        outbox: scopedStorageName(OUTBOX_KEY, scope),
        sync: scopedStorageName(SYNC_STATE_KEY, scope)
    };
}

function readStoredValue(key) {
    try {
        return localStorage.getItem(key) || '';
    } catch (error) {
        return '';
    }
}

function readCurrentScope() {
    return readStoredValue(SCOPE_STORE_KEY);
}

function writeCurrentScope(scope) {
    try {
        localStorage.setItem(SCOPE_STORE_KEY, String(scope || ''));
    } catch (error) {
        // 写不进去只影响下次引导用哪一份，当前这次不受影响
        console.warn('[WARN] [Storage] 本地命名空间记录写入失败: ' + (error && error.message));
    }
}

function scopeOwnsLegacy(scope) {
    return !!scope && readStoredValue(SCOPE_OWNER_KEY) === scope;
}

// 账户名 + 服务端地址（去掉协议与结尾斜杠）：同名账户挂在不同服务端上也不共用本地副本
function scopeKeyFor(account, baseUrl) {
    const name = String(account || '').trim();
    if (!name) return '';
    return `${name}@${serverHostFromUrl(baseUrl)}`;
}

function serverHostFromUrl(url) {
    const text = String(url || '').trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
    return text || 'local';
}

/* 旧版（无账户）副本的归属判定：只有日志身份对得上时才认领。
   服务端迁到多账户时内置账户的日志身份不变，升级上来的浏览器因此能一次对上；
   日志身份为空（还没同步过）时也认领 —— 那是新浏览器，认领只是继承一个空位置。*/
function claimLegacyScope(scope, journalId) {
    if (!scope || scope === SIGNED_OUT_SCOPE || scopeOwnsLegacy(scope)) return false;
    if (readStoredValue(SCOPE_OWNER_KEY)) return false;
    const legacyJournalId = String((LEGACY_SYNC_STATE || {}).journalId || '');
    if (legacyJournalId && legacyJournalId !== String(journalId || '')) return false;
    try {
        localStorage.setItem(SCOPE_OWNER_KEY, scope);
    } catch (error) {
        return false;
    }
    return true;
}

function syncStateStorageKey(scope = FileStore.scope) {
    return scopeStorageNames(scope).sync;
}

function readSyncState(scope = FileStore.scope) {
    try {
        const parsed = JSON.parse(localStorage.getItem(syncStateStorageKey(scope)) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
}

// 同步游标按账户命名空间落盘；界面与偏好仍写在通用配置里（saveConfig）
function saveSyncState() {
    const payload = {
        lastSeq: Number(State.sync.lastSeq) || 0,
        journalId: typeof State.sync.journalId === 'string' ? State.sync.journalId : '',
        selfPushed: Array.isArray(State.sync.selfPushed) ? State.sync.selfPushed : [],
        lastSyncAt: Number(State.sync.lastSyncAt) || 0,
        lastSyncSummary: typeof State.sync.lastSyncSummary === 'string' ? State.sync.lastSyncSummary : ''
    };
    try {
        localStorage.setItem(syncStateStorageKey(), JSON.stringify(payload));
    } catch (error) {
        console.error('[ERROR] [Storage] 同步游标写入失败: ' + (error && error.message));
    }
}

/* 把某个账户的游标装进 State.sync：优先它自己那一份；
   认领旧命名空间（或还没认领）时回退到旧版写在通用配置里的那份，避免首次同步整份重放。*/
function loadSyncState(scope) {
    const stored = readSyncState(scope);
    const fallback = !stored && (!scope || scopeOwnsLegacy(scope)) ? LEGACY_SYNC_STATE : null;
    const data = stored || fallback || {};
    State.sync.lastSeq = Number(data.lastSeq) || 0;
    State.sync.journalId = typeof data.journalId === 'string' ? data.journalId : '';
    State.sync.selfPushed = Array.isArray(data.selfPushed)
        ? data.selfPushed
            .map((value) => Math.round(Number(value)))
            .filter((value) => Number.isFinite(value) && value > 0)
        : [];
    State.sync.lastSyncAt = Number(data.lastSyncAt) || 0;
    State.sync.lastSyncSummary = typeof data.lastSyncSummary === 'string' ? data.lastSyncSummary : '';
    return data;
}

const State = {
    notes: [],
    todos: [],
    folders: [DEFAULT_FOLDER],
    activeNoteId: null,
    openNoteIds: [],
    currentFilter: 'all',
    searchQuery: '',
    sortBy: 'updated-desc',
    viewMode: 'edit',
    theme: 'system',
    // 主题风格（皮肤）：default 为内置的 GitHub 风格，alom 为 Alom 风格
    themeStyle: 'default',
    accentColor: '',
    brandColor: 'brand',
    cornerRadius: 'default',
    sidebarCollapsed: false,
    spellcheck: false,
    trashRetentionDays: 0,
    // 界面布局：modern（现代布局：不排标题栏，标签页移到工作区顶部，默认）
    // / classic（经典布局：标题栏与标签页照旧）
    uiMode: 'modern',
    // 现代布局下是否禁用标签页（只属于现代布局：经典布局的标签页归标题栏所有）
    tabsDisabled: false,
    // 界面尺寸（缩放比例）：1 为 100%，浏览器里落在根元素的 CSS 缩放上（见 boot.js 与 app.js）
    uiScale: 1,
    // AI 助手：接口配置。注意密钥保存在本浏览器（localStorage）里，
    // 与桌面版交给系统密钥链保管不同——共享这台浏览器就等于共享密钥
    ai: {
        enabled: true,
        agentMode: false,
        baseUrl: '',
        model: '',
        apiKey: '',
        scope: 'current',
        maxNotes: 10,
        systemPrompt: ''
    },
    aiPanelOpen: false,
    aiConversations: [],
    aiActiveConversationId: '',
    aiStreaming: false,
    aiAbort: null,
    aiStreamingChatId: '',
    aiPendingAttachments: [],
    // 服务端存储：网页版默认把启动它的 EsprinSync 当存储，地址默认即当前站点。
    // 账户名只在走账户密码登录时用；token 只在改用访问令牌时用
    sync: {
        enabled: false,
        url: '',
        account: '',
        token: '',
        device: '',
        autoSync: '5s',
        autoSyncSeconds: 60,
        lastSeq: 0,
        journalId: '',
        lastSyncAt: 0,
        lastSyncSummary: '',
        // 本机推上去、服务端已受理的操作序号：重放时跳过它们（见 sync.js 的 applyRemoteOp）
        selfPushed: []
    },
    saveTimer: null,
    previewTimer: null
};

/* ---------------- AI 对话与小本本的本地文件 ----------------
   对话一份一个文件（ai_chats/{id}.json），与桌面版同目录同名，
   但只落在本浏览器的 IndexedDB 里，不进同步队列（见文件开头的说明）。 */

function aiChatPath(chatId) {
    return `${AI_CHAT_DIR}/${chatId}.json`;
}

function parseAiChatText(text) {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        console.warn('[WARN] [AI] 对话文件解析失败: ' + (error && error.message));
        return null;
    }
}

// 从浏览器存储里读出全部对话，按最后修改时间排好
async function loadAiChatsFromStore() {
    const files = await FileStore.readAll();
    const chats = [];
    Object.keys(files).forEach((path) => {
        if (!path.startsWith(`${AI_CHAT_DIR}/`) || !path.endsWith('.json')) return;
        FileStore.memory.set(path, files[path]);
        const chat = parseAiChatText(files[path]);
        if (!chat || !Array.isArray(chat.messages)) return;
        if (!chat.id) chat.id = path.slice(path.lastIndexOf('/') + 1).replace(/\.json$/i, '');
        chats.push(chat);
    });
    State.aiConversations = chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function saveAiChatFile(chat) {
    if (!chat || !chat.id) return false;
    FileStore.write(aiChatPath(chat.id), JSON.stringify(chat, null, 2));
    return true;
}

function deleteAiChatFile(chatId) {
    if (!chatId) return false;
    FileStore.remove(aiChatPath(chatId));
    return true;
}

/* ---------------- 文件格式 ----------------
   与桌面版 storage.js 完全一致：头部注释记元数据，空行之后是正文。
   格式一致才能与桌面客户端互推：同内容写出的字节相同，哈希也相同。 */

function formatMetaValue(value) {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    const text = typeof value === 'string' ? value : '';
    return text ? JSON.stringify(text) : '';
}

function formatMetaLine(key, value) {
    const text = formatMetaValue(value);
    return text ? `    ${key}: ${text}` : `    ${key}:`;
}

function serializeItemFile(item, isTodo) {
    const folder = item.folder && item.folder !== DEFAULT_FOLDER ? item.folder : '';
    const lines = [
        `<!--${META_HEADER}`,
        formatMetaLine('title', item.title || ''),
        formatMetaLine('folder', folder),
        formatMetaLine('tags', Array.isArray(item.tags) ? item.tags : []),
        formatMetaLine('isPinned', !!item.isPinned),
        formatMetaLine('isTrashed', !!item.isTrashed)
    ];
    if (isTodo) lines.push(formatMetaLine('isDone', !!item.isDone));
    /* 秘密本：只在这两项确实成立时写出对应行。
       加密条目永远走 serializeSecretBody 取正文（已解锁则现做密文，未解锁则写回原密文），
       明文因此不会出现在本地副本与同步队列里 */
    if (item.isHidden === true) lines.push(formatMetaLine('isHidden', true));
    if (item.locked === true) lines.push(formatMetaLine('isLocked', true));
    lines.push(formatMetaLine('createdAt', Number(item.createdAt) || Date.now()));
    lines.push(formatMetaLine('updatedAt', Number(item.updatedAt) || Date.now()));
    lines.push('-->');

    const header = lines.join('\n');
    const content = serializeSecretBody(item);
    return content ? `${header}\n\n${content}` : `${header}\n`;
}

// 解析 .md：返回 { meta, content }；没有注释的文件整份都算正文
function parseItemFile(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    const matched = text.match(META_BLOCK_PATTERN);
    if (!matched) return { meta: null, content: text };

    const meta = {};
    matched[1].split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        const separator = trimmed.indexOf(':');
        if (separator <= 0) return;
        meta[trimmed.slice(0, separator).trim()] = trimmed.slice(separator + 1).trim();
    });

    let content = text.slice(matched[0].length);
    const gap = content.match(/^(?:\r?\n){1,2}/);
    if (gap) content = content.slice(gap[0].length);
    if (!content.trim()) content = '';
    return { meta, content };
}

function readMetaString(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return '';
    if (text.startsWith('"')) {
        try {
            const parsed = JSON.parse(text);
            return typeof parsed === 'string' ? parsed : '';
        } catch (error) {
            return text;
        }
    }
    return text;
}

function readMetaNumber(raw, fallback) {
    const value = Number(String(raw == null ? '' : raw).trim());
    return Number.isFinite(value) ? Math.round(value) : fallback;
}

function readMetaBoolean(raw, fallback) {
    const text = String(raw == null ? '' : raw).trim().toLowerCase();
    if (text === 'true' || text === '1' || text === 'yes') return true;
    if (text === 'false' || text === '0' || text === 'no') return false;
    return fallback;
}

function readMetaTags(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.filter((tag) => typeof tag === 'string' && tag.trim());
    } catch (error) {
        // 旧格式：以逗号分隔的裸文本
        return text.split(',').map((tag) => tag.trim()).filter(Boolean);
    }
    return [];
}

// 没有标题时用正文首个非空行兜底
function deriveTitle(content) {
    const line = String(content || '').split(/\r?\n/).find((item) => item.trim());
    if (!line) return '';
    const text = line.trim();
    return text.length > TITLE_MAX_LENGTH ? text.slice(0, TITLE_MAX_LENGTH) : text;
}

/* ---------------- 本地文件存储 ---------------- */

const FileStore = {
    mode: 'idb',
    db: null,
    chain: Promise.resolve(),
    memory: new Map(),
    lsTimer: null,
    // 当前打开的是哪个账户的本地副本（'' = 还没认领的旧版命名空间）
    scope: readCurrentScope(),
    idbName: IDB_NAME,
    filesKey: LS_FILES_KEY,

    /* 切到另一个账户的本地副本。位置没变时只换标记（真正切了的返回 true，调用方据此重新装载条目）。
       必须先关掉旧连接再开新的：两个命名空间是两个库。 */
    async useScope(scope) {
        const names = scopeStorageNames(scope);
        const moved = names.idb !== this.idbName || names.files !== this.filesKey;
        this.scope = scope;
        writeCurrentScope(scope);
        if (!moved) return false;

        // 旧命名空间里可能还有没落盘的改动（localStorage 模式是延迟写的）：
        // 换库之前必须先刷回它自己的键，否则那几百毫秒内的编辑会跟着一起丢掉
        clearTimeout(this.lsTimer);
        this.lsTimer = null;
        if (this.mode === 'localStorage') this.writeLocalStorage();

        if (this.db) {
            try { this.db.close(); } catch (error) { /* 已关闭或已失效：换库本来就要丢掉它 */ }
        }
        this.db = null;
        this.mode = 'idb';
        this.chain = Promise.resolve();
        this.memory.clear();
        this.idbName = names.idb;
        this.filesKey = names.files;
        await this.open();
        return true;
    },

    async open() {
        if (!window.indexedDB) {
            this.mode = 'localStorage';
            this.loadFromLocalStorage();
            return;
        }
        try {
            this.db = await new Promise((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                    settled = true;
                    reject(new Error(`打开超时（${IDB_OPEN_TIMEOUT_MS}ms）`));
                }, IDB_OPEN_TIMEOUT_MS);
                const request = indexedDB.open(this.idbName, IDB_VERSION);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
                };
                request.onsuccess = () => {
                    clearTimeout(timer);
                    // 超时之后才回来的库没人接手：关掉它，免得占着一份连接
                    if (settled) {
                        try { request.result.close(); } catch (error) { /* 已经用不上它了 */ }
                        return;
                    }
                    resolve(request.result);
                };
                request.onerror = () => {
                    clearTimeout(timer);
                    if (!settled) reject(request.error);
                };
            });
        } catch (error) {
            console.warn('[WARN] [Storage] IndexedDB 不可用，改用 localStorage: ' + (error && error.message));
            this.mode = 'localStorage';
            this.loadFromLocalStorage();
        }
    },

    loadFromLocalStorage() {
        try {
            const parsed = JSON.parse(localStorage.getItem(this.filesKey) || '{}');
            Object.keys(parsed).forEach((path) => this.memory.set(path, parsed[path]));
        } catch (error) {
            console.warn('[WARN] [Storage] 本地文件表读取失败: ' + (error && error.message));
        }
    },

    flushLocalStorage() {
        clearTimeout(this.lsTimer);
        this.lsTimer = setTimeout(() => {
            this.lsTimer = null;
            this.writeLocalStorage();
        }, 400);
    },

    // 立刻把内存里的文件写回当前命名空间的键（切换命名空间、退出登录前必须调）
    writeLocalStorage() {
        const plain = {};
        this.memory.forEach((text, path) => { plain[path] = text; });
        try {
            localStorage.setItem(this.filesKey, JSON.stringify(plain));
        } catch (error) {
            console.error('[ERROR] [Storage] localStorage 写入失败: ' + (error && error.message));
            showToast('本地存储写入失败：容量已满，请先清理或导出数据');
        }
    },

    // 读出全部文件：{ path: text }
    async readAll() {
        if (this.mode === 'localStorage' || !this.db) return Object.fromEntries(this.memory);
        const rows = await new Promise((resolve, reject) => {
            const tx = this.db.transaction(IDB_STORE, 'readonly');
            const store = tx.objectStore(IDB_STORE);
            const paths = store.getAllKeys();
            const values = store.getAll();
            tx.oncomplete = () => resolve({ paths: paths.result || [], values: values.result || [] });
            tx.onerror = () => reject(tx.error);
        });
        const files = {};
        rows.paths.forEach((path, index) => { files[path] = rows.values[index]; });
        return files;
    },

    write(path, text) {
        this.memory.set(path, text);
        if (this.mode === 'localStorage' || !this.db) {
            this.flushLocalStorage();
            return;
        }
        this.chain = this.chain.then(() => new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(text, path);
            tx.oncomplete = () => resolve();
            tx.onerror = () => {
                console.error('[ERROR] [Storage] 写入失败: ' + (tx.error && tx.error.message) + ' (path=' + path + ')');
                resolve();
            };
        }));
    },

    remove(path) {
        this.memory.delete(path);
        if (this.mode === 'localStorage' || !this.db) {
            this.flushLocalStorage();
            return;
        }
        this.chain = this.chain.then(() => new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(path);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        }));
    },

    async clear() {
        this.memory.clear();
        if (this.mode === 'localStorage' || !this.db) {
            localStorage.removeItem(this.filesKey);
            return;
        }
        await new Promise((resolve) => {
            const tx = this.db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    }
};

/* ---------------- 条目助手 ---------------- */

function itemPath(item) {
    return `${isTodoItem(item) ? TODO_DIR : NOTE_DIR}/${item.id}.md`;
}

function markItemKind(item, kind) {
    if (!item || typeof item !== 'object') return item;
    try {
        Object.defineProperty(item, ITEM_KIND_KEY, {
            value: kind,
            writable: true,
            enumerable: false,
            configurable: true
        });
    } catch (error) {
        // 对象被冻结等极端情况下退回线性查找
    }
    return item;
}

function isTodoItem(item) {
    if (!item || typeof item !== 'object') return false;
    const kind = item[ITEM_KIND_KEY];
    if (kind === 'todo') return true;
    if (kind === 'note') return false;
    const isTodo = State.todos.indexOf(item) !== -1;
    markItemKind(item, isTodo ? 'todo' : 'note');
    return isTodo;
}

function itemKindLabel(item) {
    return isTodoItem(item) ? '待办' : '笔记';
}

function itemDisplayTitle(item) {
    return item.title || `未命名${itemKindLabel(item)}`;
}

function isReadOnlyItem(item) {
    return !!(item && (item.isTrashed || isSecretLocked(item)));
}

function getItemById(itemId) {
    if (!itemId) return null;
    return State.todos.find((t) => t.id === itemId) || State.notes.find((n) => n.id === itemId) || null;
}

function generateItemId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(10);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, (byte) => chars.charAt(byte % chars.length)).join('');
}

function generateUniqueItemId(kind) {
    // 优先用服务端回收池里的 ID：被删掉的那一条腾出来的 ID 会重新落到新建的条目上
    // （池子在 scripts/sync.js 里维护，未接入同步时为空）
    const recycled = typeof Sync !== 'undefined' && Sync ? String(Sync.takeRecycledId(kind) || '') : '';
    if (recycled && !isItemIdTaken(recycled)) return recycled;

    let id = generateItemId();
    while (isItemIdTaken(id)) id = generateItemId();
    return id;
}

// 这个 ID 是不是还有人在用：内存里的条目与本地文件（notes/、todos/ 共用一个 ID 空间）都算
function isItemIdTaken(id) {
    if (!id) return true;
    if (getItemById(id)) return true;
    return FileStore.memory.has(`${NOTE_DIR}/${id}.md`) || FileStore.memory.has(`${TODO_DIR}/${id}.md`);
}

// .md 文件 → 条目对象
function buildItemFromFile(path, text) {
    const isTodo = path.startsWith(`${TODO_DIR}/`);
    const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    const { meta, content } = parseItemFile(text);
    const now = Date.now();
    const item = {
        id,
        title: (meta ? readMetaString(meta.title) : '') || deriveTitle(content),
        content,
        folder: (meta ? readMetaString(meta.folder) : '') || DEFAULT_FOLDER,
        tags: meta ? readMetaTags(meta.tags) : [],
        isPinned: meta ? readMetaBoolean(meta.isPinned, false) : false,
        isTrashed: meta ? readMetaBoolean(meta.isTrashed, false) : false,
        // 秘密本：隐藏与加密状态。locked 还要求正文确实是密文信封——
        // 元数据写着 isLocked 而正文是明文（半途落下的文件）时按普通笔记处理，
        // 免得把明文当成密文去解密。与桌面版 storage.js 的判定一致
        isHidden: meta ? readMetaBoolean(meta.isHidden, false) : false,
        locked: (meta ? readMetaBoolean(meta.isLocked, false) : false) && isSecretEnvelope(content),
        unlocked: false,
        createdAt: meta ? readMetaNumber(meta.createdAt, now) : now,
        updatedAt: meta ? readMetaNumber(meta.updatedAt, now) : now
    };
    if (isTodo) item.isDone = meta ? readMetaBoolean(meta.isDone, false) : false;
    // id 取自文件名；元数据里没有标题时按与桌面版一致的规则回落正文首行
    markItemKind(item, isTodo ? 'todo' : 'note');
    return item;
}

/* ---------------- 载入与保存 ---------------- */

// 启动时把本地文件全部读进内存并解析成条目
async function loadItemsFromStore() {
    const files = await FileStore.readAll();
    FileStore.memory = new Map(Object.entries(files));

    const notes = [];
    const todos = [];
    Object.keys(files).sort().forEach((path) => {
        if (path.startsWith(`${NOTE_DIR}/`) && path.endsWith('.md')) {
            notes.push(buildItemFromFile(path, files[path]));
        } else if (path.startsWith(`${TODO_DIR}/`) && path.endsWith('.md')) {
            todos.push(buildItemFromFile(path, files[path]));
        }
    });

    State.notes = notes;
    State.todos = todos;

    // 文件夹：以条目实际使用到的文件夹并集为准，另外并上配置里保存过的空文件夹
    const used = new Set();
    [...notes, ...todos].forEach((item) => { if (item.folder) used.add(item.folder); });
    const saved = new Set(State.folders);
    State.folders = [...new Set([DEFAULT_FOLDER, ...saved, ...used])];
}

/* 本地命名空间换过之后重新装载：条目与 AI 对话都从新的库里读，最后重绘。
   上一个账户的文件夹清单不能留到下一个账户的界面上，所以从默认值重新算。 */
async function reloadLocalData() {
    clearSecretSession();
    State.activeNoteId = null;
    State.openNoteIds = [];
    State.folders = [DEFAULT_FOLDER];
    await loadItemsFromStore();
    if (typeof loadAiChatsFromStore === 'function') await loadAiChatsFromStore();
    if (typeof renderApp === 'function') renderApp();
}

// 保存单个条目：元数据与正文一起写回对应文件，并把改动排进同步队列
function saveItem(item) {
    if (!item) return false;
    const path = itemPath(item);
    const text = serializeItemFile(item, isTodoItem(item));
    const previous = FileStore.memory.get(path);
    if (previous === text) return false;

    FileStore.write(path, text);
    Sync.queueLocalChange('put', path);
    return true;
}

function deleteItemFile(item) {
    if (!item) return false;
    const path = itemPath(item);
    if (!FileStore.memory.has(path)) return false;
    FileStore.remove(path);
    Sync.queueLocalChange('del', path);
    return true;
}

// 远端推送过来的文本落进本地（不再回头排队推给服务端）
function applyRemoteFile(path, text) {
    FileStore.write(path, text);
    const item = buildItemFromFile(path, text);
    // 秘密本：远端可能重封了密文（同一把密钥、换个 IV），能就地解开就保持解锁，
    // 解不开（对方换了口令）则丢掉会话密钥，退回未解锁
    restoreSecretSession(item);
    const isTodo = isTodoItem(item);
    State[isTodo ? 'todos' : 'notes'] = State[isTodo ? 'todos' : 'notes'].filter((entry) => entry.id !== item.id);
    State[isTodo ? 'todos' : 'notes'].push(item);
    if (!State.folders.includes(item.folder)) State.folders.push(item.folder);
    return item;
}

function removeRemoteFile(path) {
    const id = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
    FileStore.remove(path);
    forgetSecretKey(id);
    State.notes = State.notes.filter((item) => item.id !== id);
    State.todos = State.todos.filter((item) => item.id !== id);
    return id;
}

/* ---------------- 配置读写 ---------------- */

function saveConfig() {
    const payload = {
        folders: State.folders,
        theme: State.theme,
        themeStyle: State.themeStyle,
        accentColor: State.accentColor,
        brandColor: State.brandColor,
        cornerRadius: State.cornerRadius,
        sortBy: State.sortBy,
        viewMode: State.viewMode,
        sidebarCollapsed: State.sidebarCollapsed,
        spellcheck: State.spellcheck,
        trashRetentionDays: State.trashRetentionDays,
        uiMode: State.uiMode,
        tabsDisabled: State.tabsDisabled,
        uiScale: normalizeUiScale(State.uiScale),
        ai: {
            enabled: State.ai.enabled,
            agentMode: State.ai.agentMode,
            baseUrl: State.ai.baseUrl,
            model: State.ai.model,
            apiKey: State.ai.apiKey,
            scope: State.ai.scope,
            maxNotes: State.ai.maxNotes,
            systemPrompt: State.ai.systemPrompt
        },
        sync: {
            enabled: State.sync.enabled,
            url: State.sync.url,
            account: State.sync.account,
            token: State.sync.token,
            device: State.sync.device,
            autoSync: State.sync.autoSync,
            autoSyncSeconds: State.sync.autoSyncSeconds
        }
    };
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(payload));
    } catch (error) {
        console.error('[ERROR] [Config] 配置写入失败: ' + (error && error.message));
    }
    // 游标另存一份：它属于当前账户的命名空间，不能跟着通用配置走
    saveSyncState();
}

function loadConfig() {
    let parsed = null;
    try {
        parsed = JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
    } catch (error) {
        console.warn('[WARN] [Config] 配置解析失败，按默认值启动: ' + (error && error.message));
    }
    if (!parsed || typeof parsed !== 'object') return;

    if (Array.isArray(parsed.folders) && parsed.folders.length) State.folders = parsed.folders;
    if (typeof parsed.theme === 'string') State.theme = parsed.theme;
    if (typeof parsed.themeStyle === 'string') State.themeStyle = parsed.themeStyle;
    if (typeof parsed.accentColor === 'string') State.accentColor = parsed.accentColor;
    if (typeof parsed.brandColor === 'string') State.brandColor = parsed.brandColor;
    if (typeof parsed.cornerRadius === 'string') State.cornerRadius = parsed.cornerRadius;
    if (typeof parsed.sortBy === 'string') State.sortBy = parsed.sortBy;
    if (typeof parsed.viewMode === 'string') State.viewMode = parsed.viewMode;
    State.sidebarCollapsed = !!parsed.sidebarCollapsed;
    State.spellcheck = !!parsed.spellcheck;
    State.trashRetentionDays = Number(parsed.trashRetentionDays) || 0;
    // 旧配置里可能存着 line / notab / minimal（旧名）与 standard（更早的经典布局名）
    State.uiMode = normalizeUiMode(parsed.uiMode);
    State.tabsDisabled = !!parsed.tabsDisabled;
    State.uiScale = normalizeUiScale(parsed.uiScale);

    const ai = parsed.ai && typeof parsed.ai === 'object' ? parsed.ai : {};
    State.ai.enabled = ai.enabled === undefined ? true : !!ai.enabled;
    State.ai.agentMode = !!ai.agentMode;
    State.ai.baseUrl = typeof ai.baseUrl === 'string' ? ai.baseUrl : '';
    State.ai.model = typeof ai.model === 'string' ? ai.model : '';
    State.ai.apiKey = typeof ai.apiKey === 'string' ? ai.apiKey : '';
    State.ai.scope = AI_SCOPE_VALUES.includes(ai.scope) ? ai.scope : 'current';
    State.ai.maxNotes = Math.max(1, Math.min(50, Number(ai.maxNotes) || 10));
    State.ai.systemPrompt = typeof ai.systemPrompt === 'string' ? ai.systemPrompt : '';

    const sync = parsed.sync && typeof parsed.sync === 'object' ? parsed.sync : {};
    State.sync.enabled = !!sync.enabled;
    State.sync.url = typeof sync.url === 'string' ? sync.url : '';
    State.sync.account = typeof sync.account === 'string' ? sync.account : '';
    State.sync.token = typeof sync.token === 'string' ? sync.token : '';
    State.sync.device = typeof sync.device === 'string' ? sync.device : '';
    State.sync.autoSync = typeof sync.autoSync === 'string' ? sync.autoSync : '5s';
    State.sync.autoSyncSeconds = Number(sync.autoSyncSeconds) || 60;
    // 游标（lastSeq / journalId / selfPushed / lastSyncAt）不在这里读：它按账户命名空间存放，
    // 由 loadSyncState 装载。旧版把它写在通用配置里，先留一份给认领旧命名空间的账户。
    LEGACY_SYNC_STATE = {
        lastSeq: Number(sync.lastSeq) || 0,
        journalId: typeof sync.journalId === 'string' ? sync.journalId : '',
        selfPushed: Array.isArray(sync.selfPushed) ? sync.selfPushed : [],
        lastSyncAt: Number(sync.lastSyncAt) || 0,
        lastSyncSummary: typeof sync.lastSyncSummary === 'string' ? sync.lastSyncSummary : ''
    };
}

/* ---------------- 列表过滤与搜索 ---------------- */

const PREVIEW_MAX_LENGTH = 120;

function isPreviewWhitespace(code) {
    return code <= 32
        || code === 0xa0
        || code === 0x1680
        || (code >= 0x2000 && code <= 0x200a)
        || code === 0x2028
        || code === 0x2029
        || code === 0x202f
        || code === 0x205f
        || code === 0x3000
        || code === 0xfeff;
}

function buildPreviewText(raw) {
    const text = String(raw || '');
    const length = text.length;
    let start = 0;
    while (start < length && isPreviewWhitespace(text.charCodeAt(start))) start++;
    if (start >= length) return '暂无内容';

    const lineBreak = text.indexOf('\n', start);
    let end = lineBreak === -1 ? length : lineBreak;
    while (end > start && isPreviewWhitespace(text.charCodeAt(end - 1))) end--;

    const firstLine = text.slice(start, end);
    return firstLine.length > PREVIEW_MAX_LENGTH ? firstLine.slice(0, PREVIEW_MAX_LENGTH) : firstLine;
}

const PREVIEW_TEXT_CACHE = new WeakMap();

function itemPreviewText(item) {
    // 加密条目没解锁时没有明文可展示（正文是密文信封）
    if (isSecretLocked(item)) return '已加密的正文（解锁后可读）';
    const raw = typeof item.content === 'string' ? item.content : '';
    const cached = PREVIEW_TEXT_CACHE.get(item);
    if (cached && cached.source === raw) return cached.text;
    const text = buildPreviewText(raw);
    PREVIEW_TEXT_CACHE.set(item, { source: raw, text });
    return text;
}

const SEARCH_TEXT_CACHE = new WeakMap();

function itemSearchText(item) {
    const title = typeof item.title === 'string' ? item.title : '';
    // 未解锁的加密条目只按标题匹配：内存里的正文是密文
    const content = isSecretLocked(item) ? '' : (typeof item.content === 'string' ? item.content : '');
    const cached = SEARCH_TEXT_CACHE.get(item);
    if (cached && cached.title === title && cached.content === content) return cached.text;
    const text = `${title}\n${content}`.toLowerCase();
    SEARCH_TEXT_CACHE.set(item, { title, content, text });
    return text;
}

// 某个筛选下的条目：笔记 / 待办各自一个入口，其余视图两类混排，置顶优先。
// filter 默认取当前筛选；传别的值是给窄屏滑动切页时拼「相邻页」用的（见 scripts/app.js）
function getFilteredItems(filter = State.currentFilter) {
    const isTrashView = filter === 'trash';
    const isPinnedView = filter === 'pinned';
    const onlyNotes = filter === 'all';
    const onlyTodos = filter === 'todos';
    const folderFilter = filter.startsWith('folder:') ? filter.slice(7) : null;
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const query = State.searchQuery.trim().toLowerCase();
    const sortBy = State.sortBy;

    const list = [];
    const consider = (item, isTodo) => {
        if (onlyNotes && isTodo) return;
        if (onlyTodos && !isTodo) return;
        // 隐藏的条目不进任何视图（只在「设置 → 秘密本」里能看到）
        if (isSecretHidden(item)) return;

        if (item.isTrashed) {
            if (!isTrashView) return;
        } else {
            if (isTrashView) return;
            if (isPinnedView && !item.isPinned) return;
            if (folderFilter !== null && item.folder !== folderFilter) return;
            if (tagFilter !== null && (!Array.isArray(item.tags) || !item.tags.includes(tagFilter))) return;
        }

        if (query && !itemSearchText(item).includes(query)) return;
        list.push(item);
    };
    State.notes.forEach((item) => consider(item, false));
    State.todos.forEach((item) => consider(item, true));

    return list.sort((a, b) => {
        if (!isTrashView) {
            if (a.isPinned && !b.isPinned) return -1;
            if (!a.isPinned && b.isPinned) return 1;
        }
        if (sortBy === 'updated-desc') return b.updatedAt - a.updatedAt;
        if (sortBy === 'created-desc') return b.createdAt - a.createdAt;
        if (sortBy === 'title-asc') return itemDisplayTitle(a).localeCompare(itemDisplayTitle(b), 'zh-CN');
        return 0;
    });
}

function getAllTags() {
    const tags = new Set();
    [...State.notes, ...State.todos].filter((item) => !item.isTrashed).forEach((item) => {
        if (Array.isArray(item.tags)) item.tags.forEach((tag) => { if (tag) tags.add(tag); });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function panelCategoryTitle(filter) {
    if (filter === 'all') return '全部笔记';
    if (filter === 'todos') return '全部待办';
    if (filter === 'pinned') return '已置顶';
    if (filter === 'trash') return '废纸篓';
    if (filter.startsWith('folder:')) return filter.replace('folder:', '');
    if (filter.startsWith('tag:')) return `#${filter.replace('tag:', '')}`;
    return '全部笔记';
}

/* 当前筛选是不是「分类过滤」（文件夹 / 标签）：底栏那四页之外的另一类筛选。
   列表表头的筛选键点不点亮、面板里排不排「清除筛选」，都问它 */
function isCategoryFilter(filter) {
    return filter.startsWith('folder:') || filter.startsWith('tag:');
}

// 搜索框提示的正文。快捷键那截由渲染层按屏幕档位补（窄屏没有 Ctrl+K，见 scripts/render.js）
function searchPlaceholderText(filter) {
    if (filter === 'all') return '搜索笔记...';
    if (filter === 'todos') return '搜索待办...';
    return '搜索笔记与待办...';
}

/* ---------------- 数据备份 ---------------- */

// 导出备份：条目数组，导入时按同一套规则恢复
function exportBackup() {
    return {
        version: 1,
        exportedAt: Date.now(),
        folders: State.folders,
        items: [...State.notes, ...State.todos].map((item) => ({
            id: item.id,
            kind: isTodoItem(item) ? 'todo' : 'note',
            title: item.title,
            // 秘密本：已解锁的条目导出时同样写密文，备份文件里不出现明文
            content: serializeSecretBody(item),
            folder: item.folder,
            tags: item.tags,
            isPinned: !!item.isPinned,
            isTrashed: !!item.isTrashed,
            isDone: !!item.isDone,
            // 秘密本：备份同样要带上这两项，否则加密正文会被当成普通笔记导出
            isHidden: item.isHidden === true,
            locked: item.locked === true,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt
        }))
    };
}

// 导入备份：id 重复、时间戳非法、字段类型不对的条目在此一并规范化
function importBackup(raw, { replace = false } = {}) {
    const list = raw && Array.isArray(raw.items) ? raw.items : [];
    if (!list.length) return 0;

    if (replace) {
        State.notes = [];
        State.todos = [];
        FileStore.memory.forEach((text, path) => {
            if (path.startsWith(`${NOTE_DIR}/`) || path.startsWith(`${TODO_DIR}/`)) FileStore.remove(path);
        });
    }

    const used = new Set([...State.notes, ...State.todos].map((item) => item.id));
    let imported = 0;
    list.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        const isTodo = entry.kind === 'todo';
        let id = typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || used.has(id)) id = generateUniqueItemId();
        used.add(id);

        const now = Date.now();
        const createdAt = Number(entry.createdAt);
        const updatedAt = Number(entry.updatedAt);
        const content = typeof entry.content === 'string' ? entry.content : '';
        const item = {
            id,
            title: typeof entry.title === 'string' ? entry.title : '',
            content,
            folder: typeof entry.folder === 'string' && entry.folder.trim() ? entry.folder.trim() : DEFAULT_FOLDER,
            tags: Array.isArray(entry.tags) ? entry.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : [],
            isPinned: !!entry.isPinned,
            isTrashed: !!entry.isTrashed,
            // 秘密本：按与文件解析同一套规则恢复状态（内容是否真是密文由这里判）
            isHidden: !!entry.isHidden,
            locked: !!entry.locked && isSecretEnvelope(content),
            createdAt: Number.isFinite(createdAt) ? Math.round(createdAt) : now,
            updatedAt: Number.isFinite(updatedAt) ? Math.round(updatedAt) : now
        };
        if (isTodo) item.isDone = !!entry.isDone;
        markItemKind(item, isTodo ? 'todo' : 'note');
        State[isTodo ? 'todos' : 'notes'].push(item);
        if (!State.folders.includes(item.folder)) State.folders.push(item.folder);
        saveItem(item);
        imported += 1;
    });
    return imported;
}

async function clearAllData() {
    await FileStore.clear();
    // 明文副本与密钥一并丢掉：重新拉回来的都是密文
    clearSecretSession();
    State.notes = [];
    State.todos = [];
    State.folders = [DEFAULT_FOLDER];
    State.openNoteIds = [];
    State.activeNoteId = null;
    // 副本与队列一起丢掉，并把同步位置归零：下次同步会从服务器重新拉回全部内容
    Sync.outbox = [];
    Sync.writeOutbox();
    State.sync.lastSeq = 0;
    // 自推序号跟着作废：清空之后本地的副本全没了，重放反而得如实应用
    State.sync.selfPushed = [];
    State.sync.lastSyncAt = 0;
    State.sync.lastSyncSummary = '';
    saveConfig();
}