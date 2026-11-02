// Koppelingen: een AI-assistent (Claude, …) laten zoeken in de Regiochecker via
// de MCP-server (src/mcpserver.mjs), en zien en intrekken welke apps dat mogen.

import { $, esc, vraag, toast, bezig, moment } from './gedeeld.js';

function koppelingRij(k) {
  return `<div class="meldingrij koppelingrij">
    <div class="naamcel"><strong>${esc(k.app)}</strong><br><span class="klein zacht">via ${esc(k.bestemming)}</span></div>
    <span class="klein">Gekoppeld ${esc(moment(k.aangemaakt, { metTijd: false }))}</span>
    <span class="klein zacht">${k.gebruikt ? `Laatst ${esc(moment(k.gebruikt))}` : 'Nog niet gebruikt'}</span>
    <button class="knop zacht klein" data-intrekken="${esc(k.id)}">Intrekken</button>
  </div>`;
}

export async function toonKoppelingen(hoofd) {
  let d = await vraag('GET', '/api/koppelingen');
  hoofd.innerHTML = `<div class="meldingenpagina"><h1>Koppelingen</h1>
    <div class="meldingsectie">
      <div><span class="titel">AI-assistent</span><span class="uitleg">Koppel een AI-assistent zoals Claude aan de Regiochecker. Die kan dan voor je zoeken en lezen in alles wat de Regiochecker heeft: stukken van gemeenten en hun archieven, Kamerstukken, signalen en de transcripten van vergaderingen, debatten, video's en podcasts.</span></div>
      <div class="inhoud">
        <div class="veld"><span>Adres van de MCP-server</span>
          <div class="adresregel"><code id="mcp-adres">${esc(d.adres)}</code><button class="knop zacht klein" id="kopieer-adres">Kopiëren</button></div>
        </div>
        <ul class="stappen">
          <li><strong>Claude (web en app)</strong>: Instellingen › Connectors › Aangepaste connector toevoegen. Plak het adres en klik op Verbinden.</li>
          <li><strong>Claude Code</strong>: <code>claude mcp add --transport http regiochecker ${esc(d.adres)}</code>, daarna <code>/mcp</code> om in te loggen.</li>
          <li>Andere apps die MCP met OAuth ondersteunen: hetzelfde adres.</li>
        </ul>
        <p class="uitleg-klein">Bij het koppelen log je in en geef je toestemming. De app kan alleen zoeken en lezen: niets wijzigen of versturen, en je bewaarde stukken, notities en meldingen ziet hij niet. Ingezonden tips blijven erbuiten. Wat de app vindt, gaat naar die app en het taalmodel erachter.</p>
      </div>
    </div>
    <div class="meldingsectie">
      <div><span class="titel">Gekoppelde apps</span><span class="uitleg">Apps die nu namens jou mogen zoeken. Intrekken werkt meteen; de app moet daarna opnieuw toestemming vragen.</span></div>
      <div class="inhoud" style="gap:0"><div id="koppelinglijst"></div></div>
    </div></div>`;

  const tekenLijst = () => {
    $('#koppelinglijst').innerHTML = !d.beschikbaar
      ? '<p class="statusregel fout">Koppelen is nu niet beschikbaar (de database ontbreekt).</p>'
      : d.koppelingen.length ? d.koppelingen.map(koppelingRij).join('') : '<p class="klein zacht koppeling-leeg">Nog geen gekoppelde apps.</p>';
  };
  tekenLijst();

  $('#kopieer-adres').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(d.adres);
      toast('Adres gekopieerd');
    } catch {
      // Zonder klembord (http, oude browser): selecteren, dan kopieert de gebruiker zelf.
      getSelection().selectAllChildren($('#mcp-adres'));
    }
  });
  $('#koppelinglijst').addEventListener('click', async (e) => {
    const knop = e.target.closest('[data-intrekken]');
    if (!knop) return;
    const k = d.koppelingen.find((x) => x.id === knop.dataset.intrekken);
    if (!k || !confirm(`${k.app} de toegang tot de Regiochecker ontnemen?`)) return;
    await bezig(knop, async () => {
      await vraag('DELETE', `/api/koppelingen/${encodeURIComponent(k.id)}`);
      d = await vraag('GET', '/api/koppelingen');
      tekenLijst();
      toast(`${k.app} is ontkoppeld`);
    }, 'Intrekken…');
  });
}
