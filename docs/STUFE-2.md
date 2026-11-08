# Stufe 2: Gesundheitsakte, Teilen und Standard-Schnittstellen

Stand: 8. November 2026. Grundlage sind die Analyse der Abläufe für Patienten, Ärzte, Labore und Kliniken vom 8. November (Stufenplan 1–6) und die Korrekturen des Kritikers dazu. Stufe 1 (Anmeldung per E-Mail-Code) ist live.

## 1. Kurzfassung

- **Patienten** bekommen eine eigene Gesundheitsakte: Laborbefunde, eigene Fotos und PDFs von Befunden, Profile für Kinder. Sie entscheiden, welcher Arzt welchen Eintrag wie lange sehen darf, und sehen, wer ihre Akte geöffnet hat.
- **Ärzte** sehen ihre Patienten in einer durchsuchbaren Liste und öffnen geteilte Einträge. Eine Profiländerung sperrt sie nicht mehr aus.
- **Labore und Kliniken** durchsuchen alle ihre Befunde und können Befunde direkt aus ihrer Software schicken.
- **Jeder Teil hat eine Standard-Schnittstelle:** HL7 FHIR R4 für alle Daten, IHE-Profile für Stammdaten (mCSD) und Dokumente (MHD), HL7 v2 für Laborbefunde (ORU) und Dokumente (MDM), OAuth 2.0 mit SMART-Scopes für Fremdsysteme und eine OpenAPI-Beschreibung der App-Schnittstelle.
- Stufe 2 besteht aus fünf Teilschritten (2.0, 2a, 2b, 2c, 2d). Jeder ist ein eigener Pull Request, getestet und einzeln live schaltbar.
- **Echte Gesundheitsdaten erst nach neuer Datenschutzerklärung:** Die Akte ist fertig gebaut und getestet, wird aber für Patienten erst freigeschaltet (Schalter `HEALTH_FILE=on`), wenn die Datenschutzerklärung angepasst und rechtlich geprüft ist.

## 2. Standards und Grundsätze der Schnittstellen

| Bereich | Standard | Version |
|---|---|---|
| Datenformat für alle klinischen und Stammdaten | **HL7 FHIR**, nur JSON | R4 (4.0.1) |
| Inhalte der Patientenakte | orientiert an der **International Patient Summary** (IPS), ohne US Core | IPS 1.1 |
| Stammdaten: Ärzte, Einrichtungen, Standorte, Leistungen | **IHE mCSD** (Mobile Care Services Discovery) | ITI-90 |
| Dokumente: suchen, abrufen, einstellen | **IHE MHD** (Mobile access to Health Documents) | ITI-65, ITI-67, ITI-68 |
| Protokoll „Wer hat was gesehen“ | FHIR AuditEvent nach **IHE BALP** (Basic Audit Log Patterns) | – |
| Laborbefunde und Dokumente aus älterer Software | **HL7 v2**: ORU^R01 (Befund), MDM^T02 (Dokument), Antwort ACK | 2.5.1, über HTTPS |
| Zugang für Fremdsysteme | **OAuth 2.0** Client Credentials, Scopes in **SMART on FHIR v2**-Schreibweise (z. B. `system/DiagnosticReport.c`) | RFC 6749, SMART 2.1 |
| App-Schnittstelle `/api` | **OpenAPI** | 3.1 |
| Codes | LOINC (Dokumentarten, Laborwerte), UCUM (Einheiten), ISO 3166-2:SY (Gouvernements), eigene CodeSystems aus `catalog.js` (Fachrichtungen, Einrichtungsarten, Leistungen) | – |

**Architektur:** Kein eigener FHIR-Server (HAPI braucht allein 1–1,5 GB RAM, der Server hat 2 GB). Stattdessen eine schlanke FHIR-Schicht in der bestehenden App unter `https://app.syriahc.com/fhir/r4`:
- Die PostgreSQL-Tabellen bleiben die einzige Datenquelle. FHIR-Ressourcen werden beim Abruf aus ihnen erzeugt (`src/fhir/map.js`).
- Ein zentrales Verzeichnis (`src/fhir/registry.js`) legt fest, welche Ressourcen, Suchparameter und Operationen es gibt. Daraus entsteht automatisch das **CapabilityStatement** (`/fhir/r4/metadata`). Unbekannte Suchparameter ergeben 400 mit **OperationOutcome**.
- Fehler kommen als OperationOutcome, mit Text auf Arabisch und Englisch. Jede Antwort hat `Cache-Control: no-store`.
- Der offizielle **HL7-Validator** prüft in GitHub Actions jede Ressource, die die Tests erzeugen. Er läuft nie auf dem Server.

