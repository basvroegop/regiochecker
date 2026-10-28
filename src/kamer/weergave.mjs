// Een kamerstuk met treffers, als HTML (mail) en als platte tekst. Gebruikt door
// de wekelijkse regiomail en door de meldingsmails op termen.

import { html, kort } from '../html.mjs';
import { korteDatum } from '../datum.mjs';
import { stukUrl } from './db.mjs';

const KLEIN = 'font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#6b6b66;';

export function kenmerkenStuk(s) {
  return [s.soort, s.dossier && `dossier ${s.dossier}`, s.afzender].filter(Boolean).join(' · ');
}

export const stukTitel = (s) => (s.titel && s.onderwerp && !s.onderwerp.includes(s.titel) ? `${s.titel}: ${s.onderwerp}` : (s.onderwerp || s.titel || s.nummer));

// Het fragment met de treffer gemarkeerd. Eerst ontsnappen, dan markeren.
export function fragmentHtml({ tekst, treffer }) {
  const veilig = html(kort(tekst, 400));
  const t = html(treffer);
  const i = veilig.indexOf(t);
  if (!t || i < 0) return veilig;
  return `${veilig.slice(0, i)}<strong style="background:#fff3b0;">${t}</strong>${veilig.slice(i + t.length)}`;
}

export function trefferHtml({ stuk, gevonden }) {
  const termen = gevonden.map((g) => `${g.term}${g.aantal > 1 ? ` (${g.aantal}×)` : ''}`).join(', ');
  return `<div style="margin:0 0 14px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;">
    <span style="color:#6b6b66;">${html(korteDatum(stuk.datum) || 'z.d.')}</span> &nbsp;<a href="${html(stukUrl(stuk))}" style="color:#1d1d1b;">${html(kort(stukTitel(stuk), 200))}</a>
    <br><span style="${KLEIN}">${html(kenmerkenStuk(stuk))}</span>
    <br><span style="${KLEIN}">Gevonden: <strong>${html(termen)}</strong></span>
    ${gevonden.slice(0, 2).map((g) => `<div style="margin:4px 0 0 10px;padding-left:8px;border-left:2px solid #e3e1da;font-size:13px;color:#3b3b38;">${fragmentHtml(g.fragment)}</div>`).join('')}
  </div>`;
}

export function trefferTekst({ stuk, gevonden }) {
  return [
    `* ${korteDatum(stuk.datum) || 'z.d.'}  ${stukTitel(stuk)}`,
    `  ${kenmerkenStuk(stuk)}`,
    `  Gevonden: ${gevonden.map((g) => g.term).join(', ')}`,
    ...gevonden.slice(0, 2).map((g) => `  "${kort(g.fragment.tekst, 300)}"`),
    `  ${stukUrl(stuk)}`,
  ].join('\n');
}
