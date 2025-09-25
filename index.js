const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});

const db = new sqlite3.Database(':memory:', (err) => {
  if (err) console.error('SQLite error:', err);
  db.run(`CREATE TABLE IF NOT EXISTS user_usage (
    user_id TEXT PRIMARY KEY,
    search_count INTEGER DEFAULT 0,
    last_reset TEXT NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS transcript_cache (
    video_id TEXT PRIMARY KEY,
    captions TEXT,
    expires INTEGER
  )`);
});

async function fetchTranscript(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}&key=${process.env.YOUTUBE_API_KEY}`;
  const response = await fetch(url);
  const data = await response.json();
  if (!data.items || data.items.length === 0) {
    throw new Error('No captions available for this video');
  }
  const captionId = data.items[0].id;
  const captionUrl = `https://www.googleapis.com/youtube/v3/captions/${captionId}?key=${process.env.YOUTUBE_API_KEY}&tfmt=srt`;
  const captionResponse = await fetch(captionUrl);
  return await captionResponse.text();
}

function findKeywordTimestamps(captions, keyword) {
  const lines = captions.split('\n\n');
  const results = [];
  for (const block of lines) {
    const [index, time, ...textLines] = block.split('\n');
    if (!time || !textLines) continue;
    const text = textLines.join(' ').toLowerCase();
    if (text.includes(keyword.toLowerCase())) {
      const [startTime] = time.split(' --> ');
      results.push({ timestamp: startTime, text });
    }
  }
  return results;
}

app.post('/api/search', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Unauthorized' });
    const token = authHeader.split(' ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    const userId = decoded.uid;

    const today = new Date().toISOString().split('T')[0];
    db.get('SELECT search_count, last_reset FROM user_usage WHERE user_id = ?', [userId], async (err, usage) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!usage || usage.last_reset !== today) {
        db.run('INSERT OR REPLACE INTO user_usage (user_id, search_count, last_reset) VALUES (?, 0, ?)', [userId, today]);
        usage = { search_count: 0, last_reset: today };
      }
      if (usage.search_count >= 3) return res.status(429).json({ error: 'Daily search limit (3 searches) reached' });

      const { videoUrl, keyword } = req.body;
      const videoId = videoUrl.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]+)/)?.[1];
      if (!videoId || !keyword) return res.status(400).json({ error: 'Invalid video URL or keyword' });

      let captions;
      db.get('SELECT captions FROM transcript_cache WHERE video_id = ? AND expires > ?', [videoId, Date.now()], async (err, cached) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (cached) {
          captions = cached.captions;
        } else {
          try {
            captions = await fetchTranscript(videoId);
            db.run('INSERT OR REPLACE INTO transcript_cache (video_id, captions, expires) VALUES (?, ?, ?)', [videoId, captions, Date.now() + 24 * 60 * 60 * 1000]);
          } catch (error) {
            return res.status(400).json({ error: error.message });
          }
        }
        const timestamps = findKeywordTimestamps(captions, keyword);
        db.run('UPDATE user_usage SET search_count = search_count + 1 WHERE user_id = ?', [userId]);
        res.status(200).json({ timestamps });
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Server error: ' + error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