**Sicherheitsregeln für alle Schnittstellen:**
- **Standardmäßig verboten.** Zugriff nur über eine ausdrückliche Beziehung (eigenes Profil, Freigabe, Scan, selbst verfasst). Außerhalb der Berechtigung gibt es **404**, nicht 403.
- **Keine Patientensuche** nach Name oder Telefon, für niemanden, auch nicht über FHIR.
- Eine einzige Prüfstelle `src/access.js` für `/api`, `/fhir` und `/hl7v2`.
- Jeder Zugriff auf klinische Inhalte wird mit Patient protokolliert (AuditEvent).
- Admins haben keine Route zu klinischen Inhalten.
- Fremdsysteme gehören immer zu einer freigegebenen Einrichtung. Wird sie gesperrt, sind ihre Zugänge sofort wirkungslos.
- Lesen über die Browser-Sitzung (Patient, Arzt) ist erlaubt. Schreiben über `/fhir` und `/hl7v2` nur mit OAuth-Token, nie mit Cookie.

**MDM** hat in der Medizininformatik zwei Bedeutungen, Stufe 2 deckt beide ab:
1. **Stammdaten (Master Data Management):** ein verlässliches Verzeichnis von Ärzten, Einrichtungen, Standorten und Leistungen (IHE mCSD, Teil 2.0), einheitliche Codesysteme (Teil 2.0) und ein **Patientenstamm** mit eindeutiger SyriaHC-Patientennummer, Kinderprofilen und Zusammenführung doppelter Personen (Master Patient Index, Teil 2b).
2. **HL7 v2 MDM (Medical Document Management):** Dokumente wie Entlassbriefe und Befundberichte aus Klinik- und Laborsoftware empfangen (MDM^T02, Teil 2d).

## 3. Teilschritte

### 2.0 Fundament und Stammdaten-Schnittstelle (öffentlich, keine Patientendaten) · Größe M

**Ergebnis:** Das öffentliche Verzeichnis (Ärzte, Labore, Kliniken, Krankenhäuser, freie Termine) und alle Codesysteme sind als HL7 FHIR abrufbar, im IHE-mCSD-Profil. Andere Gesundheitsportale, Behörden oder NGOs können das Verzeichnis übernehmen. Entwickler finden eine Beschreibung der Schnittstellen.

**Bauteile:**
- `src/fhir/`: Plugin unter `/fhir/r4`, `registry.js`, `map.js`, `search.js` (Parameter-Typen string, token, reference, date; `_count` höchstens 50; Blättern per Cursor), `terminology.js`, `outcome.js` (OperationOutcome).
- Ressourcen, nur lesen, nur freigegebene Einträge und öffentliche Felder:
  - `Practitioner`, `PractitionerRole` (Fachrichtung, Sprechzeiten), `Organization` (Labor, Bildgebung, Klinik, Krankenhaus), `Location` (Gouvernement, Gebiet, Adresse), `HealthcareService` (Leistungen, Notaufnahme), `Endpoint` (die FHIR-Adresse der Plattform)
  - `Schedule` und `Slot` (freie Termine eines Arztes)
  - `CodeSystem`, `ValueSet`, `NamingSystem` (Fachrichtungen, Einrichtungsarten, Leistungen, Gouvernements mit arabischen Bezeichnungen; Kennungen wie die SyriaHC-Patientennummer)
  - `CapabilityStatement`
