// Het accountscript op de server (scripts/authelia-accounts.py), tegen een
// tijdelijke kopie van het gebruikersbestand. Het draait op de host (Python met
// PyYAML); in de container ontbreekt PyYAML en wordt deze test overgeslagen:
//   node --test test/authelia-accounts.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, lstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'authelia-accounts.py');
const python = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
const metPython = { skip: python.status === 0 ? false : 'python3 met PyYAML niet beschikbaar' };

const GEBRUIKERS = `users:
  beheer:
    displayname: Beheer
    password: $2b$12$abcdefghijklmnopqrstuuVwxyzABCDEFGHIJKLMNOPQRSTUVWXYZa
    email: beheer@example.nl
    groups:
      - admins
  oud:
    displayname: Oud account
    password: $2b$12$abcdefghijklmnopqrstuuVwxyzABCDEFGHIJKLMNOPQRSTUVWXYZb
    email: oud@example.nl
    disabled: true
    groups:
      - users
  lotte:
    displayname: Lotte
    password: $scrypt$ln=14,r=8,p=1$c2FsdA$a2V5
    email: lotte@dvhn.nl
    groups:
      - checker
`;

function opzet() {
  const map = mkdtempSync(path.join(tmpdir(), 'rc-script-'));
  const basis = path.join(map, 'authelia');
  mkdirSync(path.join(basis, 'aanvragen'), { recursive: true });
  mkdirSync(path.join(basis, 'klaar'));
  const gebruikers = path.join(map, 'users_database.yml');
  writeFileSync(gebruikers, GEBRUIKERS, { mode: 0o600 });
  let n = 0;
  const aanvraag = (inhoud, naam) => {
    naam ||= `${1700000000000 + n++}-00000000-0000-4000-8000-${String(n).padStart(12, '0')}.json`;
    writeFileSync(path.join(basis, 'aanvragen', naam), typeof inhoud === 'string' ? inhoud : JSON.stringify(inhoud));
    return naam;
  };
  const draai = () => spawnSync('python3', [SCRIPT], { encoding: 'utf8', env: { ...process.env, RC_ACCOUNTS_MAP: basis, RC_AUTHELIA_GEBRUIKERS: gebruikers } });
  const uitslag = (naam) => JSON.parse(readFileSync(path.join(basis, 'klaar', naam), 'utf8'));
  // Het gebruikersbestand terug als object, via dezelfde YAML-lezer als het script.
  const lees = () => JSON.parse(spawnSync('python3', ['-c', 'import yaml,json,sys; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', gebruikers], { encoding: 'utf8' }).stdout).users;
  return { map, basis, gebruikers, aanvraag, draai, uitslag, lees };
}

