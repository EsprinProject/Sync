/* 启动与全局事件：主题、侧边栏形态、快捷键与各入口的事件绑定 */

let sidebarFadeTimer = null;
let searchDebounce = null;
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)');
// 窄屏（手机与竖屏平板）：侧边栏整条收起、列表与工作区各占一屏，见 styles/web.css
const narrowScreenQuery = window.matchMedia('(max-width: 860px)');

/* ---------------- 换肤交叉淡入 ----------------
   与 styles/motion.css 的 html.appearance-fading 配对：先挂类、强制刷一次样式，
   再改配色，浏览器才会把这次变化当成「有过渡的变化」而不是同一次计算里的硬切。 */

let appearanceFadeTimer = null;

function beginAppearanceFade() {
    const root = document.documentElement;
    root.classList.add('appearance-fading');
    // 强制一次样式计算：否则「挂类」与「改配色」会被合并，过渡根本没机会播
    void root.offsetWidth;
    clearTimeout(appearanceFadeTimer);
    appearanceFadeTimer = setTimeout(() => root.classList.remove('appearance-fading'), APPEARANCE_FADE_MS + 60);
}

/* ---------------- 安装为应用（PWA） ----------------
   清单与图标是静态文件（见 manifest.webmanifest），这里只管两件事：
   浏览器界面色跟着主题走，以及注册离线外壳的 Service Worker。 */

// 浏览器界面色（Android 状态栏、独立窗口的标题栏）：取标题栏底色，换肤后立即跟上
function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const value = getComputedStyle(document.documentElement).getPropertyValue('--bg-titlebar').trim();
    if (value) meta.setAttribute('content', value);
}

// Service Worker 把界面外壳存进缓存，断网时仍能打开这一页。
// 它只在安全上下文的 http(s) 下能注册：局域网 http 与 file:// 都会被浏览器拒掉，那种环境直接跳过
function registerServiceWorker() {
    const httpish = /^https?:$/i.test(window.location.protocol);
    if (!httpish || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    navigator.serviceWorker.register('sw.js').catch((error) => {
        console.warn(`[WARN] [PWA] Service worker 注册失败 (detail=${error && error.message})`);
    });
}

/* ---------------- 主题 ---------------- */

function resolvedTheme() {
    if (State.theme === 'light' || State.theme === 'dark') return State.theme;
    return systemThemeQuery.matches ? 'light' : 'dark';
}

function applyTheme({ fade = false } = {}) {
    if (fade) beginAppearanceFade();
    const resolved = resolvedTheme();
    document.documentElement.classList.toggle(LIGHT_THEME_CLASS, resolved === 'light');
    const icon = document.getElementById('theme-icon');
    icon.textContent = State.theme === 'system' ? 'computer' : resolved === 'light' ? 'light_mode' : 'dark_mode';
    document.getElementById('btn-theme-toggle').title = State.theme === 'system'
        ? `切换主题（当前跟随系统：${resolved === 'light' ? '浅色' : '深色'}）`
        : `切换主题（当前：${resolved === 'light' ? '浅色' : '深色'}）`;
    syncThemeColor();
}

function setTheme(value) {
    const next = THEME_VALUES.includes(value) ? value : 'system';
    if (next === State.theme) return;
    State.theme = next;
    applyTheme({ fade: true });
    saveConfig();
}

// 标题栏按钮：在深色与浅色之间切换；处于「跟随系统」时切到系统当前主题的反面
function toggleTheme() {
    const next = resolvedTheme() === 'light' ? 'dark' : 'light';
    State.theme = next;
    applyTheme({ fade: true });
    saveConfig();
    const select = document.getElementById('setting-theme');
    if (select) select.value = State.theme;
}

/* ---------------- 主题风格（皮肤） ----------------
   default 为内置的 GitHub 风格，alom 为 Alom 风格（styles/alom.css 按 <html data-theme-style> 接手）。 */

function normalizeThemeStyle(value) {
    return THEME_STYLE_VALUES.includes(value) ? value : 'default';
}

function applyThemeStyle({ fade = false } = {}) {
    if (fade) beginAppearanceFade();
    document.documentElement.dataset.themeStyle = normalizeThemeStyle(State.themeStyle);
}

function setThemeStyle(value) {
    const next = normalizeThemeStyle(value);
    if (next === State.themeStyle) return;
    State.themeStyle = next;
    applyThemeStyle({ fade: true });
    saveConfig();
    showToast(next === 'alom' ? '已切换到 Alom 风格' : '已切换到默认风格');
}

/* ---------------- 主题色 ---------------- */

function normalizeHex(value) {
    const text = String(value || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) return '';
    return text.toUpperCase();
}

// 强调色底面上的文字色：按相对亮度取黑或白，浅色主题色上不会出现白字看不清
function accentForeground(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

function applyAccentColor() {
    const root = document.documentElement;
    const color = normalizeHex(State.accentColor);
    if (!color) {
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent-bg');
        root.style.removeProperty('--accent-fg');
        return;
    }
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    root.style.setProperty('--accent', color);
    root.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.15)`);
    root.style.setProperty('--accent-fg', accentForeground(color));
}

function setAccentColor(value, rerender = true) {
    const raw = String(value || '').trim();
    if (!raw) {
        State.accentColor = '';
    } else {
        const normalized = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`);
        if (!normalized) {
            showToast('主题色设置失败：请填写 #RRGGBB 格式的十六进制颜色');
            return;
        }
        State.accentColor = normalized;
    }
    applyAccentColor();
    saveConfig();
    // 取色器拖动过程中不重建面板：一是跟手，二是避免输入框失去焦点
    if (rerender && activeSettingsCategory === 'appearance') renderSettingsView();
    else if (typeof syncAccentSelection === 'function') syncAccentSelection();
}

/* ---------------- 形状与品牌色 ---------------- */

// 圆角尺度：只切 <html data-radius>，最终生效的圆角由 styles/radius.css 按档位换算
function applyCornerRadius(value) {
    State.cornerRadius = CORNER_RADIUS_VALUES.includes(value) ? value : 'default';
    document.documentElement.dataset.radius = State.cornerRadius;
}

