/* 首屏外观引导：在样式表生效前把主题、主题风格、圆角、应用名颜色、侧边栏形态与界面布局
   写成 <html> 上的类名 / 属性，因此不会先画一遍默认外观再切换。
   与桌面版 src/renderer/boot.js 同一职责，只是配置来源换成浏览器的 localStorage。

   本文件在 <head> 里同步执行，只读配置、不碰任何 DOM 元素；
   配置里缺失或非法的取值一律回退到默认值，与 scripts/store.js 的 loadConfig 保持一致。 */

const WEB_CONFIG_KEY = 'esprin.nemo.config';

// 与桌面版一致的类名常量（scripts/mode.js、scripts/app.js 共用）
const MODERN_LAYOUT_CLASS = 'modern-layout';
const TABS_DISABLED_CLASS = 'tabs-disabled';
const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';
const LIGHT_THEME_CLASS = 'light';
// 与 styles/motion.css 的 --motion-crossfade 一致；多留 60ms 再摘类，避免过渡被提前掐断
const APPEARANCE_FADE_MS = 250;

const THEME_VALUES = ['system', 'dark', 'light'];
const THEME_STYLE_VALUES = ['default', 'alom'];
const BRAND_COLOR_VALUES = ['brand', 'mono', 'accent'];
const CORNER_RADIUS_VALUES = ['square', 'slight', 'default', 'large'];
const UI_MODE_VALUES = ['classic', 'modern'];
const AI_SCOPE_VALUES = ['current', 'all', 'none'];

/* 界面尺寸（缩放比例）：浏览器里没有窗口缩放，落在根元素的 CSS 缩放（zoom）上，1 为 100%。
   取值范围 50%~200%，与桌面版一致。取值规则写在引导脚本里：本文件先于页面其余脚本执行，
   首屏就能按最终比例排版；normalizeUiScale 也被设置页与配置读写复用。 */
const UI_SCALE_MIN = 0.5;
const UI_SCALE_MAX = 2;
const UI_SCALE_DEFAULT = 1;

function normalizeUiScale(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return UI_SCALE_DEFAULT;
    const clamped = Math.min(Math.max(num, UI_SCALE_MIN), UI_SCALE_MAX);
    return Math.round(clamped * 100) / 100;
}

function readStoredConfig() {
    try {
        const parsed = JSON.parse(localStorage.getItem(WEB_CONFIG_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

const BOOT_CONFIG = readStoredConfig();

// 现代布局先后叫过「Line 模式」「无Tab模式」与「极简模式」，旧配置里存的仍是 line / notab / minimal
function normalizeUiMode(value) {
    if (value === 'line' || value === 'notab' || value === 'minimal') return 'modern';
    if (value === 'standard') return 'classic';
    return UI_MODE_VALUES.includes(value) ? value : 'modern';
}

function isModernLayout() {
    return State.uiMode === 'modern';
}

// 窄屏判定：与 styles/web.css 的断点、scripts/app.js 的 narrowScreenQuery 一致。
// 这里在样式表生效前跑一次，只做静态判断，转屏之后由 scripts/app.js 接手
function bootNarrowScreen() {
    try {
        return window.matchMedia('(max-width: 860px)').matches;
    } catch (error) {
        return false;
    }
}

/* ---------------- 主题色的亮度换算 ----------------
   强调色底面上的文字色按相对亮度取黑或白（浅色主题色上不会出现白字看不清），
   与 scripts/app.js 的 accentForeground 同一套算法 */

function normalizeAccentHex(value) {
    const text = String(value || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) return '';
    return text.toUpperCase();
}

function bootAccentForeground(hex) {
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    const r = channel(parseInt(hex.slice(1, 3), 16) / 255);
    const g = channel(parseInt(hex.slice(3, 5), 16) / 255);
    const b = channel(parseInt(hex.slice(5, 7), 16) / 255);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

function bootResolvedTheme() {
    const theme = THEME_VALUES.includes(BOOT_CONFIG.theme) ? BOOT_CONFIG.theme : 'system';
    if (theme !== 'system') return theme;
    try {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (error) {
        return 'dark';
    }
}

(function applyBootAppearance() {
    const root = document.documentElement;
    const stored = BOOT_CONFIG;

    // 明暗主题
    root.classList.toggle(LIGHT_THEME_CLASS, bootResolvedTheme() === 'light');

    // 主题风格（默认风格写 default：alom.css 只匹配 alom，写什么都不会误触发）
    root.dataset.themeStyle = THEME_STYLE_VALUES.includes(stored.themeStyle) ? stored.themeStyle : 'default';

    // 圆角尺度
    root.dataset.radius = CORNER_RADIUS_VALUES.includes(stored.cornerRadius) ? stored.cornerRadius : 'default';

    // 应用名颜色
    root.dataset.brandColor = BRAND_COLOR_VALUES.includes(stored.brandColor) ? stored.brandColor : 'brand';

    // 界面布局：现代（默认）不排标题栏；「禁用标签页」只属于现代布局
    const uiMode = normalizeUiMode(stored.uiMode);
    root.classList.toggle(MODERN_LAYOUT_CLASS, uiMode === 'modern');
    root.classList.toggle(TABS_DISABLED_CLASS, uiMode === 'modern' && !!stored.tabsDisabled);

    // 侧边栏收起态：首屏按收起态绘制，不出现展开后补播动画。
    // 窄屏下侧边栏整条收起（见 styles/web.css），这一对形态不适用
    root.classList.toggle(SIDEBAR_COLLAPSED_CLASS, !!stored.sidebarCollapsed && !bootNarrowScreen());

    // 界面尺寸：无论配置里有没有这一项都显式写一次，免得上一轮遗留的比例盖过配置
    root.style.zoom = String(normalizeUiScale(stored.uiScale));

    // 主题色：写在内联样式上，高于 tokens.css 里的默认值
    const accent = normalizeAccentHex(stored.accentColor);
    if (accent) {
        const r = parseInt(accent.slice(1, 3), 16);
        const g = parseInt(accent.slice(3, 5), 16);
        const b = parseInt(accent.slice(5, 7), 16);
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.15)`);
        root.style.setProperty('--accent-fg', bootAccentForeground(accent));
    }
})();
