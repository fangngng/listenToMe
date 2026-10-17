// PWA Service Worker：外壳资源 stale-while-revalidate（先回缓存、后台更新）；API 与音频上传绝不缓存
const V = 'ltm-v5'
const ASSETS = ['./', './app.js', './samples.js', './style.css', './pcm-worklet.js', './manifest.webmanifest', './icon-192.png', './icon-512.png']

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return
  e.respondWith(
    caches.match(e.request).then(hit => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok) caches.open(V).then(c => c.put(e.request, res.clone()))
        return res
      }).catch(() => hit)
      return hit || fresh
    })
  )
})
