// Een nagebootste Whisper-worker (dezelfde routes en antwoorden als de echte
// Plaud Whisper Worker met de audio-uitbreiding), plus een podcastfeed met
// een paar afleveringen op localhost. Voor de tests, en om de webUI zonder de
// echte worker te bekijken:  node test/nep-worker.mjs 8765

import http from 'node:http';

export const TOKEN = 'geheim-token';
const ID = (n) => n.repeat(32).slice(0, 32);
export const STEM = { voorzitter: ID('c3'), postma: ID('d4'), wethouder: ID('f6') };

// Een toon, als "audiobestand" voor de download (ffmpeg maakt er een mp3 van).
export function wav(seconden = 3, hz = 8000) {
  const n = seconden * hz;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(hz, 24); buf.writeUInt32LE(hz * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / hz) * 800), 44 + i * 2);
  return buf;
}

export const TRANSCRIPT = [
  { start: 2, end: 14, text: ' Dan gaan we naar agendapunt 6, de programmabegroting 2027.', speaker: 'Voorzitter Bos', speaker_id: STEM.voorzitter },
  { start: 15, end: 38, text: ' Wij maken ons zorgen over de huisartsenpost in Drachten. Bel gerust 06-12345678 als u vragen heeft.', speaker: 'Anke Postma', speaker_id: STEM.postma },
  { start: 39, end: 44, text: ' Dan is nu het woord aan wethouder Kramer.', speaker: 'SPEAKER_01' },
  { start: 45, end: 70, text: ' Het college praat met de zorgverzekeraar over de nachtdienst in Drachten.', speaker: 'SPEAKER_02', speaker_id: STEM.wethouder },
];
const NAMEN = [['Drachten', 'location'], ['Anke Postma', 'person'], ['wethouder Kramer', 'person'], ['programmabegroting 2027', 'other']];

export function nepWorker({ token = TOKEN } = {}) {
  const staat = { verzoeken: [], namen: new Map([[STEM.voorzitter, 'Voorzitter Bos'], [STEM.postma, 'Anke Postma']]), gpuBezig: false, entiteitFout: 0, transcriptieFout: null };
  const json = (res, data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const server = http.createServer(async (req, res) => {
    const delen = [];
    for await (const stuk of req) delen.push(stuk);
    const ruw = Buffer.concat(delen);
    const url = new URL(req.url, 'http://x');
    staat.verzoeken.push(`${req.method} ${url.pathname}`);
    if (url.pathname === '/health') return json(res, { status: 'ok', model: 'large-v3', device: 'cuda', inference_phase: staat.gpuBezig ? 'transcribing' : null, diarization_available: true });
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, { detail: 'Invalid worker token' }, 401);
    if (req.method === 'POST' && url.pathname === '/v1/media/transcriptions') {
      const tekst = ruw.toString('latin1');
      staat.laatsteUpload = { bytes: ruw.length, mp3: /filename="audio\.mp3"/.test(tekst) && /Content-Type: audio\/mpeg/i.test(tekst), diarize: /name="diarize"\r\n\r\ntrue/.test(tekst), opname: /name="recording_id"\r\n\r\n([^\r]+)/.exec(tekst)?.[1] };
      if (staat.transcriptieFout) return json(res, { detail: staat.transcriptieFout.detail }, staat.transcriptieFout.status);
      const segments = TRANSCRIPT.map((s) => ({ ...s, ...(s.speaker_id && staat.namen.has(s.speaker_id) ? { speaker: staat.namen.get(s.speaker_id) } : {}) }));
      return json(res, { text: segments.map((s) => s.text.trim()).join(' '), language: 'nl', duration: 70, segments, diarization_model: 'pyannote', diarization_error: null });
    }
    if (req.method === 'POST' && url.pathname === '/v1/entities') {
      // Een deel dat "te moeilijk" is: de echte worker geeft dan een 500.
      if (staat.entiteitFout > 0) {
        staat.entiteitFout--;
        return json(res, { detail: 'Ollama gaf geen geldige JSON' }, 500);
      }
      const { text } = JSON.parse(ruw);
      return json(res, { entities: NAMEN.filter(([n]) => text.toLowerCase().includes(n.toLowerCase())).map(([name, type]) => ({ name, type })), model: 'qwen3.5:9b' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/phone-context') {
      const { text } = JSON.parse(ruw);
      const bewijs = /Bel gerust \[DOELNUMMER\]/.exec(text)?.[0];
      return json(res, { subject_type: 'person', relation: 'third_party_reference', label: 'Anke Postma', description: 'Raadslid', confidence: 72, evidence: bewijs || '', model: 'qwen3.5:9b' });
    }
    if (url.pathname === '/v1/speakers' && req.method === 'GET') {
      return json(res, [...new Set(Object.values(STEM))].map((id) => ({ profile_id: id, name: staat.namen.get(id) || '', display_name: staat.namen.get(id) || 'Onbekende stem', suggested_name: id === STEM.wethouder ? 'wethouder Kramer' : '', sample_available: true })));
    }
    const m = /^\/v1\/speakers\/([0-9a-f]{32})(\/sample)?$/.exec(url.pathname);
    if (m && req.method === 'PATCH') {
      const { name } = JSON.parse(ruw);
      staat.namen.set(m[1], name);
      return json(res, { profile_id: m[1], name, display_name: name });
    }
    if (m && m[2]) {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav(1));
    }
    return json(res, { detail: 'Not Found' }, 404);
  });
  return new Promise((klaar) => server.listen(Number(process.env.NEP_POORT) || 0, '127.0.0.1', () => klaar({ server, staat, url: `http://127.0.0.1:${server.address().port}` })));
}

// Een podcastfeed met `n` afleveringen, nieuwste eerst; de audio staat ernaast.
export function nepPodcast({ n = 5 } = {}) {
  const staat = { downloads: 0 };
  const server = http.createServer((req, res) => {
    const basis = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/feed.xml') {
      const items = Array.from({ length: n }, (_, i) => {
        const datum = new Date(Date.now() - i * 86400000).toUTCString();
        return `<item><title>Aflevering ${n - i}: Drachten en de N31</title><guid isPermaLink="false">afl-${n - i}</guid><pubDate>${datum}</pubDate>
          <link>${basis}/afl/${n - i}</link><itunes:duration>01:10</itunes:duration>
          <enclosure url="${basis}/audio/${n - i}.wav" type="audio/x-wav" length="1"/></item>`;
      }).join('');
      res.writeHead(200, { 'Content-Type': 'application/rss+xml' });
      return res.end(`<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>De Regiopodcast</title><itunes:image href="${basis}/hoes.jpg"/>${items}</channel></rss>`);
    }
    if (req.url.startsWith('/audio/')) {
      staat.downloads++;
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav(2));
    }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((klaar) => server.listen(0, '127.0.0.1', () => klaar({ server, staat, url: `http://127.0.0.1:${server.address().port}/feed.xml` })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.env.NEP_POORT = process.argv[2] || '8765';
  const w = await nepWorker();
  const p = await nepPodcast();
  console.log(`Nep-worker op ${w.url} (token ${TOKEN}); podcastfeed op ${p.url}`);
}
