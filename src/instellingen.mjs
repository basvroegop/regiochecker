// De instellingen die een beheerder in de webUI wijzigt: controle-interval,
// standaardschema voor de weekmail van nieuwe gebruikers, SMTP, samenvatting
// (Claude of Ollama) en de Whisper-worker voor audio en video. Geheimen
// (SMTP-wachtwoord, Claude-sleutel, worker-token) gaan nooit terug naar de
// browser; alleen of ze zijn ingevuld.

import { samenvattingAanbieder } from './samenvatting.mjs';
import { InvoerFout } from './gebruikers.mjs';

export function publiekeInstellingen(opslag) {
  const { smtp, claude, audio, ...rest } = opslag.instellingen;
  const { workerToken, ...audioRest } = audio;
  return {
    ...rest,
    audio: { ...audioRest, heeftToken: Boolean(workerToken || process.env.WORKER_TOKEN), tokenUitOmgeving: !workerToken && Boolean(process.env.WORKER_TOKEN) },
    smtp: { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from, heeftWachtwoord: Boolean(smtp.pass) },
    claude: {
      model: claude.model,
      heeftSleutel: Boolean(claude.apiKey || process.env.ANTHROPIC_API_KEY),
      sleutelUitOmgeving: !claude.apiKey && Boolean(process.env.ANTHROPIC_API_KEY),
    },
    // ollama bevat geen geheimen en gaat via ...rest mee.
    tailnetProxy: Boolean(process.env.REGIOCHECKER_TAILNET_PROXY),
    samenvatting: samenvattingAanbieder(opslag),
  };
}

const URL_ZONDER_PAD = /^https?:\/\/[^/\s]+$/;

export function werkInstellingenBij(opslag, invoer) {
  const i = opslag.instellingen;
  if (invoer.mailTijd !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(invoer.mailTijd)) throw new InvoerFout('Tijd moet de vorm UU:MM hebben, bijvoorbeeld 07:00');
    i.mailTijd = invoer.mailTijd;
  }
  if (invoer.mailDagen !== undefined) {
    if (!Array.isArray(invoer.mailDagen) || invoer.mailDagen.some((d) => ![1, 2, 3, 4, 5, 6, 7].includes(d))) throw new InvoerFout('Ongeldige maildagen');
    i.mailDagen = [...new Set(invoer.mailDagen)].sort();
  }
  if (invoer.mailBijNiets !== undefined) i.mailBijNiets = Boolean(invoer.mailBijNiets);
  if (invoer.controleIntervalMinuten !== undefined) {
    const n = Number(invoer.controleIntervalMinuten);
    if (!(n >= 15 && n <= 1440)) throw new InvoerFout('Controle-interval moet tussen 15 en 1440 minuten liggen');
    i.controleIntervalMinuten = n;
  }
  if (invoer.smtp) {
    const s = invoer.smtp;
    for (const veld of ['host', 'user', 'from']) if (s[veld] !== undefined) i.smtp[veld] = String(s[veld]).trim();
    if (s.port !== undefined) i.smtp.port = Number(s.port) || 587;
    if (s.secure !== undefined) i.smtp.secure = Boolean(s.secure);
    // Een leeg wachtwoordveld betekent "niet wijzigen"; wissen gaat expliciet.
    if (s.pass) i.smtp.pass = String(s.pass);
    if (s.wisWachtwoord) i.smtp.pass = '';
  }
  if (invoer.claude) {
    if (invoer.claude.apiKey) i.claude.apiKey = String(invoer.claude.apiKey).trim();
    if (invoer.claude.wisSleutel) i.claude.apiKey = '';
    if (invoer.claude.model) i.claude.model = String(invoer.claude.model).trim();
  }
  if (invoer.samenvattingVia !== undefined) {
    if (!['claude', 'ollama', 'uit'].includes(invoer.samenvattingVia)) throw new InvoerFout('Kies Claude, Ollama of uit');
    i.samenvattingVia = invoer.samenvattingVia;
  }
  if (invoer.ollama) {
    const o = invoer.ollama;
    if (o.url !== undefined) {
      const url = String(o.url).trim().replace(/\/+$/, '');
      if (url && !URL_ZONDER_PAD.test(url)) throw new InvoerFout('Ollama-URL moet de vorm http://machine:11434 hebben, zonder pad');
      i.ollama.url = url;
    }
    if (o.model !== undefined) i.ollama.model = String(o.model).trim();
    if (o.maxContext !== undefined) {
      const n = Number(o.maxContext);
      if (!(n >= 4096 && n <= 262144)) throw new InvoerFout('Contextvenster moet tussen 4096 en 262144 tokens liggen');
      i.ollama.maxContext = n;
    }
  }
  if (invoer.audio) {
    const a = invoer.audio;
    if (a.workerUrl !== undefined) {
      const url = String(a.workerUrl).trim().replace(/\/+$/, '');
      if (url && !URL_ZONDER_PAD.test(url)) throw new InvoerFout('Het adres van de worker moet de vorm http://machine:8765 hebben, zonder pad');
      i.audio.workerUrl = url;
    }
    // Een leeg tokenveld betekent "niet wijzigen"; wissen gaat expliciet.
    if (a.workerToken) i.audio.workerToken = String(a.workerToken).trim();
    if (a.wisToken) i.audio.workerToken = '';
    if (a.viaTailnet !== undefined) i.audio.viaTailnet = Boolean(a.viaTailnet);
    if (a.bewaarAudio !== undefined) {
      if (!['vergaderingen', 'alles', 'niets'].includes(a.bewaarAudio)) throw new InvoerFout('Kies welke audio bewaard blijft');
      i.audio.bewaarAudio = a.bewaarAudio;
    }
    if (a.bewaarDagen !== undefined) {
      const n = Number(a.bewaarDagen);
      if (!(n >= 1 && n <= 3650)) throw new InvoerFout('Bewaartermijn moet tussen 1 en 3650 dagen liggen');
      i.audio.bewaarDagen = n;
    }
  }
  opslag.bewaar('instellingen');
}
