// 3300번 실시간 위치 중계 서버 (Cloudflare Worker)
// - 공공데이터포털 인증키를 서버에만 보관 (GitHub에 노출되지 않음)
// - 브라우저 차단(CORS) 해결
// - 응답을 캐시해서 API 호출 횟수 절약
//
// 환경변수 (Cloudflare > Worker > Settings > Variables and Secrets)
//   SERVICE_KEY    (필수, Secret)  공공데이터포털 인증키 — "Decoding" 키 권장
//   ROUTE_ID       (선택)          노선 ID를 직접 지정. 비우면 "3300"을 자동 검색
//   ALLOWED_ORIGIN (선택)          예: https://아이디.github.io  (비우면 모든 곳 허용)
//
// 주소
//   /bus     → 노선 정보 + 정류장 목록 + 운행 중 버스 위치
//   /routes  → "3300" 검색 결과 원본 (노선 ID 확인용)

const BASE = "https://apis.data.go.kr/6410000";
const ROUTE_NAME = "3300";
const BUS_TTL = 15;          // 버스 위치 캐시(초)
const STATIC_TTL = 86400;    // 노선·정류장 캐시(초)

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (!env.SERVICE_KEY) throw new Error("SERVICE_KEY 환경변수가 설정되지 않았습니다");
      const api = (path, params) => callApi(path, params, env.SERVICE_KEY);

      if (url.pathname === "/routes") {
        const list = await api("/busrouteservice/v2/getBusRouteListv2", { keyword: ROUTE_NAME });
        return json({ ok: true, routes: toArr(list.busRouteList) }, cors);
      }

      if (url.pathname === "/bus") {
        const route = await cached(ctx, "route-" + (env.ROUTE_ID || ROUTE_NAME), STATIC_TTL,
          () => resolveRoute(api, env.ROUTE_ID));

        const stations = await cached(ctx, "stations-" + route.id, STATIC_TTL, async () => {
          const b = await api("/busrouteservice/v2/getBusRouteStationListv2", { routeId: route.id });
          return toArr(b.busRouteStationList).map(s => ({
            seq: +s.stationSeq,
            id: String(s.stationId),
            name: s.stationName,
            turn: s.turnYn === "Y",
          })).sort((a, b) => a.seq - b.seq);
        });

        const live = await cached(ctx, "bus-" + route.id, BUS_TTL, async () => {
          const b = await api("/buslocationservice/v2/getBusLocationListv2", { routeId: route.id });
          return toArr(b.busLocationList).map(v => ({
            plate: v.plateNo,
            seq: +v.stationSeq,
            stationId: String(v.stationId),
            seats: v.remainSeatCnt == null ? -1 : +v.remainSeatCnt,
            crowded: v.crowded == null ? 0 : +v.crowded,
          }));
        });

        const byId = Object.fromEntries(stations.map(s => [s.id, s.name]));
        const bySeq = Object.fromEntries(stations.map(s => [s.seq, s.name]));
        const buses = live.map(b => ({ ...b, stationName: byId[b.stationId] || bySeq[b.seq] || "" }));
        const turn = stations.find(s => s.turn);

        return json({
          ok: true,
          queryTime: new Date().toISOString(),
          route,
          turnSeq: turn ? turn.seq : null,
          stations: stations.map(({ seq, name, turn }) => ({ seq, name, turn })),
          buses,
        }, cors);
      }

      return json({ ok: true, usage: ["/bus", "/routes"] }, cors);
    } catch (e) {
      return json({ ok: false, error: e.message }, cors, 502);
    }
  },
};

// ===== 노선 ID 찾기 =====
async function resolveRoute(api, fixedId) {
  if (fixedId) return { id: String(fixedId), name: ROUTE_NAME, region: "" };
  const b = await api("/busrouteservice/v2/getBusRouteListv2", { keyword: ROUTE_NAME });
  const all = toArr(b.busRouteList);
  const exact = all.filter(r => String(r.routeName).trim() === ROUTE_NAME);
  if (!exact.length) throw new Error("3300번 노선을 찾지 못했습니다. /routes 결과를 확인해 ROUTE_ID를 지정하세요");
  const pick = exact.find(r => String(r.regionName || "").includes("고양")) || exact[0];
  return { id: String(pick.routeId), name: String(pick.routeName), region: pick.regionName || "" };
}

// ===== 공공데이터 API 호출 =====
async function callApi(path, params, rawKey) {
  // 인코딩 키를 넣어도 동작하도록 한 번 풀어줌
  let key = rawKey.trim();
  if (key.includes("%")) { try { key = decodeURIComponent(key); } catch (_) {} }

  const qs = new URLSearchParams({ serviceKey: key, format: "json", ...params });
  const res = await fetch(BASE + path + "?" + qs.toString(), { headers: { Accept: "application/json" } });
  const text = await res.text();

  let j;
  try { j = JSON.parse(text); }
  catch (_) {
    // 키 오류 등은 XML로 옴
    const msg = (text.match(/<returnAuthMsg>([^<]+)/) || text.match(/<errMsg>([^<]+)/) || [])[1];
    throw new Error("API 오류: " + (msg || text.slice(0, 120)));
  }

  const root = j.response || j;
  const head = root.msgHeader || {};
  const code = Number(head.resultCode);
  if (code === 4) return {};                       // 결과 없음 (운행 중인 버스 없음 등)
  if (head.resultCode != null && code !== 0) throw new Error("API 오류: " + (head.resultMessage || code));
  return root.msgBody || {};
}

// ===== 유틸 =====
const toArr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function cached(ctx, name, ttl, fn) {
  const cache = caches.default;
  const key = new Request("https://cache.bus3300/" + encodeURIComponent(name));
  const hit = await cache.match(key);
  if (hit) return hit.json();
  const data = await fn();
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=" + ttl },
  })));
  return data;
}
