# Plan: Plattform online bringen (Ärzte, Labore, Krankenhäuser, Patienten)

Stand: 22.10.2026. Fertig und in `main`: Anmeldung, Profile, Lizenz-Upload und Prüfung für Ärzte und Einrichtungen, Sprechzeiten, Terminbuchung, Arzt-Dashboard und die Übernahme auf syriahealthcare.com. Die Plattform läuft aber noch nirgends öffentlich.

Jeder Teil unten sagt: **was** zu tun ist, **wie**, **wer** es macht (du oder Claude) und **was vorher erledigt sein muss**.

---

## Reihenfolge auf einen Blick

| Phase | Teil | Wer | Braucht vorher |
|---|---|---|---|
| 1 | A. Entscheidungen zu Betreiber und Serverstandort | du | — |
| 1 | B. Datenschutzerklärung und Datenfluss | du + Claude | A |
| 2 | C. Server mieten und einrichten | du + Claude | A |
| 2 | D. Domain app.syriahc.com auf den Server zeigen | du | C |
| 2 | E. Fehlende Funktionen: Passwort vergessen, E-Mails | Claude | — |
| 3 | F. Website mit der Plattform verbinden | du | C, D |
| 3 | G. Prüfablauf für Ärzte und Einrichtungen festlegen | du | — |
| 3 | H. Test mit 2–3 echten Praxen und Laboren | du | B–G |
| 4 | I. SMS und WhatsApp für Patienten | du + Claude | C |
| 4 | J. Zweiter Faktor beim Login für Admins und Ärzte | Claude | E |
| laufend | K. Betrieb: Backups, Überwachung, Updates | du + Claude | C |
| offen | L. Lovable-Dateien im Repository | du | — |

---

## A. Entscheidungen zu Betreiber und Serverstandort

**Was:** Bevor irgendjemand Daten abgibt, muss feststehen, wer die Plattform betreibt und wo die Daten liegen.

**Wie, zu entscheiden:**
1. **Betreiber:** Firma oder Person mit Name, Adresse und Kontakt. Diese Angaben kommen in die Datenschutzerklärung und ins Impressum.
2. **Serverstandort:**
   - *Syrien:* Daten bleiben im Land. Dafür brauchst du einen Anbieter mit Notstrom und stabilem Internet, und Backups an einem zweiten Ort in Syrien.
   - *Deutschland/EU (z. B. Hetzner):* günstig (ca. 5 €/Monat), zuverlässig, DSGVO-konform. Die Daten liegen dann aber nicht in Syrien.
3. **Rechtliche Prüfung:** Sitzt der Betreiber in Deutschland, gilt die DSGVO auch für einen Server in Syrien. Lizenzen sind personenbezogene Daten, Termingründe sind Gesundheitsdaten. Das muss ein Datenschutz-Berater klären, besonders die Übermittlung in ein Land ohne EU-Abkommen.

**Wer:** du (ggf. mit Berater).
**Ergebnis:** Betreiber-Angaben und Serverstandort stehen fest.

---

## B. Datenschutzerklärung und Datenfluss

**Was:** Die Seite `/privacy` ist ein Entwurf mit Platzhaltern in [Klammern]. Sie muss genau beschreiben, was mit den Daten passiert.

**Datenfluss heute:**
- Ein Labor oder Arzt gibt die Daten auf app.syriahc.com ein. Sie werden verschlüsselt (HTTPS) an **deinen Server** geschickt.
- Datenbank auf deinem Server: Name, Adresse, Telefon, Lizenznummer, Leistungen, Kontaktperson, E-Mail, Passwort (nur als Hash).
- Lizenz-Dokumente: AES-256-verschlüsselt auf deinem Server. Nur Admins können sie öffnen, und jedes Öffnen wird protokolliert.
- **Nach deiner Freigabe** holt GitHub zweimal täglich nur die öffentlichen Felder ab (Name, Art, Adresse, Telefon, Leistungen, Öffnungszeiten) und schreibt sie in das **öffentliche** Repository. Die Website zeigt sie an.
- Nie bei GitHub: Dokumente, Lizenznummer, Kontaktperson, E-Mail, Passwort, Prüfnotizen.

**Wie:**
1. Du nennst Claude Betreiber, Kontakt, Serverstandort und Speicherdauer (Vorschlag: Lizenzen bis 1 Jahr nach Löschung des Kontos).
2. Claude schreibt `/privacy` auf Deutsch, Englisch und Arabisch fertig und nimmt den Datenfluss oben auf.
3. Dein Berater prüft den Text.
4. *Optional:* Wenn die öffentlichen Einträge **nicht** im GitHub-Repository liegen sollen, ändert Claude die Website so, dass sie die Liste beim Aufruf direkt vom Server holt. Nachteil: Ist der Server offline, sind die Listen leer.

**Wer:** du liefert die Angaben, Claude schreibt, Berater prüft.
**Aufwand Claude:** ca. 1 Sitzung.

---

## C. Server mieten und einrichten

