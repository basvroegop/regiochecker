// Alleen naar openbare internetadressen. Bronnen leveren links aan die de
// Regiochecker daarna zelf ophaalt (een nieuwsbericht, een bijlage, een
// opname), en een server kan doorsturen naar weer een ander adres. Geen van
// die stappen mag uitkomen bij iets in het eigen netwerk: localhost, de
// Docker-containers ernaast, het thuisnetwerk.
//
// Twee controles: het adres in de URL (een kaal IP-adres, ook na elke
// doorverwijzing), en het adres waar een naam bij het verbinden werkelijk naar
// verwijst. Dat laatste in de verbinding zelf (`dispatcher`), zodat een naam die
// eerst naar buiten en daarna naar binnen wijst (DNS-rebinding) ook niet werkt.

import dns from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';

const PRIVE = new net.BlockList();
for (const [adres, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) PRIVE.addSubnet(adres, prefix, 'ipv4');
// Geen ::ffff:0:0/96 hier: BlockList zou dan elk IPv4-adres afwijzen. Zo'n
// adres (IPv4 in IPv6-vorm) controleren we hieronder als het IPv4-adres zelf.
for (const [adres, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) PRIVE.addSubnet(adres, prefix, 'ipv6');

export function prive(adres, familie = net.isIP(adres)) {
  const v6 = familie === 6 || familie === 'IPv6';
  const v4 = v6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(adres)?.[1];
  return v4 ? PRIVE.check(v4, 'ipv4') : PRIVE.check(adres, v6 ? 'ipv6' : 'ipv4');
}

// Alleen voor de tests: nagebootste servers draaien op 127.0.0.1.
export const priveToegestaan = () => process.env.REGIOCHECKER_PRIVE_ADRESSEN === '1';

export class NietOpenbaar extends Error {}

// Gooit als de URL niet naar buiten mag; geeft de URL terug.
export function controleerUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new NietOpenbaar('Ongeldig internetadres.');
  }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) {
    throw new NietOpenbaar('Gebruik een openbare http- of https-adres zonder inloggegevens.');
  }
  if (priveToegestaan()) return u.href;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new NietOpenbaar('Alleen openbare internetadressen zijn toegestaan.');
  if (net.isIP(host) && prive(host)) throw new NietOpenbaar('Alleen openbare internetadressen zijn toegestaan.');
  return u.href;
}

// De DNS-uitkomst bij het verbinden: een privéadres breekt de verbinding af.
function veiligOpzoeken(naam, opties, klaar) {
  dns.lookup(naam, { ...opties, all: true }, (fout, adressen) => {
    if (fout) return klaar(fout);
    if (!priveToegestaan() && (!adressen.length || adressen.some((a) => prive(a.address, a.family)))) {
      return klaar(Object.assign(new NietOpenbaar(`${naam} wijst naar een adres in een eigen netwerk`), { code: 'ENIETOPENBAAR' }));
    }
    return opties.all ? klaar(null, adressen) : klaar(null, adressen[0].address, adressen[0].family);
  });
}

// `let`: de tests zetten er een nagebootst internet voor in de plaats (undici MockAgent).
export let openbaarDispatcher = new Agent({ connect: { lookup: veiligOpzoeken } });
export function zetOpenbaarDispatcher(dispatcher) {
  const vorige = openbaarDispatcher;
  openbaarDispatcher = dispatcher;
  return vorige;
}

export const _voorTests = { veiligOpzoeken };
