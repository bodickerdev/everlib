// Función de Vercel: /api/videos (misma respuesta que la ruta de server.mjs)
import { latestVideos } from '../lib/youtube.mjs';

export default async function handler(req, res) {
  try {
    const videos = await latestVideos();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.status(200).json({ videos });
  } catch {
    res.status(502).json({ videos: [] });
  }
}