- Suchparameter nach IHE mCSD, u. a. `name`, `type`, `specialty`, `organization`, `location`, `active`, `_lastUpdated`, `_include`.
- Migration `009_directory_updated.sql`: `updated_at` an Arzt- und Einrichtungsprofilen, damit andere Systeme nur Änderungen abholen können (`_lastUpdated`).
- **OpenAPI 3.1** für die App-Schnittstelle unter `/api/openapi.json` und eine Entwicklerseite `/developers` (Arabisch und Englisch).
- GitHub Actions: HL7-Validator über die Beispielressourcen.

**Tests:** Nur freigegebene Profile erscheinen; Lizenznummern und private Felder nie; jeder Suchparameter; unbekannter Parameter → 400 mit OperationOutcome; `metadata` passt genau zur Registry; Blättern über mehr als 50 Einträge; die Validator-Prüfung in CI ist grün.

### 2a Vorarbeiten: keine Sperre nach Profiländerung, Laborsuche, Postausgang, Admin-Schutz · Größe M

**Ergebnis:**
- Ärzte und Labore bleiben nach einer Profiländerung aktiv. Der Admin sieht alt und neu nebeneinander und nimmt an oder lehnt ab.
- Labore durchsuchen alle ihre Befunde (Name, Telefon, Test, Datum), ohne Grenze von 90 Tagen.
- Alle E-Mails laufen über einen Postausgang mit Wiederholung.
- Admins melden sich mit Passwort **und** E-Mail-Code an. Der Admin kann Konten deaktivieren.
- Gesperrte Ärzte sehen kein Dashboard mehr.

**Bauteile:** Migration `010_review_outbox.sql` (`pending_changes`, `email_outbox`, Index auf `audit_log`), `src/jobs.js` (Postausgang alle 5 Minuten, Aufräumen, Warnung bei wenig Speicherplatz), Admin-Reiter „Änderungen prüfen“.

**Schnittstellen:** Das bestehende Protokoll (`audit_log`) wird als FHIR **AuditEvent** nach IHE BALP abbildbar (Mapper und Tests). Die Laborsuche bekommt die Form, die später `DiagnosticReport?_lastUpdated=` braucht.

**Betrieb:** verschlüsselte Datensicherung **außerhalb** des Servers (restic) und ein Wiederherstellungstest. Docker-Logs werden begrenzt. Ziel der Sicherung: siehe Entscheidung 5.

### 2b Gesundheitsakte, Patientenstamm und eigene Uploads · Größe L

**Ergebnis:**
- „Meine Akte“ als Zeitleiste mit Filtern, dazu Kinderprofile.
- Den Laborzettel scannen und den Befund in die eigene Akte übernehmen. Der Arzt kann den Zettel weiter scannen.
- Fotos und PDFs von Befunden hochladen, mehrseitig. Die App verkleinert Fotos und entfernt den GPS-Standort.
- Jede Person bekommt eine **SyriaHC-Patientennummer** (`SHC-XXXX-XXXX-X` mit Prüfzeichen). Sie ist in der App jederzeit sichtbar, auch ohne Internet.

**Patientenstamm (MDM):**
- `patients` (= FHIR Patient) getrennt vom Login `users`. `patient_access` verbindet Login und Personen (selbst, Kind).
- Kennungen in `patient_identifiers` (Patientennummer, später weitere). Die Telefonnummer ist nur Kontakt, **nie** Schlüssel zur Akte.
- Zusammenführen doppelter Personen über `merged_into`, aufgelöst an einer Stelle in `access.js`.
- Das eigene Profil entsteht schon bei der Anmeldung und beim Buchen (`ensureSelfProfile`), nicht erst beim ersten Öffnen der Akte. Termine bekommen `subject_id` (für wen gebucht).

**Befund übernehmen (Korrektur des Kritikers):** Der Zettel-Code allein reicht nicht. Zusätzlich wird ein zweites Merkmal verlangt, das nur der Patient kennt: das **Geburtsjahr** oder die **letzten drei Ziffern der Telefonnummer**, die das Labor eingetragen hat. Höchstens 5 Versuche. Übernehmen geht nur für Befunde, deren Zettel den neuen Text tragen. Wer einen Befund findet, den jemand anderes übernommen hat, kann das melden.

