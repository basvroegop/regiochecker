// Eenmalige omzetting van het oude datamodel (oktober 2026):
//  - ontvangers.json → gebruikers.json. Elke ontvanger wordt een journalist
//    met dezelfde regio's. De weekmail neemt het oude schema over, en de vorige
//    mail en het planningspunt blijven staan: geen mail dubbel of te vroeg.
//  - kamertermen.json → regios.json. Termen per regio worden sleutelwoorden.
//  - Meldingen op kamerstukken met een los e-mailadres worden meldingen van
//    een gebruiker, "overal" en "alleen kamerstukken", zoals ze werkten.
// De oude bestanden blijven staan als back-up.
//
// Geeft de namen van de bestanden die opnieuw moeten worden weggeschreven.

import { randomUUID } from 'node:crypto';
import { nieuweGebruiker } from './gebruikers.mjs';
import { ransomwareTitel } from './bronnen/signalen.mjs';

export function migreer(opslag, { nieuw, oud }) {
  const gewijzigd = new Set();

  if (nieuw.includes('gebruikers')) {
    for (const o of oud('ontvangers', [])) {
      opslag.gebruikers.push(nieuweGebruiker(opslag.instellingen, {
        id: o.id,
        naam: o.naam,
        email: o.email,
        regios: o.regios,
        aangemaakt: o.aangemaakt,
        weekmail: { aan: o.actief !== false },
        laatsteMail: o.laatsteMail || null,
        // Het oude, gedeelde schema: wat vóór planningVanaf lag, halen we niet in.
        weekmailVanaf: opslag.status.planningVanaf || new Date().toISOString(),
        laatsteWeekronde: opslag.status.laatsteMailronde?.tijd || null,
      }));
    }
    gewijzigd.add('gebruikers');
  }

  if (nieuw.includes('regios')) {
    for (const [regio, termen] of Object.entries(oud('kamertermen', {}))) {
      if (!termen.length) continue;
      opslag.regios[regio] = {
        ...opslag.regios[regio],
        sleutelwoorden: termen.map((term) => ({ term, actief: true })),
      };
    }
    gewijzigd.add('regios');
  }

  for (const m of opslag.meldingen) {
    if (m.gebruiker) continue;
    let g = opslag.gebruikers.find((x) => x.email === m.email);
    if (!g) {
      g = nieuweGebruiker(opslag.instellingen, { naam: m.naam || '', email: m.email, regios: [], weekmail: { aan: false } });
      opslag.gebruikers.push(g);
      gewijzigd.add('gebruikers');
    }
    m.id ||= randomUUID();
    m.gebruiker = g.id;
    m.bereik = 'overal';
    m.bronnen = 'kamerstuk';
    m.tijd ||= opslag.instellingen.mailTijd || '07:00';
    delete m.email;
    gewijzigd.add('meldingen');
  }

  // Tot 28 oktober 2026: "Ransomwaregroep everest claimt aanval op B-accountants".
  for (const item of Object.values(opslag.items)) {
    const oudeTitel = item.soort === 'ransomware' && /^Ransomwaregroep (.+?) claimt aanval op (.+)$/.exec(item.titel || '');
    if (!oudeTitel) continue;
    item.titel = ransomwareTitel(oudeTitel[2], oudeTitel[1] === 'onbekend' ? null : oudeTitel[1]);
    gewijzigd.add('items');
  }

  return [...gewijzigd];
}