function setBrandColor(value) {
    State.brandColor = BRAND_COLOR_VALUES.includes(value) ? value : 'brand';
    document.documentElement.dataset.brandColor = State.brandColor;
    saveConfig();
}

/* 界面尺寸（缩放比例）：浏览器里没有窗口缩放，落在根元素的 CSS 缩放上（1 为 100%）。
   取值整理与首屏应用在 boot.js 的 UI_SCALE_*，设置页的滑块与自定义输入见 scripts/settings.js。 */
function applyUiScale() {
    document.documentElement.style.zoom = String(normalizeUiScale(State.uiScale));
}

function setUiScale(value) {
    State.uiScale = normalizeUiScale(value);
    applyUiScale();
    saveConfig();
}

/* ---------------- 侧边栏收起 / 展开 ---------------- */

function isNarrowScreen() {
    return narrowScreenQuery.matches;
}

function applySidebarCollapsed(animate = false) {
    const html = document.documentElement;
    const sidebar = document.getElementById('app-sidebar');
    const icon = document.getElementById('sidebar-toggle-icon');
    const toggle = document.getElementById('btn-toggle-sidebar');
    // 窄屏下侧边栏整条收起（见 styles/web.css），不再参与「收起 / 展开」这一对形态
    const collapsed = !!State.sidebarCollapsed && !isNarrowScreen();

    const finish = () => {
        html.classList.toggle('sidebar-collapsed', collapsed);
        sidebar.classList.remove('text-fading', 'icons-fading');
        icon.textContent = collapsed ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left';
        toggle.title = collapsed ? '展开侧边栏' : '收起侧边栏';
    };

    if (!animate) {
        finish();
        return;
    }

    // 收起：文字与底栏图标先渐隐，再收窄；展开：先撑开宽度，文字后显
    clearTimeout(sidebarFadeTimer);
    if (collapsed) {
        sidebar.classList.add('text-fading', 'icons-fading');
        sidebarFadeTimer = setTimeout(finish, 160);
        return;
    }
    html.classList.remove('sidebar-collapsed');
    icon.textContent = 'keyboard_double_arrow_left';
    toggle.title = '收起侧边栏';
    sidebar.classList.add('text-fading');
    sidebarFadeTimer = setTimeout(() => sidebar.classList.remove('text-fading'), 220);
}

function toggleSidebarCollapsed() {
    State.sidebarCollapsed = !State.sidebarCollapsed;
    applySidebarCollapsed(true);
    saveConfig();
}

/* ---------------- 窄屏：换档 ----------------
   手机端没有侧边栏（见 styles/web.css），转屏与改窗口宽度时只剩三件事：
   收起展开着的底栏面板、让设置页回到分类列表（它是两级，见 scripts/settings.js），
   并把列表重建一次 —— 搜索框提示（窄屏不写 Ctrl+K）与窄屏专有的那几处渲染都跟着换过来。 */

function bindBreakpointChange() {
    narrowScreenQuery.addEventListener('change', () => {
        applySidebarCollapsed(false);
        setMobileSheetOpen(false);
        // 从宽屏缩到窄屏时不该直接落进上一次那个分类的面板里
        setSettingsSubpageOpen(false);
        listPager.reset();
        renderListPanel();
    });
}

/* ---------------- 窄屏：底栏上沿的面板 ----------------
   按下中间那枚后，底栏上沿向上滑出一块面板：平时是新建笔记 / 新建待办，
   切到废纸篓时中间那枚换成「清空」、滑开的是确认面板（见 scripts/render.js）。
   其余画面压一层深色遮罩：点遮罩、按 Esc 或转屏都收回（见 styles/mobile.css）。 */

function isMobileSheetOpen() {
    const bar = document.getElementById('mobile-tabbar');
    return !!bar && bar.classList.contains('sheet-open');
}

function setMobileSheetOpen(open) {
    const bar = document.getElementById('mobile-tabbar');
    const fab = document.getElementById('btn-mobile-fab');
    if (!bar) return;

    // 遮罩的显隐跟着底栏上的 .sheet-open 走（见 styles/mobile.css），这样才能淡入淡出
    const next = !!open && isNarrowScreen();
    bar.classList.toggle('sheet-open', next);
    if (fab) fab.setAttribute('aria-expanded', next ? 'true' : 'false');
}

/* ---------------- 窄屏：虚拟键盘 ---------------- */

// 软键盘：键盘弹起时页面高度不一定变，只在 visualViewport 上体现。
// 把这段差值记进 --keyboard-inset，并给 <html> 挂 keyboard-open（见 styles/mobile.css）
function bindKeyboardInset() {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const apply = () => {
        const inset = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
        document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
        document.documentElement.classList.toggle('keyboard-open', isNarrowScreen() && inset > 80);
    };
    viewport.addEventListener('resize', apply);
    viewport.addEventListener('scroll', apply);
    apply();
}

// 底栏实测高度：条目菜单要严丝合缝贴在它的上沿（见 styles/mobile.css 第 3 节）。
// 高度随字号、屏底留白与「键盘弹起时收起」变化，交给 ResizeObserver 跟着量
function observeTabbarHeight() {
    const bar = document.getElementById('mobile-tabbar');
    if (!bar) return;
    const apply = () => {
        const height = bar.getBoundingClientRect().height;
        document.documentElement.style.setProperty('--mobile-tabbar-height', `${Math.round(height)}px`);
    };
    apply();
    if (typeof ResizeObserver === 'function') new ResizeObserver(apply).observe(bar);
}

/* ---------------- 窄屏列表的翻页动效 ----------------
   列表整块横向位移、旁边挂一张相邻页的快照（.notes-list-ghost），是滑动手势与底栏点按
   共用的底座：手势让它跟手走（moveBy），点按让它自己滑过去（slideTo）。
   快照与列表同一套卡片工厂（见 render.js 的 buildListPage），所以两页永远长得一样；
   两页之间那条分界线画在快照朝向当前页的那一侧（见 styles/mobile.css）。 */
