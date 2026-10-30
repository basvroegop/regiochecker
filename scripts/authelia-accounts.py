#!/usr/bin/env python3
"""Authelia-accounts voor de uitnodigingen uit de Regiochecker.

Draait op de server als root, gestart door systemd zodra er een aanvraag
klaarstaat (scripts/systemd/regiochecker-accounts.path), niet in de container.
De Regiochecker mag zelf niet in het gebruikersbestand van Authelia schrijven:
daar loggen ook andere sites op in (de wiki), en wie de Regiochecker zou
overnemen, kan dan elk account maken of wijzigen. Via dit script kan hij alleen:

- aanmaken: een nieuw account, altijd in de groep checker (die de wiki weert),
  met een willekeurig wachtwoord dat niemand kent. De gebruiker kiest zelf een
  wachtwoord via 'Wachtwoord opnieuw instellen?' op het inlogscherm. Bestaat er
  al een account met dat e-mailadres, dan geven we dat terug; een uitgezet
  checker-account gaat weer aan.
- uitzetten: alleen een account in de groep checker.

Accounts buiten de groep checker blijven altijd onaangeroerd. Alles in de
aanvragen is onvertrouwd (de container schrijft erin): strikte controles, geen
symlinks volgen, en de uitslag als nieuw bestand dat we daarna hernoemen.

Het gebruikersbestand lezen en schrijven we als geheel (YAML), net als Authelia
zelf doet bij een nieuw wachtwoord. Authelia leest het daarna vanzelf opnieuw
in (authentication_backend.file.watch in /opt/authelia/config/configuration.yml).
"""

import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import stat
import sys
import unicodedata

import yaml

MAP = os.environ.get('RC_ACCOUNTS_MAP', '/opt/regiochecker/data/authelia')
GEBRUIKERS = os.environ.get('RC_AUTHELIA_GEBRUIKERS', '/opt/authelia/config/users_database.yml')
GROEP = 'checker'
# Meer dan dit per keer wacht op de volgende ronde: een overgenomen container
# kan zo niet in één klap het gebruikersbestand volschrijven.
MAX_PER_RONDE = 25
MAX_GROOTTE = 4096
AANVRAAG = re.compile(r'^\d{13}-[0-9a-f-]{36}\.json$')
INLOG = re.compile(r'^[a-z0-9][a-z0-9._-]{0,31}$')
EMAIL = re.compile(r'^[^\s@<>,;"\']+@[^\s@<>,;"\']+\.[a-z]{2,}$', re.I)
GEBRUIKER_ID = re.compile(r'^[0-9A-Za-z-]{1,64}$')


class Fout(Exception):
    pass


def log(tekst):
    print(tekst, flush=True)


