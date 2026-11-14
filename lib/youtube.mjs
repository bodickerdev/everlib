// Vídeos de una lista de reproducción de YouTube, leídos de su feed RSS público (sin clave de API).
// El feed no permite peticiones desde el navegador (CORS), por eso se consulta desde el servidor.
export const PLAYLIST_ID = 'PLUk20NJjRO-w';
const CACHE_MS = 60 * 60 * 1000;

let cache = { at: 0, videos: null };

const decode = (s) =>
  s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);

export async function latestVideos() {
  if (cache.videos && Date.now() - cache.at < CACHE_MS) return cache.videos;
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${PLAYLIST_ID}`);
  if (!res.ok) throw new Error(`YouTube ${res.status}`);
  const xml = await res.text();
  // Todos los del feed (YouTube incluye como mucho los 15 últimos), del más nuevo al más antiguo
  const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      id: e.match(/<yt:videoId>([^<]+)/)?.[1],
      title: decode(e.match(/<title>([^<]*)/)?.[1] ?? ''),
      published: e.match(/<published>([^<]+)/)?.[1],
    }))
    .filter((v) => v.id)
    .sort((a, b) => (b.published ?? '').localeCompare(a.published ?? ''));
  cache = { at: Date.now(), videos };
  return videos;
}