const listPager = {
    list: null,
    ghost: null,
    step: 0,        // >0：相邻页在右（往左划、去下一页）；<0：在左
    width: 0,       // 一页的宽（＝列表的宽）
    timer: 0,
    pending: null,  // 换页动画的收尾函数；动画期间又来了新动作时要能提前落定

    bind() {
        this.list = document.getElementById('notes-list-box');
        return !!this.list;
    },

    measure() {
        const panel = document.querySelector('.notes-panel');
        this.width = (this.list && this.list.clientWidth) || (panel && panel.clientWidth) || 0;
        return this.width;
    },

    // 快照与列表同一块位置、同高同宽，只是横向让开一整页
    mount(filter, step) {
        const panel = document.querySelector('.notes-panel');
        if (!panel || !this.list) return;
        this.step = step;
        this.measure();
        const page = buildListPage(filter);
        // 侧边类名用来把两者之间那条分界线画到朝向当前页的一侧
        page.classList.add('notes-list-ghost', step > 0 ? 'to-right' : 'to-left');
        const listBox = this.list.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        page.style.top = `${Math.round(listBox.top - panelBox.top)}px`;
        page.style.height = `${Math.round(listBox.height)}px`;
        page.style.left = `${step > 0 ? this.width : -this.width}px`;
        panel.appendChild(page);
        this.ghost = page;
    },

    dropGhost() {
        if (!this.ghost) return;
        this.ghost.remove();
        this.ghost = null;
    },

    // 手势定了方向：把那侧的相邻页挂上（没有就作罢，之后走阻尼），并进入跟手态
    startSwipe(step) {
        const target = neighbourFilter(step);
        if (target) this.mount(target, step);
        else this.step = step;
        this.list.classList.add('swiping');
        this.moveBy(0, false);
    },

    moveBy(offset, animated) {
        if (!this.list) return;
        const transition = animated ? 'transform var(--motion-base) var(--ease-out)' : 'none';
        this.list.style.transition = transition;
        this.list.style.transform = `translateX(${offset}px)`;
        if (!this.ghost) return;
        this.ghost.style.transition = transition;
        this.ghost.style.transform = `translateX(${offset}px)`;
    },

    // 这一次位移跑完再收尾：听过渡事件，另留一个定时器兜底（掉帧、系统关掉过渡、
    // prefers-reduced-motion 下没有过渡事件时都能收尾）
    armSettle(finish) {
        const list = this.list;
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            this.pending = null;
            list.removeEventListener('transitionend', onEnd);
            finish();
        };
        const onEnd = (endEvent) => {
            if (endEvent.target !== list || endEvent.propertyName !== 'transform') return;
            done();
        };
        this.pending = done;
        list.addEventListener('transitionend', onEnd);
        this.timer = setTimeout(done, 260);
    },

    // 把剩下那截位移补完，动画收尾后换页并归位 —— 相邻页此刻显示的正是要换过去的内容，
    // 所以换页这一下看不出接缝（重渲染与归位在同一帧里完成）
    commitTo(filter) {
        this.moveBy(this.step > 0 ? -this.width : this.width, true);
        this.armSettle(() => {
            applyMobileFilter(filter);
            this.reset();
        });
    },

    // 从当前页滑到 step 方向的那一页（底栏点按用）：先挂上快照并落到位、强制一次布局，
    // 下一帧再起步 —— 初始值与目标值写在同一帧里的话，过渡不会跑
    slideTo(filter, step) {
        if (!this.bind()) return false;
        this.flushPending();
        this.reset();
        this.mount(filter, step);
        this.list.classList.add('swiping');
        this.moveBy(0, false);
        void this.list.offsetWidth;
        requestAnimationFrame(() => this.commitTo(filter));
        return true;
    },

    // 动画还在跑时又来了新动作（连着划两页、飞快连点两个按钮）：先把这一页落定，
    // 再让新动作从落定的位置开始，否则那一次换页会被静默丢掉
    flushPending() {
        const finish = this.pending;
        this.pending = null;
        if (finish) finish();
    },

    // 收拾现场：拿掉快照、清掉位移与过渡
    reset() {
        clearTimeout(this.timer);
        this.timer = 0;
        this.dropGhost();
        if (this.list) {
            this.list.classList.remove('swiping');
            this.list.style.transition = '';
            this.list.style.transform = '';
        }
        this.step = 0;
    },
};

/* ---------------- 窄屏：列表上左右滑动切页面 ----------------
   拇指在列表上往左 / 往右划，按底栏那四个筛选的次序前后翻一页（笔记 → 待办 → 置顶 → 废纸篓），
   并且跟手：认定的横向滑动会把列表整块跟着手指移，相邻页的卡片此刻也拼好排在旁边，
   松手滑过阈值就提交（重渲染整页并归位），没滑够就弹回原位。
   只认「起点落在列表里、没被别的手势或浮层接管」的滑动：屏幕左缘那一条留给浏览器
   自己的返回手势（原先留给导航抽屉），输入框与按钮上的横向拖动不算，浮层铺开时遮罩盖住列表，
   事件也就落不到这里；当前筛选不是那四个之一（文件夹、标签）时整条手势不动作。 */
const FILTER_SWIPE_MIN_X = 8;           // 认定「横向滑动」所需的最小位移
const FILTER_SWIPE_COMMIT_X = 48;       // 松手时至少滑过这么远才翻页
const FILTER_SWIPE_COMMIT_RATIO = 0.25; // 或者滑过一页宽的四分之一
const FILTER_SWIPE_FLICK = 0.35;        // 或者甩得够快就来（px/ms，即 350px/s）
const FILTER_SWIPE_RUBBER = 0.35;       // 到头了还硬拉时的阻尼
const FILTER_SWIPE_EDGE = 32;           // 左缘这一条留给浏览器自己的返回手势

// 底栏那几页的次序（与移动端底栏的 DOM 顺序一致）
function filterSequence() {
    return [...document.querySelectorAll('.mobile-tab[data-filter]')]
        .map((tab) => tab.getAttribute('data-filter'));
}

// 相邻页的筛选：当前筛选是文件夹、标签，或已经在这一头到头时为 null
function neighbourFilter(step) {
    const filters = filterSequence();
    const index = filters.indexOf(State.currentFilter);
    return index === -1 ? null : filters[index + step] || null;
}

