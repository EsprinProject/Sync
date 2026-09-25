/* EsprinNemo 网页版的 Service Worker：把界面外壳装进缓存，断网也能打开这一页。

   只接本源的静态资源：/sync（同步接口）、/admin（管理后台）与 /health 一律放给网络 ——
   同步与鉴权不能经过缓存。导航请求走网络优先（打开页面先取新的，断网才回退到缓存），
   其余外壳资源走 stale-while-revalidate（先拿缓存立即出画面，后台再更新一份）。

   界面的样式与脚本有增删后把 CACHE_NAME 的版本号 +1，旧缓存由 activate 清掉。
   注册入口在 scripts/app.js 的 registerServiceWorker：局域网 http 下浏览器不给 Service Worker，
   那种环境里这一份不会生效。 */

const CACHE_NAME = 'esprinnemo-web-v2';
const HOME_URL = '/';

const SHELL_ASSETS = [
    HOME_URL,
    '/index.html',
    '/manifest.webmanifest',
    '/favicon.png',
    '/icon-180.png',
    '/icon-192.png',
    '/icon-512.png',
    '/icon-512-maskable.png',
    '/styles/tokens.css',
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
    // 跨域请求（字体 CDN）不接：离线时交给系统字体栈兜底
    if (url.origin !== self.location.origin || isBypassed(url)) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }
    event.respondWith(staleWhileRevalidate(request));
});