def open_map(naam, dir_fd=None, maak=False):
    try:
        return os.open(naam, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
    except FileNotFoundError:
        if not maak:
            raise
        os.mkdir(naam, 0o755, dir_fd=dir_fd)
        fd = os.open(naam, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dir_fd)
        if dir_fd is not None:
            ouder = os.fstat(dir_fd)
            os.fchown(fd, ouder.st_uid, ouder.st_gid)
        return fd


def lees_aanvraag(naam, dir_fd):
    fd = os.open(naam, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dir_fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_GROOTTE:
            raise Fout('Ongeldige aanvraag')
        ruw = os.read(fd, MAX_GROOTTE + 1)
    finally:
        os.close(fd)
    try:
        aanvraag = json.loads(ruw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Fout('Ongeldige aanvraag')
    if not isinstance(aanvraag, dict):
        raise Fout('Ongeldige aanvraag')
    return aanvraag


def schoon(tekst, lengte):
    tekst = ''.join(t for t in str(tekst or '') if unicodedata.category(t)[0] != 'C')
    return ' '.join(tekst.split())[:lengte]


def willekeurig_wachtwoord():
    # Een scrypt-hash (het $scrypt$-formaat dat Authelia leest) van een
    # wachtwoord dat meteen wordt weggegooid: inloggen kan pas na 'Wachtwoord
    # opnieuw instellen?'. Authelia schrijft dan zelf een nieuwe hash.
    zout = secrets.token_bytes(16)
    sleutel = hashlib.scrypt(secrets.token_bytes(32), salt=zout, n=2 ** 14, r=8, p=1, dklen=32)
    b64 = lambda b: base64.b64encode(b).decode().rstrip('=')
    return f'$scrypt$ln=14,r=8,p=1${b64(zout)}${b64(sleutel)}'


def zoek_inlog(gebruikers, inlog):
    return next((k for k in gebruikers if str(k).lower() == inlog), None)


def maak_aan(aanvraag, gebruikers):
    email = str(aanvraag.get('email') or '').strip().lower()
    if len(email) > 200 or not EMAIL.match(email):
        raise Fout('Ongeldig e-mailadres')
    naam = schoon(aanvraag.get('naam'), 100)
    inlog = aanvraag.get('login')
    if inlog is not None:
        inlog = str(inlog).strip().lower()
        if not INLOG.match(inlog):
            raise Fout('Ongeldige inlognaam: alleen kleine letters, cijfers, punt, streepje en liggend streepje, hooguit 32 tekens')
    zelfde = [k for k, v in gebruikers.items() if str((v or {}).get('email') or '').lower() == email]
    if len(zelfde) > 1:
        raise Fout(f'Er zijn in Authelia meer accounts met {email}: {", ".join(zelfde)}')
    if zelfde:
        k = zelfde[0]
        v = gebruikers[k]
        gewijzigd = False
        if v.get('disabled'):
            if GROEP not in (v.get('groups') or []):
                raise Fout(f'Het account {k} staat uit en is niet door de Regiochecker gemaakt; zet het in Authelia zelf aan')
            v['disabled'] = False
            gewijzigd = True
        return {'ok': True, 'login': str(k), 'bestond': True, 'aangezet': gewijzigd}, gewijzigd
    if inlog:
        if zoek_inlog(gebruikers, inlog):
            raise Fout(f'De inlognaam {inlog} bestaat al in Authelia, met een ander e-mailadres')
    else:
        # Uit het e-mailadres: anneké.de.wit@… wordt anneke.de.wit; bezet? Dan een cijfer erachter.
        deel = unicodedata.normalize('NFKD', email.split('@')[0]).encode('ascii', 'ignore').decode()
        basis = re.sub(r'[^a-z0-9._-]', '', deel).lstrip('._-')[:28] or 'gebruiker'
        inlog, n = basis, 2
        while zoek_inlog(gebruikers, inlog):
            inlog, n = f'{basis}{n}', n + 1
    gebruikers[inlog] = {'displayname': naam or inlog, 'password': willekeurig_wachtwoord(), 'email': email, 'groups': [GROEP]}
    return {'ok': True, 'login': inlog, 'bestond': False}, True


def zet_uit(aanvraag, gebruikers):
    inlog = str(aanvraag.get('login') or '').strip().lower()
    if not INLOG.match(inlog):
        raise Fout('Ongeldige inlognaam')
    k = zoek_inlog(gebruikers, inlog)
    if not k:
        return {'ok': True, 'login': inlog, 'bestond': False}, False
    v = gebruikers[k]
    if GROEP not in (v.get('groups') or []):
        raise Fout(f'Het account {k} is niet door de Regiochecker gemaakt en blijft aan')
    if v.get('disabled'):
        return {'ok': True, 'login': str(k), 'bestond': True}, False
    v['disabled'] = True
    return {'ok': True, 'login': str(k), 'bestond': True}, True


def verwerk(aanvraag, gebruikers):
    gebruiker = aanvraag.get('gebruiker')
    if not isinstance(gebruiker, str) or not GEBRUIKER_ID.match(gebruiker):
        raise Fout('Ongeldige aanvraag')
    soort = aanvraag.get('soort')
    if soort == 'aanmaken':
        return maak_aan(aanvraag, gebruikers)
    if soort == 'uitzetten':
        return zet_uit(aanvraag, gebruikers)
    raise Fout('Onbekende soort aanvraag')


def lees_gebruikers():
    with open(GEBRUIKERS, 'rb') as f:
        st = os.fstat(f.fileno())
        db = yaml.safe_load(f.read())
    if not isinstance(db, dict) or not isinstance(db.get('users'), dict):
        raise Fout('Het gebruikersbestand van Authelia is onleesbaar')
    return db, (st.st_ino, st.st_size, st.st_mtime_ns)


def schrijf_gebruikers(db, gelezen):
    tekst = yaml.safe_dump(db, sort_keys=False, allow_unicode=True, default_flow_style=False, width=1000)
    if yaml.safe_load(tekst) != db:
        raise Fout('Het gebruikersbestand zou niet goed worden teruggelezen')
    st = os.stat(GEBRUIKERS)
    # Intussen gewijzigd (Authelia na een nieuw wachtwoord, of iemand met de
    # hand)? Dan niet overschrijven maar opnieuw beginnen.
    if (st.st_ino, st.st_size, st.st_mtime_ns) != gelezen:
        return False
    map_ = os.path.dirname(GEBRUIKERS)
    tijdelijk = os.path.join(map_, f'.{os.path.basename(GEBRUIKERS)}.{os.getpid()}')
    fd = os.open(tijdelijk, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        os.write(fd, tekst.encode('utf-8'))
        os.fchown(fd, st.st_uid, st.st_gid)
        os.fchmod(fd, stat.S_IMODE(st.st_mode))
        os.fsync(fd)
    finally:
        os.close(fd)
    # De vorige versie blijft ernaast staan, voor als er iets misgaat.
    shutil.copy2(GEBRUIKERS, GEBRUIKERS + '.vorige')
    os.rename(tijdelijk, GEBRUIKERS)
    return True


def schrijf_uitslag(naam, uitslag, dir_fd):
    tijdelijk = f'.{naam}.tmp'
    try:
        os.unlink(tijdelijk, dir_fd=dir_fd)
    except FileNotFoundError:
        pass
    eigenaar = os.fstat(dir_fd)
    fd = os.open(tijdelijk, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o644, dir_fd=dir_fd)
    try:
        os.write(fd, json.dumps(uitslag, ensure_ascii=False).encode('utf-8'))
        os.fchown(fd, eigenaar.st_uid, eigenaar.st_gid)
    finally:
        os.close(fd)
    os.rename(tijdelijk, naam, src_dir_fd=dir_fd, dst_dir_fd=dir_fd)


def ronde():
    basis = open_map(MAP)
    aanvragen = open_map('aanvragen', basis)
    klaar = open_map('klaar', basis, maak=True)
    namen = sorted(os.listdir(aanvragen))
    for naam in [n for n in namen if not AANVRAAG.match(n)]:
        # Hoort hier niet (de Regiochecker zet alleen complete aanvragen neer);
        # weghalen, anders blijft systemd dit script starten.
        log(f'Weggehaald: {naam!r}')
        try:
            os.unlink(naam, dir_fd=aanvragen)
        except IsADirectoryError:
            os.rmdir(naam, dir_fd=aanvragen)
    namen = [n for n in namen if AANVRAAG.match(n)][:MAX_PER_RONDE]
    if not namen:
        return 0
    gelezen = {}
    for naam in namen:
        try:
            gelezen[naam] = lees_aanvraag(naam, aanvragen)
        except (Fout, OSError) as fout:
            gelezen[naam] = fout if isinstance(fout, Fout) else Fout('Ongeldige aanvraag')
    uitslagen = {}
    for _poging in range(3):
        try:
            db, stand = lees_gebruikers()
        except (Fout, OSError, yaml.YAMLError) as fout:
            # Elke aanvraag krijgt de fout terug; blijven liggen zou systemd dit
            # script eindeloos laten herstarten.
            melding = str(fout) if isinstance(fout, Fout) else 'Het gebruikersbestand van Authelia is onleesbaar'
            uitslagen = {naam: {'ok': False, 'fout': melding, **({} if isinstance(a, Fout) else {'soort': a.get('soort'), 'gebruiker': a.get('gebruiker')})} for naam, a in gelezen.items()}
            break
        gewijzigd = False
        uitslagen = {}
        for naam, aanvraag in gelezen.items():
            basis_uitslag = {} if isinstance(aanvraag, Fout) else {'soort': aanvraag.get('soort'), 'gebruiker': aanvraag.get('gebruiker')}
            try:
                if isinstance(aanvraag, Fout):
                    raise aanvraag
                uitslag, anders = verwerk(aanvraag, db['users'])
                gewijzigd = gewijzigd or anders
            except Fout as fout:
                uitslag = {'ok': False, 'fout': str(fout)}
            uitslagen[naam] = {**basis_uitslag, **uitslag}
        if not gewijzigd or schrijf_gebruikers(db, stand):
            break
    else:
        uitslagen = {naam: {**u, 'ok': False, 'fout': 'Het gebruikersbestand van Authelia veranderde steeds; probeer het zo opnieuw'} for naam, u in uitslagen.items()}
    for naam, uitslag in uitslagen.items():
        schrijf_uitslag(naam, uitslag, klaar)
        os.unlink(naam, dir_fd=aanvragen)
        log(f'{uitslag.get("soort")} {uitslag.get("login") or ""}: ' + ('gelukt' + (' (bestond al)' if uitslag.get('bestond') else '') if uitslag.get('ok') else f'mislukt: {uitslag.get("fout")}'))
    return len(uitslagen)


if __name__ == '__main__':
    try:
        ronde()
    except FileNotFoundError:
        # Nog geen map met aanvragen: niets te doen.
        pass
    except Fout as fout:
        log(f'Mislukt: {fout}')
        sys.exit(1)