function bindFilterSwipe() {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let axis = '';
    let samples = [];      // 最近几个触摸点（{x, t}），用来算「短而快」那一下的速度

    // 甩动速度（px/ms）：只看最后 100ms 这一小段，手指停下来再抬起的速度因此接近于 0
    const flickVelocity = () => {
        if (samples.length < 2) return 0;
        const last = samples[samples.length - 1];
        let first = last;
        for (let i = samples.length - 1; i >= 0; i -= 1) {
            if (last.t - samples[i].t > 100) break;
            first = samples[i];
        }
        const span = last.t - first.t;
        return span > 0 ? (last.x - first.x) / span : 0;
    };

    document.addEventListener('touchstart', (event) => {
        if (!isNarrowScreen() || event.touches.length !== 1) return;
        const touch = event.touches[0];
        if (touch.clientX < FILTER_SWIPE_EDGE) return;
        const target = event.target;
        if (!target.closest('.notes-panel')) return;
        if (target.closest('button, input, textarea, select')) return;
        if (!listPager.bind()) return;
        // 上一轮的收尾（弹回 / 换页动画）还没跑完就先落定，免得两套位移叠在一起
        listPager.flushPending();
        listPager.reset();
        samples = [];
        tracking = true;
        startX = touch.clientX;
        startY = touch.clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        if (!tracking) return;
        const touch = event.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        samples.push({ x: touch.clientX, t: event.timeStamp });
        if (samples.length > 8) samples.shift();

        if (!axis) {
            // 先竖着动起来的是在滚列表；横向还没拉开之前先不定方向
            if (Math.abs(dy) > 30) {
                tracking = false;
                return;
            }
            if (Math.abs(dx) < FILTER_SWIPE_MIN_X) return;
            axis = 'x';
            listPager.measure();
            // 两头都够不着（文件夹、标签视图）时整条手势不接，连位移都不给
            if (!neighbourFilter(1) && !neighbourFilter(-1)) {
                tracking = false;
                axis = '';
                return;
            }
            listPager.startSwipe(dx < 0 ? 1 : -1);
        }

        // 手指中途掉头：相邻页换成另一侧那一张（不换的话，原先那张会跟着反方向越走越远，
        // 反方向那一侧就露出一块空面板）
        if (Math.abs(dx) > FILTER_SWIPE_MIN_X && (dx < 0 ? 1 : -1) !== listPager.step) {
            listPager.dropGhost();
            listPager.startSwipe(dx < 0 ? 1 : -1);
        }

        // 跟手：有相邻页就照搬位移，到头了给它一点阻尼（拉完会弹回去）
        listPager.moveBy(listPager.ghost ? dx : dx * FILTER_SWIPE_RUBBER, false);
    }, { passive: true });

    document.addEventListener('touchend', (event) => {
        if (!tracking) return;
        tracking = false;
        if (axis !== 'x') return;

        const dx = event.changedTouches[0].clientX - startX;
        samples.push({ x: event.changedTouches[0].clientX, t: event.timeStamp });
        const target = listPager.ghost ? neighbourFilter(listPager.step) : null;
        const speed = flickVelocity();
        const passed = Math.abs(dx) > Math.max(FILTER_SWIPE_COMMIT_X, listPager.width * FILTER_SWIPE_COMMIT_RATIO)
            // 滑得短但甩得快也算：方向要与这一次位移同向，免得往回抛一下反而翻页
            || (Math.abs(speed) > FILTER_SWIPE_FLICK && speed * dx > 0);

        // 没滑够、或这一头没有相邻页：弹回原位
        if (!target || !passed) {
            listPager.moveBy(0, true);
            listPager.timer = setTimeout(() => listPager.reset(), 220);
            return;
        }

        listPager.commitTo(target);
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        tracking = false;
        if (axis === 'x') listPager.reset();
    }, { passive: true });
}

// 真正切这一页（不含动效）：滑动提交与点按动画的收尾都走这里
function applyMobileFilter(filter) {
    setMobileSheetOpen(false);
    flushPendingSave();
    State.currentFilter = filter;
    renderApp();
    // 换了一页就从顶部看起（渲染本身不动滚动位置，列表节点没换）
    const box = document.getElementById('notes-list-box');
    if (box) box.scrollTop = 0;
}

// 窄屏四个主切换：底栏点按走这一条（带翻页动效），滑动手势的收尾走 applyMobileFilter
function selectMobileFilter(filter) {
    if (!filter) return;
    setMobileSheetOpen(false);
    if (filter === State.currentFilter) return;
    // 选中态先亮起来，别等动画收尾（renderCounts 稍后还会统一刷一遍）
    document.querySelectorAll('.mobile-tab[data-filter]').forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-filter') === filter);
    });
    // 目标在次序里靠后（在右边）就从右往左滑进来；当前页不在底栏那几页里（文件夹、标签）
    // 时也按「从右侧进来」算
    const filters = filterSequence();
    const from = filters.indexOf(State.currentFilter);
    const to = filters.indexOf(filter);
    const step = from === -1 || to > from ? 1 : -1;
    if (!isNarrowScreen() || !listPager.slideTo(filter, step)) applyMobileFilter(filter);
}

/* ---------------- 窄屏：列表上的上下拉手势 ----------------
   列表拉到顶 / 底之后（再拉也滚不动）继续往下 / 往上拉：
     下滑 → 聚焦搜索框（手机上没有 Ctrl+K，搜索就靠这一下把键盘唤起来）；
     上滑 → 与底栏中间那枚同义：平时滑出新建面板，废纸篓下换成清空确认
            （见 render.js 的 applyMobileFabMode）。
   只在「本来就没得滚」的那一头接，所以列表中间的上下拖动仍只是滚列表；
   横向拉开超过 30px 的交给翻页手势（见 bindFilterSwipe），两者互不接管。 */
const PULL_GESTURE_MIN_Y = 64;   // 触发所需的纵向位移
const PULL_GESTURE_AXIS = 30;    // 横向超过这个就当作横向操作，本手势不接

function focusSearchBox() {
    const input = document.getElementById('input-search');
    if (input) input.focus();
}