test('script: nieuw account in de groep checker, bestaand account teruggeven', metPython, () => {
  const { basis, aanvraag, draai, uitslag, lees } = opzet();
  const nieuw = aanvraag({ soort: 'aanmaken', gebruiker: 'g1', login: null, naam: 'Anneké de Wit', email: 'Anneké.de.Wit@LC.nl' });
  const bestaand = aanvraag({ soort: 'aanmaken', gebruiker: 'g2', login: 'iets-anders', naam: 'Lotte', email: 'lotte@dvhn.nl' });
  const botsing = aanvraag({ soort: 'aanmaken', gebruiker: 'g3', login: null, naam: 'Andere Anneke', email: 'anneke.de.wit@dvhn.nl' });
  const r = draai();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(uitslag(nieuw), { soort: 'aanmaken', gebruiker: 'g1', ok: true, login: 'anneke.de.wit', bestond: false });
  assert.deepEqual(uitslag(bestaand), { soort: 'aanmaken', gebruiker: 'g2', ok: true, login: 'lotte', bestond: true, aangezet: false });
  assert.equal(uitslag(botsing).login, 'anneke.de.wit2', 'bezette inlognaam krijgt een cijfer');
  const g = lees();
  assert.deepEqual(g['anneke.de.wit'].groups, ['checker']);
  assert.equal(g['anneke.de.wit'].displayname, 'Anneké de Wit');
  assert.equal(g['anneke.de.wit'].email, 'anneké.de.wit@lc.nl', 'het e-mailadres zelf blijft zoals het is');
  assert.match(g['anneke.de.wit'].password, /^\$scrypt\$ln=14,r=8,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  // De rest precies zoals het was.
  assert.equal(g.beheer.password, '$2b$12$abcdefghijklmnopqrstuuVwxyzABCDEFGHIJKLMNOPQRSTUVWXYZa');
  assert.equal(g.lotte.password, '$scrypt$ln=14,r=8,p=1$c2FsdA$a2V5');
  assert.deepEqual(g.beheer.groups, ['admins']);
  assert.deepEqual(readdirSync(path.join(basis, 'aanvragen')), []);
  assert.ok(existsSync(path.join(path.dirname(basis), 'users_database.yml.vorige')));
  assert.equal(lstatSync(path.join(path.dirname(basis), 'users_database.yml')).mode & 0o777, 0o600);
});

test('script: alleen checker-accounts uitzetten of weer aanzetten', metPython, () => {
  const { aanvraag, draai, uitslag, lees } = opzet();
  const uitLotte = aanvraag({ soort: 'uitzetten', gebruiker: 'g1', login: 'lotte' });
  const uitBeheer = aanvraag({ soort: 'uitzetten', gebruiker: 'g2', login: 'beheer' });
  const oudAan = aanvraag({ soort: 'aanmaken', gebruiker: 'g3', naam: 'Oud', email: 'oud@example.nl' });
  const bezet = aanvraag({ soort: 'aanmaken', gebruiker: 'g4', login: 'beheer', naam: 'Andere beheerder', email: 'beheer2@example.nl' });
  assert.equal(draai().status, 0);
  assert.equal(uitslag(uitLotte).ok, true);
  assert.equal(lees().lotte.disabled, true);
  assert.deepEqual([uitslag(uitBeheer).ok, uitslag(uitBeheer).fout], [false, 'Het account beheer is niet door de Regiochecker gemaakt en blijft aan']);
  assert.equal(lees().beheer.disabled, undefined);
  assert.match(uitslag(oudAan).fout, /staat uit en is niet door de Regiochecker gemaakt/);
  assert.equal(lees().oud.disabled, true);
  assert.match(uitslag(bezet).fout, /beheer bestaat al in Authelia/);
  // Opnieuw uitnodigen zet het checker-account weer aan.
  const weer = aanvraag({ soort: 'aanmaken', gebruiker: 'g1', naam: 'Lotte', email: 'LOTTE@dvhn.nl' });
  assert.equal(draai().status, 0);
  assert.deepEqual(uitslag(weer), { soort: 'aanmaken', gebruiker: 'g1', ok: true, login: 'lotte', bestond: true, aangezet: true });
  assert.equal(lees().lotte.disabled, false);
});

test('script: onvertrouwde invoer en symlinks', metPython, () => {
  const { map, basis, gebruikers, aanvraag, draai, uitslag, lees } = opzet();
  const geheim = path.join(map, 'geheim.txt');
  writeFileSync(geheim, 'niet aankomen');
  // Een symlink met een geldige naam: niet volgen.
  const link = `1700000000999-00000000-0000-4000-8000-000000000999.json`;
  symlinkSync(geheim, path.join(basis, 'aanvragen', link));
  // Een uitslag die al als symlink klaarstaat: niet erdoorheen schrijven.
  const naam = aanvraag({ soort: 'aanmaken', gebruiker: 'g1', naam: 'Eva', email: 'eva@lc.nl' });
  symlinkSync(geheim, path.join(basis, 'klaar', naam));
  const rommel = aanvraag('x', 'rommel.txt');
  const kapot = aanvraag('{niet json');
  const vreemd = aanvraag({ soort: 'verwijderen', gebruiker: 'g2', login: 'beheer' });
  const gekkeInlog = aanvraag({ soort: 'aanmaken', gebruiker: 'g3', login: '../beheer', email: 'x@lc.nl' });
  const gekkeMail = aanvraag({ soort: 'aanmaken', gebruiker: 'g4', email: 'a@b@c' });
  const groep = aanvraag({ soort: 'aanmaken', gebruiker: 'g5', naam: 'Hacker\u0000\n  groups: [admins]', email: 'h@lc.nl', groups: ['admins'] });
  const r = draai();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(geheim, 'utf8'), 'niet aankomen');
  assert.ok(!lstatSync(path.join(basis, 'klaar', naam)).isSymbolicLink());
  assert.equal(uitslag(naam).login, 'eva');
  assert.deepEqual(uitslag(link), { ok: false, fout: 'Ongeldige aanvraag' });
  assert.equal(uitslag(kapot).fout, 'Ongeldige aanvraag');
  assert.equal(uitslag(vreemd).fout, 'Onbekende soort aanvraag');
  assert.match(uitslag(gekkeInlog).fout, /Ongeldige inlognaam/);
  assert.equal(uitslag(gekkeMail).fout, 'Ongeldig e-mailadres');
  assert.ok(!existsSync(path.join(basis, 'klaar', rommel)));
  assert.deepEqual(readdirSync(path.join(basis, 'aanvragen')), [], 'alles weg, anders start systemd het script steeds opnieuw');
  const g = lees();
  assert.deepEqual(g.h.groups, ['checker'], 'altijd en alleen de groep checker');
  assert.equal(g.h.displayname, 'Hacker groups: [admins]');
  assert.deepEqual(Object.keys(g), ['beheer', 'oud', 'lotte', 'eva', 'h']);
  assert.ok(readFileSync(gebruikers, 'utf8').startsWith('users:\n'));
});

test('script: onleesbaar gebruikersbestand geeft elke aanvraag een fout', metPython, () => {
  const { basis, gebruikers, aanvraag, draai, uitslag } = opzet();
  writeFileSync(gebruikers, 'users: [kapot');
  const naam = aanvraag({ soort: 'aanmaken', gebruiker: 'g1', naam: 'Eva', email: 'eva@lc.nl' });
  assert.equal(draai().status, 0);
  assert.deepEqual(uitslag(naam), { ok: false, fout: 'Het gebruikersbestand van Authelia is onleesbaar', soort: 'aanmaken', gebruiker: 'g1' });
  assert.deepEqual(readdirSync(path.join(basis, 'aanvragen')), []);
  assert.equal(readFileSync(gebruikers, 'utf8'), 'users: [kapot');
});
