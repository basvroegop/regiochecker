// Gebruikers: journalisten en beheerders. Inloggen gaat via Authelia; Traefik
// stuurt daarna Remote-User, Remote-Email en Remote-Name mee. We herkennen
// iemand aan de inlognaam, en anders aan het e-mailadres. Zo werkt een
// uitnodiging: de beheerder vult het e-mailadres in, en bij de eerste keer
// inloggen koppelen we de inlognaam eraan.
//
// Bij een verse installatie (nog nooit een beheerder) wordt de eerste die
// inlogt beheerder; dat gaat daarna nooit meer open (status.beheerGestart).
// Daarna nodigt alleen een beheerder anderen uit; wie niet is
// uitgenodigd, krijgt een nette weigering (Authelia laat diegene wel door, de
// Regiochecker niet). Een gebruiker zonder inlognaam kan alleen mail krijgen.
//
// Per gebruiker: rol (journalist/admin), titel (LC/DVHN, bepaalt de huisstijl),
// gevolgde regio's en de weekmail (aan, dagen, tijd, ook als er niets is).

import { randomUUID } from 'node:crypto';

export const ROLLEN = ['journalist', 'admin'];
export const TITELS = ['LC', 'DVHN'];
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;
const TIJD = /^([01]\d|2[0-3]):[0-5]\d$/;
const ACTIEF_BIJWERKEN_MS = 5 * 60000;

export function standaardWeekmail(instellingen) {
  return {
    aan: true,
    dagen: [...(instellingen.mailDagen || [1])],
    tijd: instellingen.mailTijd || '07:00',
    ookLeeg: Boolean(instellingen.mailBijNiets),
  };
}

export function nieuweGebruiker(instellingen, velden = {}) {
  const email = String(velden.email || '').trim().toLowerCase();
  return {
    id: velden.id || randomUUID(),
    login: velden.login || null,
    naam: String(velden.naam || '').trim(),
    email,
    rol: velden.rol || 'journalist',
    titel: velden.titel || (/dvhn/i.test(email) ? 'DVHN' : 'LC'),
    regios: velden.regios || [],
    weekmail: { ...standaardWeekmail(instellingen), ...velden.weekmail },
    laatsteMail: velden.laatsteMail || null,
    // Planning per gebruiker (zie src/planning.mjs): wat vóór weekmailVanaf
    // lag, wordt niet ingehaald; laatsteWeekronde is het laatst afgehandelde moment.
    weekmailVanaf: velden.weekmailVanaf || new Date().toISOString(),
    laatsteWeekronde: velden.laatsteWeekronde || null,
    laatstActief: null,
    aangemaakt: velden.aangemaakt || new Date().toISOString(),
  };
}

export const isBeheerder = (g) => g?.rol === 'admin';

// Wie doet dit verzoek? `kop` komt uit de headers van Authelia. Geeft de
// gebruiker, of null als deze persoon (nog) geen toegang heeft.
export function herken(opslag, { login, email, naam }, nu = new Date()) {
  const inlog = String(login || '').trim().toLowerCase();
  if (!inlog) return null;
  const mail = String(email || '').trim().toLowerCase();
  let g = opslag.gebruikers.find((x) => x.login && x.login.toLowerCase() === inlog);
  let gewijzigd = false;
  if (!g && mail) {
    g = opslag.gebruikers.find((x) => !x.login && x.email === mail);
    if (g) {
      g.login = inlog;
      gewijzigd = true;
    }
  }
  // Een installatie waar al eens een beheerder was, gaat nooit meer open voor
  // "de eerste die inlogt": ook niet als de beheerders later wegvallen (een
  // lege inlognaam, een kapot bestand). Herstellen kan dan alleen op de server.
  if (opslag.gebruikers.some((x) => x.login && isBeheerder(x)) && !opslag.status.beheerGestart) {
    opslag.status.beheerGestart = nu.toISOString();
    opslag.bewaar('status');
  }
  if (!g && !opslag.status.beheerGestart && !opslag.gebruikers.some((x) => isBeheerder(x))) {
    // De eerste die inlogt, wordt beheerder. Staat diegene al als ontvanger in
    // de lijst (zonder inlognaam), dan nemen we die over.
    g = opslag.gebruikers.find((x) => !x.login && mail && x.email === mail);
    if (!g) {
      g = nieuweGebruiker(opslag.instellingen, { login: inlog, naam: naam || inlog, email: mail, weekmail: { aan: false } });
      opslag.gebruikers.push(g);
    }
    g.login = inlog;
    g.rol = 'admin';
    gewijzigd = true;
    opslag.status.beheerGestart = nu.toISOString();
    opslag.bewaar('status');
  }
  if (!g) return null;
  if (!g.naam && naam) {
    g.naam = String(naam).trim();
    gewijzigd = true;
  }
  if (!g.email && mail) {
    g.email = mail;
    gewijzigd = true;
  }
  if (!g.laatstActief || nu - Date.parse(g.laatstActief) > ACTIEF_BIJWERKEN_MS) {
    g.laatstActief = nu.toISOString();
    gewijzigd = true;
  }
  if (gewijzigd) opslag.bewaar('gebruikers');
  return g;
}