// 与底栏中间那枚同义。底栏不在场时不接：让位时它要么是 display: none（桌面端），
// 要么已经 translateY(100%) 滑出屏外（见 styles/mobile.css 的那组「底栏让位」规则）——
// 面板长在底栏上沿，没有底栏就没有它
function triggerMobileFabAction() {
    const bar = document.getElementById('mobile-tabbar');
    if (!bar) return;
    const style = getComputedStyle(bar);
    if (style.display === 'none' || style.transform !== 'none') return;
    setMobileSheetOpen(!isMobileSheetOpen());
}

function bindListPullGestures() {
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let axis = '';

    // 还能往那一头滚就不接：那是在滚列表，拉到顶 / 底之后才轮到这两个手势
    const canPull = (dy) => {
        const box = document.getElementById('notes-list-box');
        if (!box) return false;
        if (dy > 0) return box.scrollTop <= 0;
        return box.scrollTop >= box.scrollHeight - box.clientHeight - 1;
    };

    document.addEventListener('touchstart', (event) => {
        if (!isNarrowScreen() || event.touches.length !== 1) return;
        const target = event.target;
        if (!target.closest('.notes-panel')) return;
        if (target.closest('button, input, textarea, select')) return;
        const touch = event.touches[0];
        tracking = true;
        axis = '';
        startX = touch.clientX;
        startY = touch.clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (event) => {
        if (!tracking) return;
        const touch = event.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        if (!axis) {
            if (Math.abs(dx) > PULL_GESTURE_AXIS) {
                tracking = false;
                return;
            }
            if (Math.abs(dy) < 8) return;
            axis = 'y';
        }
        if (!canPull(dy)) tracking = false;
    }, { passive: true });

    document.addEventListener('touchend', (event) => {
        if (!tracking) return;
        tracking = false;
        if (axis !== 'y') return;
        const dy = event.changedTouches[0].clientY - startY;
        if (Math.abs(dy) < PULL_GESTURE_MIN_Y || !canPull(dy)) return;
        if (dy > 0) focusSearchBox();
        else triggerMobileFabAction();
    }, { passive: true });

    document.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
}

/* ---------------- 窄屏：编辑器的进退场 ----------------
   打开条目时编辑器从屏幕右侧整块滑进来，返回列表时往右侧滑回去（见 styles/mobile.css 的
   「工作区的进退场」那一节）—— 进入那一段全部由 CSS 管（两态各自的过渡），
   这里只管退场：切 <html> 上的 editor-leaving 类名，另管一件事：滑动期间顶栏与正文各段保持原样
   （render.js 的 renderWorkspace 会问 isEditorLeaving）—— 同一帧就把它们设成 display: none 的话，
   滑出去的只是一块空板子。滑完（听过渡事件，另留定时器兜底）摘掉类名并补一次重绘，把各段真正收起。 */
const EDITOR_LEAVE_CLASS = 'editor-leaving';
const EDITOR_LEAVE_MS = 260;   // 兜底时长，与列表翻页同一档；过渡本体是 --motion-base

let editorLeaveTimer = 0;

function isEditorLeaving() {
    return document.documentElement.classList.contains(EDITOR_LEAVE_CLASS);
}

function beginEditorLeave() {
    const workspace = document.getElementById('workspace-box');
    if (!workspace) return;

    clearTimeout(editorLeaveTimer);
    document.documentElement.classList.add(EDITOR_LEAVE_CLASS);

    let settled = false;
    const done = () => {
        if (settled) return;
        settled = true;
        workspace.removeEventListener('transitionend', onEnd);
        document.documentElement.classList.remove(EDITOR_LEAVE_CLASS);
        renderApp();
    };
    const onEnd = (event) => {
        if (event.target !== workspace || event.propertyName !== 'transform') return;
        done();
    };
    workspace.addEventListener('transitionend', onEnd);
    editorLeaveTimer = setTimeout(done, EDITOR_LEAVE_MS);
}

// 手机端把编辑器的「编辑 / 分屏 / 预览」与待办完成挪到底栏（拇指区），
// 宽屏挪回顶栏里原来的位置（.editor-meta 之后，见 main 里的 editor-actions）
function applyEditorActionsPlacement() {
    const actions = document.querySelector('.editor-actions');
    const topbar = document.getElementById('editor-topbar');
    const footer = document.querySelector('.editor-footer');
    if (!actions || !topbar || !footer) return;

    if (isNarrowScreen()) {
        if (actions.parentElement !== footer) footer.appendChild(actions);
    } else if (actions.parentElement !== topbar) {
        topbar.appendChild(actions);
    }
}

function bindEditorActionsPlacement() {
    applyEditorActionsPlacement();
    narrowScreenQuery.addEventListener('change', applyEditorActionsPlacement);
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
    // 标题栏
    document.getElementById('app-brand').onclick = () => {
        flushPendingSave();
        State.openNoteIds = [];
        State.activeNoteId = null;
        renderApp();
    };
    document.getElementById('btn-theme-toggle').onclick = toggleTheme;
    document.getElementById('btn-fullscreen').onclick = toggleFullscreen;
    // AI 助手：现代布局下这枚按钮悬浮在右上角，经典布局下在标题栏里，行为一致；
    // 窄屏编辑器顶栏最右端还有一枚（手机上工作区整屏铺开，行内够不到悬浮按钮）
    document.getElementById('btn-ai-assistant').onclick = toggleAiPanel;
    document.getElementById('btn-editor-ai').onclick = toggleAiPanel;
    // 窄屏 AI 面板外的遮罩：点它关闭面板（面板开着时由 styles/mobile.css 的 :has 显出来）
    document.getElementById('mobile-ai-mask').onclick = closeAiPanel;
    // 现代布局的「返回」（标签栏最左端）与窄屏编辑器顶栏里的那一枚
    document.getElementById('btn-tabs-back').onclick = backToNoteList;
    document.getElementById('btn-editor-back').onclick = backToNoteList;
    bindSettingsBack();
    document.getElementById('btn-sync-status').onclick = async () => {
        // 未连接到服务端时弹连接层；已连接则立即同步一次
        if (!State.sync.enabled) {
            showConnectGate(Sync.connectionMessage || '');
            return;
        }
        const result = await Sync.syncNow({ reason: '手动' });
        showToast(result.ok ? `同步完成：${result.summary}` : `同步失败：${result.error}`);
        renderSyncIndicator();
    };

    // 侧边栏
    document.querySelectorAll('.nav-section-main .nav-item').forEach((item) => {
        item.onclick = () => {
            flushPendingSave();
            State.currentFilter = item.getAttribute('data-filter');
            renderApp();
        };
    });
    // 两处「新建」入口共用同一套菜单：同一个按钮再点一次收起
    const toggleNewItemMenuAt = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        toggleNewItemMenu(box.left, box.bottom + 4);
    };
    // 侧边栏顶部的「新建」：现代布局下不再弹菜单，本体直接新建笔记，
    // 悬停时滑出的副本（#btn-new-todo）新建待办；经典布局侧边栏只有这一个入口，
    // 照旧展开「新建笔记 / 新建待办 / 导入文件」菜单
    document.getElementById('btn-new-note').onclick = (event) => {
        if (isModernLayout()) createNewNote();
        else toggleNewItemMenuAt(event);
    };
    document.getElementById('btn-new-todo').onclick = () => createNewTodo();
    document.getElementById('btn-empty-new').onclick = toggleNewItemMenuAt;
    // 列表表头的筛选（窄屏专有）：手机端没有侧边栏，文件夹与标签过滤就这一处入口
    document.getElementById('btn-list-filter').onclick = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        toggleContextMenu('filter', showFilterMenu, box.left, box.bottom + 4);
    };
    // 顶栏右端的菜单（窄屏专有）：深浅色、设置与导入文件
    document.getElementById('btn-mobile-menu').onclick = (event) => {
        const box = event.currentTarget.getBoundingClientRect();
        toggleContextMenu('topbar', showTopbarMenu, box.left, box.bottom + 4);
    };
    // 手机端底部导航：四个主切换与侧边栏同一套筛选；中间那枚向上滑出面板
    document.querySelectorAll('.mobile-tab[data-filter]').forEach((tab) => {
        tab.onclick = () => selectMobileFilter(tab.getAttribute('data-filter'));
    });
    const mobileFab = document.getElementById('btn-mobile-fab');
    if (mobileFab) mobileFab.onclick = () => setMobileSheetOpen(!isMobileSheetOpen());
    document.getElementById('mobile-new-note').onclick = () => {
        setMobileSheetOpen(false);
        createNewNote();
    };
    document.getElementById('mobile-new-todo').onclick = () => {
        setMobileSheetOpen(false);
        createNewTodo();
    };
    // 废纸篓下中间那枚改当「清空」用：滑开的那张面板就是确认步骤，
    // 不再走 clearTrash()（它自己还会弹一层 showConfirm）
    document.getElementById('mobile-trash-clear').onclick = () => {
        setMobileSheetOpen(false);
        performClearTrash();
    };
    document.getElementById('mobile-trash-cancel').onclick = () => setMobileSheetOpen(false);
    // 底栏上沿的面板与条目菜单共用这一层遮罩：点它把两者都收掉
    // （条目菜单另会被下面「点空白关闭」那一条收掉，这里显式再写一次，不必去追那条）
    document.getElementById('mobile-sheet-mask').onclick = () => {
        setMobileSheetOpen(false);
        hideContextMenu();
    };
    document.getElementById('btn-add-folder').onclick = addFolder;
    document.getElementById('btn-empty-trash').onclick = clearTrash;
    document.getElementById('btn-import-note').onclick = pickImportFiles;
    document.getElementById('btn-open-settings').onclick = openSettingsTab;
    document.getElementById('btn-toggle-sidebar').onclick = toggleSidebarCollapsed;
    bindBreakpointChange();
    bindKeyboardInset();
    observeTabbarHeight();
    bindFilterSwipe();
    bindListPullGestures();
    bindEditorActionsPlacement();

    // 中栏
    const searchInput = document.getElementById('input-search');
    searchInput.addEventListener('input', () => {
        State.searchQuery = searchInput.value;
        document.getElementById('btn-search-clear').classList.toggle('hidden', !State.searchQuery);
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(renderListPanel, 120);
    });
    document.getElementById('btn-search-clear').onclick = () => {
        State.searchQuery = '';
        searchInput.value = '';
        document.getElementById('btn-search-clear').classList.add('hidden');
        renderListPanel();
        searchInput.focus();
    };
    document.getElementById('select-sort').onchange = (event) => {
        State.sortBy = event.target.value;
        saveConfig();
        renderListPanel();
    };

    // 编辑器
    document.getElementById('input-note-title').addEventListener('input', autoSaveActiveItem);
    document.getElementById('textarea-note-content').addEventListener('input', () => {
        autoSaveActiveItem();
        scheduleRenderMarkdown();
    });
    document.getElementById('editor-folder-select').addEventListener('change', (event) => setItemFolder(event.target.value));
    document.getElementById('btn-add-tag').onclick = addTag;
    document.getElementById('btn-mode-edit').onclick = () => setViewMode('edit');
    document.getElementById('btn-mode-split').onclick = () => setViewMode('split');
    document.getElementById('btn-mode-preview').onclick = () => setViewMode('preview');
    document.getElementById('btn-todo-done').onclick = () => {
        const item = getActiveItem();
        if (item) toggleTodoDone(item.id);
    };
    document.querySelectorAll('.fmt-btn').forEach((button) => {
        button.onclick = () => formatMarkdown(button.getAttribute('data-fmt'));
    });

    // 浮层关闭：点击空白、滚动、窗口尺寸变化、Esc
    document.addEventListener('click', (event) => {
        // 「新建」与两枚菜单入口自己负责展开 / 收起菜单，这里要跳过它们，
        // 否则菜单刚被展开就会随这次点击冒泡到 document 时立刻收起
        if (event.target.closest('#btn-new-note') || event.target.closest('#btn-empty-new')
            || event.target.closest('#btn-list-filter') || event.target.closest('#btn-mobile-menu')) return;
        if (!event.target.closest('#context-menu')) hideContextMenu();
    });
    document.addEventListener('contextmenu', (event) => {
        if (!event.target.closest('.note-card, .tab-item, .folder-item')) hideContextMenu();
    });
    window.addEventListener('resize', hideContextMenu);
    // 滚动（捕获，任何可滚容器都算）也把菜单收掉：位置是开的时候算死的，内容一动就对不上了。
    // 菜单自己那块列表要滚（窄屏的筛选面板可能很长），从它里面滚出来的事件不算
    window.addEventListener('scroll', (event) => {
        if (event.target instanceof Element && event.target.closest('#context-menu')) return;
        hideContextMenu();
    }, true);

    const mask = document.getElementById('dialog-mask');
    mask.addEventListener('click', (event) => {
        if (event.target === mask) closeDialog(null);
    });
    document.getElementById('dialog-input').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            closeDialog({ id: 'confirm', value: event.target.value });
        }
    });

    document.addEventListener('keydown', handleGlobalKeydown);
    // 标签栏两端的渐隐要跟着滚动一起更新（横滚时才知道哪一侧还有被截断的标签）
    ['titlebar-tabs', 'workspace-tabs'].forEach((id) => {
        const container = document.getElementById(id);
        container.addEventListener('scroll', () => updateTabsFade(container), { passive: true });
    });
    systemThemeQuery.addEventListener('change', () => {
        if (State.theme === 'system') applyTheme();
    });
    window.addEventListener('beforeunload', () => {
        flushPendingSave();
    });
}