**Bauteile:** Migration `011_health_file.sql` (`patients`, `patient_identifiers`, `patient_access`, `consents`, `clinical_documents`, `clinical_document_files`, Spalten an `lab_results`, View `health_file_items`), `src/healthfile.js`, Seite `file.html`.

**Upload-Schutz:** nur PDF, JPEG, PNG; höchstens 5 MB pro Seite; Prüfung anhand der ersten Bytes; EXIF und PNG-Textblöcke entfernen; PDFs mit aktiven Inhalten (`/JavaScript`, `/Launch`, `/EmbeddedFile`) ablehnen; Dateiantworten in einer Sandbox (die globale Sicherheitsrichtlinie wird dafür angepasst, Kritikpunkt #12); Quoten 100 Dokumente, 200 MB, 30 Seiten pro Tag; Löschen weich mit 30 Tagen Rückgängig.

**Schnittstellen (lesen, über die Sitzung, nur eigene Profile):**
- FHIR `Patient`, `RelatedPerson` (Kinderprofile), `DocumentReference` und `Binary` (Uploads und Laborbefunde), `DiagnosticReport` (Laborbefunde), `Consent` (Einwilligung zur Akte), `Appointment` (eigene Termine).
- **IHE MHD**: Dokumente suchen (ITI-67, `DocumentReference?patient=&type=&date=`) und abrufen (ITI-68, `Binary`).
- `Patient/:id/$everything` gibt die ganze Akte als FHIR-Bundle aus, orientiert an IPS. Daraus wird später „Meine Akte herunterladen“.

**Tests:** Ein anderer Patient bekommt 404; ohne Einwilligung kein Upload; Übernehmen ohne richtiges zweites Merkmal scheitert nach 5 Versuchen; Dateien liegen verschlüsselt auf der Platte; EXIF ist entfernt; aktive PDFs werden abgelehnt; Kinderprofil getrennt; jede Ansicht steht im Protokoll; die FHIR-Ausgabe besteht den Validator.

### 2c Teilen mit Ärzten und „Meine Patienten“ · Größe M–L

**Ergebnis:**
- Patienten teilen **einzelne** Einträge mit einem Arzt: aus dem Verzeichnis für 1, 30 oder 90 Tage (Standard 90), oder per QR-Code „Dem Arzt zeigen“ für 15 Minuten, oder beim Buchen bis 30 Tage nach dem Termin.
- Sie sehen „Wer hat meine Akte geöffnet?“ und widerrufen mit einem Tippen. Der Widerruf wirkt sofort.
- Ärzte haben „Meine Patienten“: serverseitige Suche, nach Person gruppiert, mit allen Quellen (Termine, Scans, Freigaben).

**Voraussetzung (Korrektur des Kritikers):** Bevor Ärzte geteilte Akten sehen, bestätigen sie ihre E-Mail-Adresse und melden sich mit einem zweiten Faktor (E-Mail-Code, Gerät 30 Tage merken) an.

**Bauteile:** Migration `012_sharing.sql` (`access_grants`, `access_grant_items`, `share_codes`, `revoked_at` für Scans), `src/access.js`, Teilen-Dialog, „Meine Patienten“ statt der bisherigen Aktenliste.

**Schnittstellen:**
- Freigaben als FHIR **Consent** (`provision.actor` = Arzt, `provision.data` = die geteilten Einträge, `provision.period`), mit Richtlinie (`policyRule`), Bereich und Kategorie, wie R4 es verlangt (Kritikpunkt #11).
- Zugriffsprotokoll als **AuditEvent** nach IHE BALP. Patienten sehen es ohne IP-Adressen.
- Ärzte lesen über FHIR genau das, was sie auch in der App sehen dürfen (`DocumentReference`, `DiagnosticReport`, `Binary`, `Patient`), über dieselbe Prüfstelle.

**Tests:** Arzt ohne Freigabe → 404, mit Freigabe 200, nach Widerruf oder Ablauf wieder 404; widerrufener Einzeleintrag → 404, der Rest bleibt; QR-Code nur einmal und nur 15 Minuten; jede Ansicht im Protokoll; Labor kann Patienten-Uploads nie öffnen; Admin hat keine Route.

### 2d System-Schnittstellen: Befunde und Dokumente aus Labor- und Kliniksoftware · Größe L

**Ergebnis:** Ein Labor oder eine Klinik verbindet ihre Software einmal und schickt Befunde und Dokumente direkt. Zeigt der Patient seine SyriaHC-Nummer, landet der Befund sofort in seiner Akte, sonst wie bisher mit Zettel-Code.

**Bauteile:**
- **OAuth 2.0 Client Credentials** unter `/oauth/token`: Der Admin legt pro Einrichtung einen Zugang mit Scopes an (z. B. `system/DiagnosticReport.c system/DocumentReference.c`). Das Geheimnis wird nur einmal angezeigt. Tokens gelten 15 Minuten. Migration `013_api_clients.sql`.
- **FHIR schreiben:**
  - Transaction-Bundle an `/fhir/r4` mit Patient (Patientennummer), DiagnosticReport mit PDF und optional Observation (LOINC, UCUM).
  - **IHE MHD ITI-65** „Provide Document Bundle“ für Dokumente wie Entlassbriefe.
  - Doppelte Sendungen sind harmlos (`ifNoneExist` auf die Labornummer).
- **HL7 v2 über HTTPS** unter `/hl7v2`:
  - **ORU^R01** (Laborbefund mit Werten, PDF als eingebettetes Dokument),
  - **MDM^T02** (Dokument mit Inhalt),
  - Antwort immer **ACK** (AA angenommen, AE Fehler in der Nachricht, AR abgelehnt).
  - Dieselbe Prüfstelle und dieselben Speicherwege wie FHIR.
- **Zustellung in die Akte:** Patientennummer **und** Geburtsjahr müssen passen, sonst bleibt der Befund beim Zettel-Code. Das Labor bekommt nie Namen oder Daten aus der Akte zurück, nur „zugestellt / nicht zugestellt“.
- Seite „Software verbinden“ für Einrichtungen (Anleitung, Beispiele) und Admin-Seite für Zugänge.

**Freischaltung:** Der lesende Teil von 2d ist sofort nutzbar. Der schreibende Teil geht erst mit einem **benannten Pilotlabor** live.

**Tests:** Token nur mit gültigem Geheimnis; gesperrte Einrichtung → Token abgelehnt; falscher Scope → 403; Absender kommt immer aus dem Token, nie aus der Nachricht; dieselbe Labornummer zweimal ergibt einen Befund; ORU und MDM erzeugen dieselben Daten wie FHIR; fehlerhafte HL7-v2-Nachricht → ACK mit AE und Fehlersegment (ERR); keine Patientensuche möglich; Bundle über 8 MB → 413.

## 4. Schnittstellen-Übersicht

| Teil | FHIR R4 | IHE-Profil | HL7 v2 | Wer darf | ab |
|---|---|---|---|---|---|
| Verzeichnis Ärzte | Practitioner, PractitionerRole, Location | mCSD | – | öffentlich (nur öffentliche Felder) | 2.0 |
| Verzeichnis Einrichtungen | Organization, Location, HealthcareService, Endpoint | mCSD | – | öffentlich | 2.0 |
| Freie Termine | Schedule, Slot | – | – | öffentlich | 2.0 |
| Codesysteme, Kennungen | CodeSystem, ValueSet, NamingSystem | – | – | öffentlich | 2.0 |
| Schnittstellenbeschreibung | CapabilityStatement | – | – | öffentlich | 2.0 |
| App-Schnittstelle | – (OpenAPI 3.1) | – | – | öffentlich lesbar | 2.0 |
| Protokoll | AuditEvent | BALP | – | Patient (eigene Profile, ohne IP) | 2a / 2c |
| Patientenstamm | Patient, RelatedPerson | (PIXm-Kennungen intern) | – | Patient: eigene; Arzt: über Beziehung | 2b / 2c |
| Einwilligung | Consent | – | – | Patient | 2b |
| Eigene Uploads | DocumentReference, Binary | MHD ITI-67/68 | – | Patient; Arzt mit Freigabe | 2b / 2c |
| Laborbefunde | DiagnosticReport, Observation, DocumentReference, Binary | MHD ITI-67/68 | – | Patient; Arzt mit Freigabe oder Scan | 2b / 2c |
| Termine | Appointment | – | – | Patient: eigene; Arzt: eigene | 2b / 2c |
| Ganze Akte | Bundle (`Patient/$everything`), IPS-orientiert | – | – | Patient | 2b |
| Freigaben | Consent | – | – | Patient, betroffener Arzt | 2c |
| Befunde von Laborsoftware | Bundle (transaction), DiagnosticReport, Observation | MHD ITI-65 | ORU^R01 → ACK | Einrichtung mit OAuth-Zugang | 2d |
| Dokumente von Kliniksoftware | DocumentReference, Binary | MHD ITI-65 | MDM^T02 → ACK | Einrichtung mit OAuth-Zugang | 2d |
| Zugang für Systeme | – | – | – | OAuth 2.0, SMART-v2-Scopes | 2d |

## 5. Nicht in Stufe 2

- Überweisungen von Arzt zu Arzt (ServiceRequest, Task): **Stufe 3**.
- Laboraufträge mit Rückfluss, Korrektur und Rückzug von Befunden durch das Labor: **Stufe 4**.
- SMART App Launch für fremde Patienten-Apps, Subscriptions (Benachrichtigung an Systeme), HL7 v2 über MLLP (eigener Port), Bulk-Export: später.
- SMS und WhatsApp: sobald es einen Anbieter für Syrien gibt.

## 6. Entscheidungen (mit Standard, damit die Arbeit weitergehen kann)

| # | Frage | Standard |
|---|---|---|
| 1 | Wann dürfen echte Gesundheitsdaten gespeichert werden? | Erst nach neuer, rechtlich geprüfter Datenschutzerklärung. Bis dahin ist die Akte gebaut, aber für Patienten ausgeschaltet. |
| 2 | Zweites Merkmal beim Übernehmen eines Befunds | Geburtsjahr oder die letzten 3 Ziffern der Telefonnummer, die das Labor eingetragen hat |
| 3 | Kinderprofile in der ersten Version | Ja, nur Kinder. Übergabe an das Kind mit 18 kommt später. |
| 4 | Standarddauer einer Freigabe | 90 Tage aus dem Verzeichnis, Termin + 30 Tage beim Buchen, 15 Minuten per QR |
| 5 | Ziel der externen Datensicherung | Ein günstiger Speicher bei einem zweiten Anbieter (z. B. Hetzner Storage Box, etwa 4 € im Monat), verschlüsselt mit restic. Der Schlüssel bleibt bei dir. **Braucht deine Bestellung.** |
| 6 | Zugang für Fremdsysteme | OAuth 2.0 Client Credentials mit Geheimnis. Signierte Anfragen (SMART Backend Services) später. |
| 7 | HL7 v2 Transportweg | HTTPS. MLLP (eigener Port) nur, wenn ein Pilotlabor es zwingend braucht. |
| 8 | Profilfelder, die nach der Freigabe neu geprüft werden | Name, Fachrichtung oder Art, Lizenznummer, Gouvernement, Gebiet, Adresse. Sofort gültig: Beschreibung, Öffnungszeiten, Telefon, Leistungen. |
| 9 | Quoten | Patient: 100 Dokumente, 200 MB, 30 Seiten pro Tag. Einrichtung: 300 Befunde pro Tag. |
| 10 | Pilotlabor für die Schreib-Schnittstelle | Lesender Teil sofort. Schreibender Teil erst mit einem benannten Labor. |

## 7. Reihenfolge und Freigaben

1. **2.0**: öffentlich und ohne Patientendaten, kann sofort live.
2. **2a**: kann sofort live. Externe Sicherung nach Entscheidung 5.
3. **2b**: live mit ausgeschalteter Akte. Einschalten nach Entscheidung 1.
4. **2c**: live zusammen mit dem Einschalten der Akte.
5. **2d**: lesender Teil sofort, schreibender Teil mit Pilotlabor.

Jeder Teilschritt ist ein eigener Pull Request mit Tests. Live geht er erst, wenn du zustimmst. Nur neue Migrationen, bestehende werden nie geändert. Kein Umschreiben der Git-Historie (`AGENTS.md`).
