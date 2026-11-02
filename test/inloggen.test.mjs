// Inloggen met het gedeelde wachtwoord (src/inloggen.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as m from '../src/inloggen.mjs';

test('gedeeld wachtwoord: hash, sessies, het inlogscherm en de grens op pogingen', async () => {
  const hash = m.maakHash('geheim-wachtwoord');
  assert.match(hash, /^scrypt:[\w-]+:[\w-]+$/);
  assert.ok(!hash.includes('$'), 'docker compose zou $… invullen');
  process.env.REGIOCHECKER_WACHTWOORD = hash;
  process.env.REGIOCHECKER_SITE_URL = 'https://checker.test';
  try {
    assert.equal(await m.klopt('geheim-wachtwoord'), true);
    assert.equal(await m.klopt('Geheim-wachtwoord'), false);
    assert.equal(await m.klopt(''), false);
    assert.equal(await m.klopt('geheim-wachtwoord', 'onzin'), false);

    // Sessies: ondertekend, 30 dagen, na de helft verlengd.
    let klok = Date.now();
    const s = new m.Sessies('geheim', { klok: () => klok });
    const waarde = s.maak();
    assert.deepEqual(s.bekijk(waarde), { geldig: true, verlengen: false });
    const [tijd, handtekening] = waarde.split('.');
    assert.equal(s.bekijk(`${Number(tijd) + 86400_000}.${handtekening}`).geldig, false, 'zelf langer geldig maken kan niet');
    assert.equal(s.bekijk(`${tijd}.${handtekening.slice(0, -1)}x`).geldig, false);
    assert.equal(s.bekijk('').geldig, false);
    klok += 20 * 86400_000;
    assert.deepEqual(s.bekijk(waarde), { geldig: true, verlengen: true });
    klok += 11 * 86400_000;
    assert.equal(s.bekijk(waarde).geldig, false, 'na 30 dagen');
    klok = Date.now();
    const tweede = s.maak();
    process.env.REGIOCHECKER_WACHTWOORD = m.maakHash('ander');
    assert.equal(s.bekijk(tweede).geldig, false, 'een nieuw wachtwoord: iedereen opnieuw inloggen');
    process.env.REGIOCHECKER_WACHTWOORD = hash;
    assert.equal(new m.Sessies('ander geheim').bekijk(tweede).geldig, false);

    // Na inloggen alleen terug naar een pad op deze site.
    for (const [invoer, uit] of [['/', '/'], ['/oauth/authorize?client_id=a&x=1', '/oauth/authorize?client_id=a&x=1'], ['//aanvaller.example/x', '/'], ['https://aanvaller.example', '/'], ['/\\aanvaller', '/'], ['/inloggen', '/'], ['', '/'], [' /x', '/']]) {
      assert.equal(m.veiligTerug(invoer), uit, invoer);
    }

    // Het scherm zelf.
    const sessies = new m.Sessies('geheim');
    const pogingen = new m.Pogingen();
    const server = http.createServer((req, res) => m.inlogRoute(req, res, new URL(req.url, 'http://x'), { sessies, pogingen }));
    await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
    const adres = `http://127.0.0.1:${server.address().port}`;
    const post = (velden, kop = {}) => fetch(`${adres}/inloggen`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...kop }, body: new URLSearchParams(velden) });
    try {
      const scherm = await fetch(`${adres}/inloggen?terug=${encodeURIComponent('/oauth/authorize?a="b"')}`);
      const tekst = await scherm.text();
      assert.equal(scherm.status, 200);
      assert.match(tekst, /type="password" name="wachtwoord"/);
      assert.ok(!/name="naam"|type="text"/.test(tekst), 'alleen het wachtwoord');
      assert.match(tekst, /value="\/oauth\/authorize\?a=&quot;b&quot;"/);
      assert.match(scherm.headers.get('content-security-policy'), /frame-ancestors 'none'/);

      const fout = await post({ wachtwoord: 'raden', terug: '/' });
      assert.equal(fout.status, 401);
      assert.match(await fout.text(), /klopt niet/);
      assert.equal(fout.headers.get('set-cookie'), null);

      const goed = await post({ wachtwoord: 'geheim-wachtwoord', terug: '/oauth/authorize?client_id=a' });
      assert.equal(goed.status, 303);
      assert.equal(goed.headers.get('location'), '/oauth/authorize?client_id=a');
      const koekje = goed.headers.get('set-cookie');
      assert.match(koekje, /^rc_sessie=[\d]+\.[\w-]+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/);
      assert.equal(sessies.bekijk(koekje.split(';')[0].split('=')[1]).geldig, true);
      assert.equal((await post({ wachtwoord: 'geheim-wachtwoord', terug: '//aanvaller.example' })).headers.get('location'), '/');

      // Tien keer fout vanaf één adres: dan een kwartier niet meer, ook niet met het goede wachtwoord.
      const raden = { 'x-real-ip': '203.0.113.9' };
      for (let i = 0; i < 10; i++) assert.equal((await post({ wachtwoord: `poging${i}` }, raden)).status, 401);
      assert.equal((await post({ wachtwoord: 'geheim-wachtwoord' }, raden)).status, 429);
      assert.equal((await post({ wachtwoord: 'geheim-wachtwoord' }, { 'x-real-ip': '203.0.113.10' })).status, 303, 'een ander adres wel');

      const uit = await fetch(`${adres}/uitloggen`, { method: 'POST', redirect: 'manual' });
      assert.equal(uit.status, 303);
      assert.match(uit.headers.get('set-cookie'), /^rc_sessie=; Path=\/; Max-Age=0/);
      assert.equal((await fetch(`${adres}/uitloggen`)).status, 405, 'uitloggen alleen met POST');
    } finally {
      server.close();
    }
  } finally {
    delete process.env.REGIOCHECKER_WACHTWOORD;
    delete process.env.REGIOCHECKER_SITE_URL;
  }
});
