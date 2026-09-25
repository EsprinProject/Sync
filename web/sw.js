/* EsprinNemo 网页版的 Service Worker：把界面外壳（含随包分发的字体）装进缓存，断网也能打开这一页。

   清单里的地址一律相对：缓存键按注册作用域解析，挂根路径与子路径都成立。
   /sync（同步接口）、/admin（管理后台）与 /health 一律放给网络 ——
   同步与鉴权不能经过缓存。导航请求走网络优先（打开页面先取新的，断网才回退到缓存），
   其余外壳资源走 stale-while-revalidate（先拿缓存立即出画面，后台再更新一份）。

   界面的样式、脚本或字体有增删后把 CACHE_NAME 的版本号 +1，旧缓存由 activate 清掉。
   注册入口在 scripts/app.js 的 registerServiceWorker：file:// 与局域网 http 下浏览器不给
   Service Worker，那种环境里这一份不会生效（界面本身不依赖它）。 */

const CACHE_NAME = 'esprinnemo-web-v6';
// 首页地址按注册作用域取：根路径托管时是「/」，子路径托管时是「/xxx/」。
// 用 sw.js 自己的地址推（注册作用域就是它所在的目录）——self.registration 在脚本求值期
// 不一定就位，取不到会让整个 Service Worker 装不上
const HOME_URL = new URL('./', self.location).pathname;

const SHELL_ASSETS = [
    HOME_URL,
    'index.html',
    'manifest.webmanifest',
    'favicon.png',
    'icon-180.png',
    'icon-192.png',
    'icon-512.png',
    'icon-512-maskable.png',
    'fonts/material-symbols/material-symbols-rounded.woff2',
    'fonts/Mohave/Mohave-VariableFont_wght.ttf',
    'styles/tokens.css',
    '/styles/base.css',
    '/styles/sidebar.css',
    '/styles/editor.css',
    '/styles/overlays.css',
    '/styles/settings.css',
    '/styles/ai.css',
    '/styles/secret.css',
    '/styles/alom.css',
    '/styles/radius.css',
    '/styles/mode.css',
    '/styles/motion.css',
    '/styles/web.css',
    '/styles/mobile.css',
    '/scripts/boot.js',
    '/scripts/markdown.js',
    '/scripts/store.js',
    '/scripts/ui.js',
    '/scripts/sync.js',
    '/scripts/notes.js',
    '/scripts/render.js',
    '/scripts/mode.js',
    '/scripts/ai.js',
    '/scripts/secret.js',
    '/scripts/settings.js',
    '/scripts/app.js'
];

// 接口与后台不进缓存：命中前缀即原样交给网络
const BYPASS_PATHS = ['/sync', '/admin', '/health'];

function isBypassed(url) {
    return BYPASS_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(path + '/'));
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // 逐个装：某一个文件缺失不该让整个 Service Worker 装不上（装不上连离线都无从谈起）
        await Promise.all(SHELL_ASSETS.map((path) => cache.add(path).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        // 首页随每次导航刷新缓存：服务端给的是 no-store，断网时得有一份自己留的
        if (response.ok) cache.put(HOME_URL, response.clone());
        return response;
    } catch (error) {
        return (await cache.match(request)) || (await cache.match(HOME_URL)) || Response.error();
    }
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    const fresh = fetch(request)
        .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
        })
        .catch(() => null);
    return cached || (await fresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    // 跨域请求（AI 服务端点等）一律放给网络，不进缓存
    if (url.origin !== self.location.origin || isBypassed(url)) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }
    event.respondWith(staleWhileRevalidate(request));
});