function handleGlobalKeydown(event) {
    if (event.key === 'Escape') {
        if (dialogResolve) {
            closeDialog(null);
            return;
        }
        // 连接层可以收起：收起就是留在本地模式（同步仍可从状态 chip 再进来）
        if (!document.getElementById('gate-mask').classList.contains('hidden')) {
            closeConnectGate('Esc');
            return;
        }
        // 底栏展开着的面板
        if (isMobileSheetOpen()) {
            setMobileSheetOpen(false);
            return;
        }
        if (!document.getElementById('context-menu').classList.contains('hidden')) {
            hideContextMenu();
            return;
        }
        // 对话记录抽屉：先收掉这一层，再谈退回列表
        if (!document.getElementById('ai-drawer').classList.contains('hidden')) {
            closeAiDrawer();
            return;
        }
        // 回到笔记列表：标签页保留，只退出当前条目
        backToNoteList();
        return;
    }

    // 弹窗与输入框里不接管快捷键
    const target = event.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (dialogResolve) return;

    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl) return;

    if (event.key.toLowerCase() === 'n' && !event.shiftKey) {
        event.preventDefault();
        createNewNote();
        return;
    }
    if (event.key.toLowerCase() === 'n' && event.shiftKey) {
        event.preventDefault();
        createNewTodo();
        return;
    }
    if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusSearchBox();
        return;
    }
    if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        flushPendingSave();
        showToast('已保存');
        return;
    }
    if (event.key.toLowerCase() === 'w' && !inField) {
        event.preventDefault();
        if (State.activeNoteId) {
            closeTab(State.activeNoteId);
            renderApp();
        }
        return;
    }
    if (event.key === 'Tab') {
        event.preventDefault();
        const ids = State.openNoteIds;
        if (ids.length < 2) return;
        const current = ids.indexOf(State.activeNoteId);
        const step = event.shiftKey ? -1 : 1;
        const next = current === -1 ? (step > 0 ? 0 : ids.length - 1) : (current + step + ids.length) % ids.length;
        flushPendingSave();
        State.activeNoteId = ids[next];
        renderApp();
    }
}

function toggleFullscreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen();
        return;
    }
    // iOS Safari 至今没有全屏 API：先探一下，别把一次点击变成未捕获的异常
    if (typeof document.documentElement.requestFullscreen !== 'function') {
        showToast('当前浏览器不支持全屏，可用「添加到主屏幕」后从桌面图标启动');
        return;
    }
    document.documentElement.requestFullscreen().catch((error) => {
        console.warn('[WARN] [Fullscreen] 进入全屏失败: ' + (error && error.message));
        showToast('全屏失败：浏览器拒绝了该请求');
    });
}

/* ---------------- 启动 ---------------- */

/* ---------------- 连接服务端 ----------------
   网页版的存储就是托管它的 EsprinSync：启动时自动探测，需要凭据时弹一层入口。 */

let gateMode = 'password';
let gateBusy = false;

function setGateMessage(text, tone = '') {
    const msg = document.getElementById('gate-msg');
    msg.textContent = text || '';
    if (tone) msg.dataset.tone = tone;
    else delete msg.dataset.tone;
}

function setGateMode(mode) {
    gateMode = mode === 'token' ? 'token' : 'password';
    const byPassword = gateMode === 'password';
    document.getElementById('gate-account-field').classList.toggle('hidden', !byPassword);
    document.getElementById('gate-password-field').classList.toggle('hidden', !byPassword);
    document.getElementById('gate-token-field').classList.toggle('hidden', byPassword);
    document.getElementById('gate-mode-toggle').textContent = byPassword ? '改用访问令牌' : '改用账户密码';
    document.getElementById('gate-desc').textContent = byPassword
        ? '笔记保存在托管本页的 EsprinSync 上。用服务端上的账户登录，会话在 12 小时后过期。'
        : '笔记保存在托管本页的 EsprinSync 上。填写访问令牌后即可读写。';
    document.getElementById('gate-hint').textContent = byPassword
        ? '账户在服务端管理后台 /admin 新建（默认只有 admin）；也可以在那里创建访问令牌，改用令牌登录。'
        : gateTokenHint();
    const accountInput = document.getElementById('gate-account');
    if (byPassword && !accountInput.value) accountInput.value = defaultGateAccount();
    const field = !byPassword
        ? document.getElementById('gate-token')
        : (accountInput.value ? document.getElementById('gate-password') : accountInput);
    if (!document.getElementById('gate-mask').classList.contains('hidden')) setTimeout(() => field.focus(), 20);
}