**Was:** Ein Linux-Server, auf dem Plattform, Datenbank und HTTPS laufen. Alles ist schon als Docker-Paket vorbereitet (`platform/docker-compose.yml`).

**Wie:**
1. Server mieten: Ubuntu 24.04, mindestens 2 GB RAM, 40 GB Festplatte, Ports 80 und 443 offen. In Deutschland z. B. Hetzner CX22, in Syrien ein Anbieter nach Entscheidung A.
2. Docker installieren und den Ordner `platform` auf den Server bringen (`git clone`).
3. `.env` anlegen (`cp .env.example .env`):
   - `APP_DOMAIN=app.syriahc.com`
   - `POSTGRES_PASSWORD`, `OTP_SECRET`, `DOCUMENT_KEY`: jeweils ein langer Zufallswert
   - **`DOCUMENT_KEY` zusätzlich sicher außerhalb des Servers aufbewahren**, z. B. im Passwort-Manager. Ohne ihn sind alle Lizenzen verloren.
4. Starten mit `docker compose up -d --build`.
5. Admin anlegen: `docker compose exec app node src/create-admin.js deine@email "Dein Name"`.
6. Prüfen: https://app.syriahc.com/api/health zeigt `{"ok":true}`.

**Wer:** du mietest den Server, Claude macht die Einrichtung mit dir zusammen (oder direkt per SSH).
**Unsicher:** Wenn der Server in Syrien steht, prüfen, ob Docker Hub und GitHub von dort erreichbar sind. Früher waren sie wegen Sanktionen gesperrt.

---

## D. Domain app.syriahc.com auf den Server zeigen

**Was:** Die Subdomain gibt es bei STRATO schon. Sie muss nur auf den neuen Server zeigen.

**Wie (STRATO → Domainverwaltung → syriahc.com → app.syriahc.com):**
1. Reiter **DNS** → **A-Record** → „andere IP-Adresse" → IP des Servers eintragen.
2. **AAAA-Record:** IPv6 des Servers eintragen oder leeren.
3. Unter **Webserver** die Umleitung bzw. den Platzhalter entfernen.
4. Bis zu 1 Stunde warten. Danach holt der Server automatisch das HTTPS-Zertifikat.

**Wer:** du. **Braucht vorher:** C (die IP-Adresse).

---

## E. Fehlende Funktionen: Passwort vergessen und E-Mails

**Was:** Zwei Lücken vor dem Start:
1. **Passwort vergessen** gibt es nicht. Ein Arzt oder Labor, das sein Passwort verliert, kommt nicht mehr ins Konto.
2. **E-Mails werden nicht verschickt.** Die Seiten versprechen „Wir benachrichtigen Sie per E-Mail", aber Freigabe, Ablehnung und Sperrung lösen keine Mail aus.

**Wie:**
1. Du richtest ein Absender-Postfach ein, z. B. `noreply@syriahc.com` bei STRATO (SMTP ist im Domainpaket enthalten) oder bei einem Versanddienst wie Brevo oder Postmark.
2. Claude baut:
   - E-Mail-Versand über SMTP, in Arabisch und Englisch
   - Mails bei Registrierung, Freigabe, „Änderungen nötig", Sperrung, und an dich bei jeder neuen Einreichung
   - „Passwort vergessen" mit einmaligem Link, 30 Minuten gültig
   - Tests dafür
3. SMTP-Zugangsdaten kommen in `.env`.

**Wer:** du das Postfach, Claude den Code.
**Aufwand Claude:** ca. 1 Sitzung. **Kann sofort starten.**

---

## F. Website mit der Plattform verbinden

**Was:** Damit freigegebene Ärzte und Einrichtungen auf syriahealthcare.com erscheinen und dort der Link „Labor eintragen" auftaucht.

**Wie:**
1. GitHub → Repository → Settings → Secrets and variables → Actions → **Variables** → `PLATFORM_URL` = `https://app.syriahc.com`.
2. Unter Actions den Workflow „Update news and jobs" einmal von Hand starten.
3. Prüfen: syriahealthcare.com/labs.html zeigt den Link „Labor eintragen", nach der ersten Freigabe auch den Eintrag.

**Wer:** du. **Braucht vorher:** C und D.

---

## G. Prüfablauf für Ärzte und Einrichtungen festlegen

**Was:** Die Plattform zeigt dir Lizenz-Dokument und Lizenznummer. Wie gründlich du prüfst, legst du fest. Eine automatische Prüfung bei Ärztekammer oder Gesundheitsministerium gibt es nach unserem Wissen nicht.

**Vorschlag für eine Checkliste:**
1. Lizenz-Dokument lesbar, Name stimmt mit dem Konto bzw. der Einrichtung überein, nicht abgelaufen.
2. Lizenznummer stimmt mit dem Dokument überein.
3. Rückruf unter der angegebenen Praxis- oder Labornummer.
4. Bei Zweifel: Nachfrage bei der Ärztekammer (نقابة الأطباء) oder der Gesundheitsdirektion.
5. Bei Ablehnung immer einen klaren Grund schreiben, denn den sieht der Antragsteller.

