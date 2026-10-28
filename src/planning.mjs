// Wanneer gaat de mail? De verstuurmomenten zijn een tijd plus een of meer
// weekdagen (standaard maandag 07:00, één keer per week).
//
// Gemiste momenten worden ingehaald: stond de dienst uit op het moment zelf,
// dan gaat de mail zodra hij weer draait. De inhoud loopt per ontvanger altijd
// van de vorige mail tot nu (zie mail.mjs), dus een gemist of overgeslagen
// moment betekent nooit een gat, alleen een langere periode in de volgende mail.
//
// Wat vóór `planningVanaf` lag, halen we niet in. Die tijd wordt gezet bij de
// eerste start en bij elke wijziging van het schema; anders zou het verzetten
// van "maandag" naar "dinsdag" op woensdag meteen een mail versturen.

function moment(dag, instellingen) {
  const [uur, minuut] = String(instellingen.mailTijd || '07:00').split(':').map(Number);
  return new Date(dag.getFullYear(), dag.getMonth(), dag.getDate(), uur || 0, minuut || 0);
}

const isMaildag = (dag, instellingen) => instellingen.mailDagen.includes(dag.getDay() || 7);

export function vorigMoment(nu, instellingen) {
  for (let i = 0; i <= 7; i++) {
    const dag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate() - i);
    if (!isMaildag(dag, instellingen)) continue;
    const m = moment(dag, instellingen);
    if (m <= nu) return m;
  }
  return null;
}

export function volgendMoment(nu, instellingen) {
  for (let i = 0; i <= 7; i++) {
    const dag = new Date(nu.getFullYear(), nu.getMonth(), nu.getDate() + i);
    if (!isMaildag(dag, instellingen)) continue;
    const m = moment(dag, instellingen);
    if (m > nu) return m;
  }
  return null;
}

export function moetMailen(nu, instellingen, status) {
  const gepland = vorigMoment(nu, instellingen);
  if (!gepland) return false;
  const vorigeRonde = Date.parse(status.laatsteMailronde?.tijd || 0);
  const vanaf = Date.parse(status.planningVanaf || 0);
  return gepland > vorigeRonde && gepland >= vanaf;
}

// De weekmail van één gebruiker: eigen dagen en tijd, eigen afgehandelde
// momenten (laatsteWeekronde) en eigen startpunt (weekmailVanaf, gezet bij
// het aanmaken en bij elke wijziging van het schema).
const schemaVan = (g) => ({ mailTijd: g.weekmail?.tijd, mailDagen: g.weekmail?.dagen || [] });

export function weekmailNodig(nu, g) {
  if (!g.weekmail?.aan || !g.weekmail.dagen?.length) return false;
  return moetMailen(nu, schemaVan(g), { laatsteMailronde: { tijd: g.laatsteWeekronde }, planningVanaf: g.weekmailVanaf });
}

export function volgendeWeekmail(nu, g) {
  if (!g.weekmail?.aan || !g.weekmail.dagen?.length) return null;
  return volgendMoment(nu, schemaVan(g));
}