// 服务端既没设密码也没建过令牌时，只能先从 /admin 建一份凭据（或填写 --token 启动时用的值）
function gateTokenHint() {
    const info = Sync.serverInfo;
    if (!info) return '访问令牌在服务端管理后台 /admin 创建，形如 esn_…；若服务端以 --token 启动，则填写该参数的值。';
    const configured = !!info.passwordSet || Number(info.tokenCount) > 0;
    return configured
        ? '访问令牌在服务端管理后台 /admin 创建，形如 esn_…；若服务端以 --token 启动，则填写该参数的值。'
        : '服务端尚未设置管理密码，也没有任何访问令牌：请先打开 /admin 设置密码或创建令牌；若服务端以 --token 启动，则填写该参数的值。';
}

// 账户名与上一次用的一致时直接填上，省得每次登录都敲一遍
function defaultGateAccount() {
    const info = Sync.serverInfo || {};
    return State.sync.account || info.defaultAccount || 'admin';
}

function showConnectGate(message = '') {
    document.getElementById('gate-mask').classList.remove('hidden');
    setGateMode(Sync.authHint());
    setGateMessage(message, message ? 'error' : '');
}

function hideConnectGate() {
    document.getElementById('gate-mask').classList.add('hidden');
    setGateMessage('');
}

/* 收起连接层：同步是可选项，关掉这层就留在本地模式（界面与本地副本照常），
   要再连就从顶栏那枚状态 chip 进来。 */
function closeConnectGate(source = '') {
    if (document.getElementById('gate-mask').classList.contains('hidden')) return;
    hideConnectGate();
    renderSyncIndicator();
    console.log(`[INFO] [App] 连接层已收起 (source=${source || '关闭'})`);
}

async function submitConnectGate() {
    if (gateBusy) return;
    const account = document.getElementById('gate-account').value.trim() || 'admin';
    const password = document.getElementById('gate-password').value;
    const token = document.getElementById('gate-token').value.trim();
    if (gateMode === 'password' && !password) {
        setGateMessage('登录失败：请填写账户密码', 'error');
        return;
    }
    if (gateMode === 'token' && !token) {
        setGateMessage('连接失败：请填写访问令牌', 'error');
        return;
    }

    gateBusy = true;
    const submit = document.getElementById('gate-submit');
    submit.disabled = true;
    submit.textContent = '连接中…';
    setGateMessage('正在连接服务端…');

    let result = null;
    try {
        if (gateMode === 'token') {
            State.sync.token = token;
            saveConfig();
            result = await Sync.connect({ reason: '令牌' });
        } else {
            result = await Sync.login(account, password);
        }
    } finally {
        gateBusy = false;
        submit.disabled = false;
        submit.textContent = '连接';
    }

    if (result && result.ok) {
        document.getElementById('gate-password').value = '';
        hideConnectGate();
        renderApp();
        const who = State.sync.account ? `（账户 ${State.sync.account}）` : '';
        showToast(result.summary ? `已连接到服务端${who}：${result.summary}` : `已连接到服务端${who}`);
        return;
    }

    const message = (result && result.error) || '连接失败：服务端未接受当前凭据';
    setGateMessage(gateMode === 'password' ? `登录失败：${message}` : `连接失败：${message}`, 'error');
}

function bindConnectGate() {
    document.getElementById('gate-submit').onclick = submitConnectGate;
    document.getElementById('gate-close').onclick = () => closeConnectGate('关闭按钮');
    // 点卡片外那圈遮罩也收掉：与确认弹窗（.dialog-mask）同一套约定
    const mask = document.getElementById('gate-mask');
    mask.addEventListener('click', (event) => {
        if (event.target === mask) closeConnectGate('遮罩');
    });
    document.getElementById('gate-mode-toggle').onclick = () => setGateMode(gateMode === 'password' ? 'token' : 'password');
    ['gate-account', 'gate-password', 'gate-token'].forEach((id) => {
        document.getElementById(id).addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                submitConnectGate();
            }
        });
    });
}

// 启动时自动连接：服务端在但需要凭据时停在连接层（拿到凭据前不进入笔记界面）；
// 本页不是 EsprinSync 托管的（没有 /health）则按本地模式直接进入界面，只没有同步
async function autoConnect(message = '') {
    const result = await Sync.connect({ reason: '启动' });
    if (result.ok) {
        renderApp();
        return;
    }
    if (result.localOnly) {
        console.log(`[INFO] [App] 本页不由 EsprinSync 托管，按本地模式运行 (detail=${result.error})`);
        renderSyncIndicator();
        // 设置页可能已经先画过（上一轮停在设置页）：重绘一次，把服务器与同步那一节去掉
        if (document.getElementById('settings-content')) renderSettingsView();
        return;
    }
    if (!result.needAuth) {
        console.warn(`[WARN] [App] 连接服务端失败，已停在连接层 (detail=${result.error})`);
    }
    showConnectGate(message || result.error || '');
    renderSyncIndicator();
}

async function boot() {
    loadConfig();
    await FileStore.open();
    await loadItemsFromStore();
    await loadAiChatsFromStore();

    applyTheme();
    applyThemeStyle();
    applyAccentColor();
    applyUiScale();
    document.documentElement.dataset.radius = State.cornerRadius;
    document.documentElement.dataset.brandColor = State.brandColor;
    applySidebarCollapsed(false);

    initCustomSelects();
    initUiMode();
    initAiPanel();
    bindEvents();
    bindConnectGate();

    const sortSelect = document.getElementById('select-sort');
    sortSelect.value = State.sortBy;

    // 同步层先就位：本地副本、待推送队列与游标都要在改动数据之前按账户装载好
    Sync.init();
    const purged = purgeExpiredTrashItems();
    renderApp();

    if (purged > 0) showToast(`已自动清理 ${purged} 条超过 ${State.trashRetentionDays} 天的废纸篓内容`);
    console.log(`[INFO] [App] 网页版已就绪 (cache=${FileStore.mode}, notes=${State.notes.length}, todos=${State.todos.length}, localScope=${FileStore.scope || 'legacy'})`);
    registerServiceWorker();

    // 首屏先用手上的本地副本渲染，随后接上托管本页的服务端
    await autoConnect();
}

window.addEventListener('DOMContentLoaded', () => {
    boot().catch((error) => {
        console.error('[ERROR] [App] 启动失败: ' + (error && error.message));
        showToast('启动失败：本地存储不可用，请检查浏览器隐私设置');
    });
});
