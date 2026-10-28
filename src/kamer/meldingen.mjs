// Meldingen op termen: los van de regio's een mail als er een nieuw kamerstuk
// binnenkomt met een van de ingestelde termen. Per melding een e-mailadres,
// termen en een frequentie:
//   direct     na elke ronde waarin iets gevonden is (de dienst kijkt elk half uur)
//   dagelijks  hooguit één mail per dag, op het verstuurmoment uit de instellingen
//
// "Nieuw" = door ons binnengehaald na de vorige melding, en niet ouder dan twee
// weken (zo geven stukken die we de eerste keer inhalen geen stortvloed).

import { verstuur } from '../mail.mjs';
import { html } from '../html.mjs';
import { lokaleDatum, korteDatum } from '../datum.mjs';
import { trefferHtml, trefferTekst } from './weergave.mjs';
import { minDatum } from './db.mjs';

export function stelMeldingSamen(melding, treffers, nu = new Date()) {
  // In de volgorde van de melding, niet van de stukken.
  const gevonden = new Set(treffers.flatMap((t) => t.gevonden.map((g) => g.term)));
  const termen = melding.termen.filter((t) => gevonden.has(t));
  const onderwerp = `Kamerstukken: ${treffers.length} nieuw${treffers.length === 1 ? '' : 'e'} met ${termen.slice(0, 3).join(', ')}${termen.length > 3 ? ' …' : ''} (${korteDatum(lokaleDatum(nu))})`;
  const site = process.env.REGIOCHECKER_SITE_URL;
  const voet = `Je krijgt deze melding${melding.naam ? ` "${melding.naam}"` : ''} omdat je kamerstukken volgt met: ${melding.termen.join(', ')}.`;
  const htmlMail = `<!doctype html><html lang="nl"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f1;"><div style="max-width:680px;margin:0 auto;background:#fff;font-family:Georgia,'Times New Roman',serif;color:#1d1d1b;">
<div style="padding:22px 28px 14px;border-bottom:3px solid #1d1d1b;"><h1 style="font-size:26px;margin:0 0 4px;">Kamerstukken${melding.naam ? ` · ${html(melding.naam)}` : ''}</h1>
<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6b66;">${treffers.length} nieuw${treffers.length === 1 ? ' stuk' : 'e stukken'} van de Tweede Kamer met ${html(termen.join(', '))}</div></div>
<div style="padding:18px 28px 8px;">${treffers.map(trefferHtml).join('')}</div>
<div style="padding:8px 28px 26px;font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6b66;">${html(voet)}${site ? ` Instellen: <a href="${html(site)}/kamerstukken.html" style="color:#6b6b66;">${html(site)}/kamerstukken.html</a>` : ''}</div>
</div></body></html>`;
  const tekst = [`Kamerstukken${melding.naam ? ` · ${melding.naam}` : ''}`, '', ...treffers.map(trefferTekst), '', voet].join('\n\n');
  return { onderwerp, html: htmlMail, tekst };
}

function moment(nu, mailTijd) {
  const [uur, minuut] = String(mailTijd || '07:00').split(':').map(Number);
  return new Date(nu.getFullYear(), nu.getMonth(), nu.getDate(), uur || 0, minuut || 0);
}

// Na elke ronde. Geeft per melding wat er gebeurde.
export async function verwerkMeldingen(opslag, kdb, { nu = new Date() } = {}) {
  const resultaten = [];
  const vandaag = lokaleDatum(nu);
  for (const melding of opslag.meldingen.filter((m) => m.actief && m.termen.length)) {
    if (melding.frequentie === 'dagelijks') {
      if (nu < moment(nu, opslag.instellingen.mailTijd) || melding.laatsteDagronde === vandaag) continue;
      melding.laatsteDagronde = vandaag;
    }
    const sinds = melding.laatsteMelding || melding.aangemaakt;
    const tot = nu.toISOString();
    const treffers = kdb.treffers(melding.termen, { sinds, tot, minDatum: minDatum(sinds) });
    if (!treffers.length) {
      resultaten.push({ id: melding.id, verstuurd: false });
      continue;
    }
    try {
      const mail = stelMeldingSamen(melding, treffers, nu);
      await verstuur(opslag, { aan: melding.email, ...mail });
      melding.laatsteMelding = tot;
      melding.laatsteFout = null;
      opslag.log({ soort: 'kamermelding', aan: melding.email, tekst: mail.onderwerp });
      resultaten.push({ id: melding.id, verstuurd: true, aantal: treffers.length });
    } catch (fout) {
      // laatsteMelding blijft staan: de volgende ronde probeert het opnieuw.
      melding.laatsteFout = fout.message;
      opslag.log({ soort: 'mailfout', aan: melding.email, tekst: `Kamermelding: ${fout.message}` });
      resultaten.push({ id: melding.id, verstuurd: false, fout: fout.message });
    }
  }
  opslag.bewaar('meldingen');
  return resultaten;
}