**Optional, Claude kann bauen:** die Checkliste als Häkchen im Admin-Bereich, sodass „Freigeben" erst nach allen Häkchen geht. Außerdem mehrere Admins mit Vier-Augen-Prinzip.

**Wer:** du legst fest, Claude baut auf Wunsch.

---

## H. Test mit echten Praxen und Laboren

**Was:** Vor der breiten Ankündigung 2–3 Ärzte und 1–2 Labore den ganzen Weg gehen lassen.

**Wie:**
1. Link `https://app.syriahc.com/staff` schicken.
2. Beobachten: Wo hängen sie? Welche Felder fehlen oder sind unklar?
3. Rückmeldungen an Claude geben, Claude passt Texte und Felder an.
4. Erst danach öffentlich ankündigen.

**Wer:** du. **Braucht vorher:** B bis G.

---

## I. SMS und WhatsApp für Patienten

**Was:** Patienten melden sich per Code auf dem Handy an. Ohne SMS-Anbieter können sie sich in Produktion nicht anmelden. Ärzte und Einrichtungen brauchen das nicht, sie nutzen E-Mail und Passwort.

**Wie:**
1. **SMS:** Einen Anbieter suchen, der zuverlässig an syrische Nummern (+963) liefert, und die Zugangsdaten in `.env` eintragen. Claude passt `platform/src/sms.js` an das Format des Anbieters an.
2. **WhatsApp:** In Syrien wahrscheinlich zuverlässiger und beliebter als SMS.
   - Du: WhatsApp-Business-Konto bei Meta (WhatsApp Cloud API) mit verifizierter Firma anlegen. **Zuerst bei Meta klären, ob das Senden an +963-Nummern erlaubt ist.**
   - Claude baut: Code per WhatsApp, SMS als Ersatz; Terminbestätigungen per WhatsApp.
3. Kosten: ein paar Cent pro Nachricht.

**Wer:** du die Konten, Claude den Code. **Braucht vorher:** C.

---

## J. Zweiter Faktor beim Login

**Was:** Admins sehen alle Lizenzen, deshalb sollte das Passwort allein nicht reichen.

**Wie:** Nach dem Passwort zusätzlich ein Code per E-Mail, eine Authenticator-App oder WhatsApp (wenn I fertig ist). Pflicht für Admins, freiwillig für Ärzte und Einrichtungen.

**Wer:** Claude. **Braucht vorher:** E (E-Mail-Versand).

---

## K. Betrieb: Backups, Überwachung, Updates

**Was und wie:**
1. **Backups:** Der Server legt jede Nacht eine Datenbank-Sicherung und ein Archiv der verschlüsselten Dokumente an (14 Tage). Diese Dateien regelmäßig **an einen zweiten Ort** kopieren (bei Serverstandort Syrien: zweiter Ort in Syrien). Claude kann das automatisieren.
2. **Wiederherstellung einmal üben:** Sicherung auf einem Testrechner zurückspielen und prüfen, dass Lizenzen sich mit dem `DOCUMENT_KEY` öffnen lassen.
3. **Überwachung:** Einen kostenlosen Dienst (z. B. UptimeRobot) https://app.syriahc.com/api/health alle 5 Minuten prüfen lassen, mit Alarm per E-Mail.
4. **Updates:** Nach jeder Änderung in `main` auf dem Server `git pull && docker compose up -d --build` ausführen. Datenbank-Änderungen laufen automatisch. Claude kann das später per GitHub Action automatisieren.

**Wer:** du + Claude.

---

## L. Lovable-Dateien im Repository

**Was:** In deinem lokalen Ordner liegen 10 Dateien, die nicht im Repository sind: `.prettierignore`, `.prettierrc`, `AGENTS.md`, `bun.lock`, `bunfig.toml`, `components.json`, `eslint.config.js`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`. Das ist eine Lovable-Vorlage für eine React-App. Die Website hier ist aber eine einfache HTML-Seite ohne `src/`-Ordner und ohne diese Pakete.

**Entscheidung:** Diese Dateien zu pushen könnte die Lovable-Vorschau oder den Build stören. Claude pusht sie nur, wenn du das ausdrücklich willst. Sonst können sie gelöscht oder per `.gitignore` ausgeschlossen werden.

**Wer:** du entscheidest.

---

## Was Claude sofort machen kann (ohne auf dich zu warten)

1. **E** – E-Mail-Versand und „Passwort vergessen" (sobald du ein Absender-Postfach hast; der Code geht schon vorher)
2. **G** – Prüf-Checkliste im Admin-Bereich
3. **B** – Entwurf der Datenschutzerklärung mit dem echten Datenfluss (Platzhalter für Betreiber bleiben)

## Was nur du machen kannst

1. **A** – Betreiber und Serverstandort entscheiden, Berater fragen
2. **C** – Server mieten
3. **D** – DNS bei STRATO umstellen
4. **I** – SMS-Anbieter und WhatsApp-Business-Konto
5. **L** – Entscheidung zu den Lovable-Dateien
