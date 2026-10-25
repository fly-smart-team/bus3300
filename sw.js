// 공항리무진 3300번 — 서비스 워커
// - 앱 설치(PWA) 조건 충족
// - 인터넷이 끊겨도 마지막으로 본 화면·시간표 표시
// - 화면 파일은 "네트워크 먼저": 수정하면 다음 실행에 바로 반영
// 파일 구성을 바꾸면 VERSION 숫자를 올리세요.
const VERSION = "v1";
const CACHE = "bus3300-" + VERSION;
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg",
  "./icon-192.png", "./icon-512.png", "./icon-maskable-192.png", "./icon-maskable-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith("bus3300-") && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  const url = new URL(req.url);
  // 실시간 버스 위치(Worker) 등 다른 사이트 요청은 건드리지 않음
  if (req.method !== "GET" || url.origin !== self.location.origin) return;

  // 페이지: 네트워크 먼저 → 실패하면 저장본
  if (req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname.endsWith("/")){
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put("./index.html", copy));
        return res;
      }).catch(() => caches.match("./index.html").then(r => r || caches.match("./")))
    );
    return;
  }
  // 아이콘 등: 저장본 먼저 → 없으면 네트워크
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy));
    return res;
  })));
});