export class InvoerFout extends Error {
  constructor(bericht) { super(bericht); this.status = 400; }
}

export function controleerWeekmail(invoer, bestaand) {
  const w = { ...bestaand, ...invoer };
  if (!TIJD.test(w.tijd)) throw new InvoerFout('Tijd moet de vorm UU:MM hebben, bijvoorbeeld 07:00');
  if (!Array.isArray(w.dagen) || w.dagen.some((d) => ![1, 2, 3, 4, 5, 6, 7].includes(d))) throw new InvoerFout('Ongeldige dagen');
  return { aan: Boolean(w.aan), dagen: [...new Set(w.dagen)].sort(), tijd: w.tijd, ookLeeg: Boolean(w.ookLeeg) };
}

// Wijzigingen controleren en toepassen. `beheer`: mag ook rol, titel, e-mail
// en inlognaam zetten (alleen beheerders). Een nieuw schema geldt vanaf nu:
// een moment dat daardoor "in het verleden" valt, gaat niet alsnog.
export function werkGebruikerBij(opslag, g, invoer, { beheer = false, regioIds }) {
  const nieuw = { ...g };
  if (invoer.naam !== undefined) nieuw.naam = String(invoer.naam).trim().slice(0, 100);
  if (invoer.regios !== undefined) {
    if (!Array.isArray(invoer.regios)) throw new InvoerFout('Ongeldige regio\'s');
    const onbekend = invoer.regios.filter((r) => !regioIds.includes(r));
    if (onbekend.length) throw new InvoerFout(`Onbekende regio: ${onbekend.join(', ')}`);
    nieuw.regios = regioIds.filter((id) => invoer.regios.includes(id));
  }
  if (invoer.weekmail !== undefined) {
    nieuw.weekmail = controleerWeekmail(invoer.weekmail, g.weekmail);
    const schema = (w) => `${w.aan} ${w.tijd} ${w.dagen}`;
    if (schema(nieuw.weekmail) !== schema(g.weekmail)) nieuw.weekmailVanaf = new Date().toISOString();
  }
  if (beheer) {
    if (invoer.email !== undefined) {
      const email = String(invoer.email).trim().toLowerCase();
      if (email && !EMAIL.test(email)) throw new InvoerFout(`"${email}" is geen geldig e-mailadres`);
      if (email && opslag.gebruikers.some((x) => x.id !== g.id && x.email === email)) throw new InvoerFout(`${email} staat er al in`);
      nieuw.email = email;
    }
    if (invoer.login !== undefined) {
      const login = String(invoer.login || '').trim().toLowerCase() || null;
      if (login && opslag.gebruikers.some((x) => x.id !== g.id && x.login === login)) throw new InvoerFout(`Inlognaam ${login} is al in gebruik`);
      if (!login && g.login && isBeheerder(g) && !opslag.gebruikers.some((x) => x.id !== g.id && isBeheerder(x) && x.login)) {
        throw new InvoerFout('Er moet minstens één beheerder met een inlognaam overblijven');
      }
      nieuw.login = login;
    }
    if (invoer.rol !== undefined) {
      if (!ROLLEN.includes(invoer.rol)) throw new InvoerFout('Kies journalist of admin');
      if (g.rol === 'admin' && invoer.rol !== 'admin' && !opslag.gebruikers.some((x) => x.id !== g.id && x.rol === 'admin' && x.login)) {
        throw new InvoerFout('Er moet minstens één beheerder overblijven');
      }
      nieuw.rol = invoer.rol;
    }
    if (invoer.titel !== undefined) {
      if (!TITELS.includes(invoer.titel)) throw new InvoerFout('Kies LC of DVHN');
      nieuw.titel = invoer.titel;
    }
  }
  if (!nieuw.email && !nieuw.login) throw new InvoerFout('Vul een e-mailadres in');
  if (nieuw.weekmail.aan && !nieuw.email) throw new InvoerFout('Voor de weekmail is een e-mailadres nodig');
  Object.assign(g, nieuw);
  return g;
}

export function voorClient(g) {
  const { weekmailVanaf, laatsteWeekronde, ...rest } = g;
  return { ...rest, uitgenodigd: !g.laatstActief };
}
