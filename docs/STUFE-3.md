# Stufe 3: Mehr Funktionen und internationale Schnittstellen

Stand: 16. November 2026. Grundlage ist Stufe 2 (`docs/STUFE-2.md`): gebaut, getestet und auf dem Server. Dort stehen unter „Nicht in Stufe 2" Überweisungen, Laboraufträge, SMART App Launch, Subscriptions und Bulk-Export. Dieser Plan nimmt sie auf und ergänzt, was die Plattform für Patienten, Ärzte, Labore und das syrische Gesundheitswesen stärker macht.

## 1. Kurzfassung

- **Fremde Apps** verbinden sich mit Zustimmung des Patienten (SMART App Launch). Software von Kliniken meldet sich mit einem Schlüsselpaar an statt mit einem Geheimnis.
- **Termine** lassen sich aus Praxissoftware und anderen Portalen buchen (IHE Scheduling). Termine der Plattform landen in der Praxissoftware (HL7 v2 SIU).
- **Überweisungen und Laboraufträge** gehen digital vom Arzt zum Facharzt oder Labor. Der Befund kommt zum Auftrag und zum Arzt zurück, ohne QR-Zettel.
- **Patientenkurzakte** nach dem internationalen Standard IPS, teilbar per QR-Code auch mit Ärzten im Ausland (SMART Health Links). Das hilft Syrern, die zurückkehren oder im Ausland behandelt werden.
- **Impfpass und Schwangerschaftsvorsorge** nach den WHO SMART Guidelines.
- **Elektronisches Rezept** mit QR-Code für Apotheken, erst nach rechtlicher Klärung.
- **Kodierung** mit ICD-11 der WHO, auf Arabisch und Englisch.
- **Zahlen für das Gesundheitsministerium** in DHIS2, das Syrien landesweit einführt: nur Summen, nie Personen.
- **Benachrichtigungen an Systeme** (FHIR Subscriptions) statt ständigem Nachfragen, und **Massenabruf** (Bulk Data) für berechtigte Partner.
- Dazu Funktionen ohne neue Standards: Team-Zugänge für Praxen und Labore, Konto selbst löschen, Android-App in Google Play, bessere arabische Suche.

## 2. Ausgangslage

| Bereich | Heute |
|---|---|
| Verzeichnis | FHIR R4 nach IHE mCSD (ITI-90): Practitioner, PractitionerRole, Organization, Location, HealthcareService, Endpoint, Schedule, Slot. Öffentlich, nur lesen. |
| Akte | Patient, RelatedPerson, DocumentReference, Binary, DiagnosticReport, Consent, Appointment, AuditEvent und `Patient/$everything`. Nur über die Browser-Sitzung. |
| Dokumente | IHE MHD: ITI-65, ITI-67, ITI-68 |
| Laborsoftware | FHIR-Transaktion und HL7 v2 (ORU^R01, MDM^T02) über HTTPS, OAuth 2.0 mit Geheimnis |
| Beschreibung | CapabilityStatement, OpenAPI 3.1, Entwicklerseite `/developers` |

**Fehlt:** Anmeldung für fremde Apps, Termine über Schnittstellen buchen, Aufträge, Ereignisse an Systeme, Änderungsabruf für das Verzeichnis, Terminologie-Operationen, Messwerte als eigene Ressource, Team-Zugänge. Eine Einrichtung hat heute genau ein Konto. Die Arztsuche vergleicht Text genau, „أحمد" findet also „احمد" nicht.

## 3. Neue Standards

| Bereich | Standard | Version, Stand |
|---|---|---|
| Fremde Apps für Patienten und Ärzte | **HL7 SMART App Launch**: Authorization Code mit PKCE, OpenID Connect, `/.well-known/smart-configuration` | 2.2 |
| Software ohne Geheimnis | **SMART Backend Services**: `private_key_jwt` mit öffentlichem Schlüssel (JWKS) | 2.2 |
| Termine buchen | **IHE ITI Scheduling**: ITI-115 `$find`, ITI-117 `$book`; optional ITI-116 `$hold`, ITI-118 eigene Termine finden | 1.0.0, Trial Implementation |
| Termine an Praxissoftware | **HL7 v2 SIU** S12 (neu), S13 (verschoben), S15 (abgesagt) | 2.5.1 über HTTPS |
| Freie Termine für Suchportale | **HL7 SMART Scheduling Links** | STU 1 |
| Verzeichnis abgleichen | **IHE mCSD ITI-91**: `_history` mit `_since` | Trial Implementation |
| Überweisungen und Aufträge | **FHIR ServiceRequest und Task** (FHIR Workflow) | R4 |
| Laboraufträge an Laborsoftware | **HL7 v2 OML^O21**, Antwort ORL^O22, Befund ORU^R01 mit Auftragsnummer | 2.5.1 |
| Patientenkurzakte | **HL7 International Patient Summary**, Operation `$summary` | IPS 2.0.1 |
| Teilen per QR-Code | **HL7 SMART Health Links** (SMART Health Cards and Links IG) | STU 1, Juli 2025 |
| Einwilligungen | **IHE Privacy Consent on FHIR** (PCF) | Trial Implementation |
| Vorhandene Daten abfragen | **IHE QEDm**: Observation, Condition, AllergyIntolerance, MedicationStatement, Immunization | Trial Implementation |
| Impfungen, Schwangerschaft | **WHO SMART Guidelines**: Immunization DAK (Januar 2025), ANC DAK; FHIR Immunization, ImmunizationRecommendation | – |
| Rezepte | FHIR MedicationRequest, MedicationDispense; Wirkstoffe nach **WHO ATC** | R4 |
| Diagnosen und Gründe | **WHO ICD-11 MMS**, Arabisch und Englisch | aktuelle Ausgabe |
| Ereignisse an Systeme | **FHIR Subscriptions R5 Backport**: themenbasiert, rest-hook | 1.1 |
| Daten für berechtigte Partner | **FHIR Bulk Data Access** `$export` | 2.0 |
| Zahlen für das Ministerium | **DHIS2 Web API** (dataValueSets) oder **IHE ADX** | – |
| Prüfung in GitHub Actions | **Inferno**-Testkits für SMART App Launch und Bulk Data, dazu der HL7-Validator wie bisher | – |

## 4. Grundsätze

Alle Sicherheitsregeln aus Stufe 2 gelten weiter: standardmäßig verboten, außerhalb der Berechtigung 404, eine Prüfstelle `src/access.js`, jeder Zugriff auf klinische Inhalte im Protokoll. Neu dazu:

- **Keine Patientensuche, auch nicht über neue Standards.** IHE PDQm wird bewusst nicht gebaut.
- **Fremde Apps sehen nur, was der Patient beim Verbinden freigibt.** Unter „Verbundene Apps" im Konto sieht er jede App und trennt sie mit einem Tippen. Das wirkt sofort.
- **Software einer Einrichtung sieht nur die Daten dieser Einrichtung.** Wird die Einrichtung gesperrt, sind alle ihre Zugänge sofort wirkungslos.
- **Ereignisse an Systeme enthalten keine Gesundheitsdaten**, nur „etwas hat sich geändert" und die Kennung. Das System holt den Inhalt mit seinem eigenen Zugang.
- **Zahlen für Behörden sind Summen.** Werte unter 5 werden nicht gemeldet, damit niemand Einzelne erkennen kann.
- **Alles mit Gesundheitsdaten braucht `HEALTH_FILE=on`**, also die geprüfte Datenschutzerklärung.
- Jeder Teilschritt ist ein eigener Pull Request mit Tests. Nur neue Migrationen, ab `030`. Kein Umschreiben der Git-Historie.

## 5. Teilschritte

### 3.0 Fremde Apps anbinden · Größe M–L

**Ergebnis:** Ein Patient verbindet eine App, zum Beispiel die App eines Krankenhauses, und gibt frei, was sie lesen darf. Software von Kliniken und Laboren meldet sich mit einem Schlüsselpaar an.

**Bauteile:**
- `src/smart.js`: `/oauth/authorize` mit Anmeldung und Zustimmungsseite auf Arabisch und Englisch; `/oauth/token` zusätzlich mit `authorization_code`, `refresh_token` und `private_key_jwt`; `/.well-known/smart-configuration`; OpenID Connect mit `fhirUser`.
- Migration `030_smart_apps.sql`: Apps, Freigaben, Refresh-Tokens nur als Hash.
- Admin-Bereich: Apps eintragen mit Rücksprungadressen und Datenschutzerklärung der App.
- Seite „Verbundene Apps" im Konto.

**Scopes:** zuerst nur lesen, `patient/*.rs` auf die Ressourcen der Akte, für das eigene Profil und die Kinderprofile.

**Tests:** PKCE ist Pflicht; falsche Rücksprungadresse wird abgelehnt; der Patient kann weniger freigeben als angefragt; Trennen wirkt sofort; ein Token einer App öffnet nie die Akte eines anderen; das Inferno-Testkit für SMART App Launch ist grün.

### 3a Termine über Schnittstellen · Größe M

**Ergebnis:** Praxissoftware und andere Gesundheitsportale buchen freie Termine. Termine, die auf der Plattform gebucht werden, erscheinen in der Praxissoftware des Arztes. Das Verzeichnis lässt sich mit einem nationalen Register abgleichen.

**Bauteile:**
- `Appointment/$find`, `$hold` (Reservierung für 5 Minuten), `$book` und die Suche nach eigenen Terminen. Es gelten dieselben Regeln wie in der App: Grenzen pro Patient, keine Doppelbuchung dank Datenbank-Regel, nur freie Zeiten.
- HL7-v2-SIU-Nachrichten an die eingetragene Praxissoftware, über den Postausgang mit Wiederholung.
- SMART Scheduling Links: stündlich eine Liste freier Termine als NDJSON-Dateien für Suchportale.
- mCSD ITI-91: `_history` mit `_since`. Dafür speichert eine neue Tabelle jede Version der Verzeichniseinträge.

**Tests:** Eine Reservierung verfällt nach 5 Minuten; `$book` auf einen vergebenen Termin ergibt 409 mit OperationOutcome; jede SIU-Nachricht kommt genau einmal an; `_history` meldet gesperrte Einträge als gelöscht; die Praxissoftware sieht nur Termine ihres Arztes.

### 3b Überweisungen und Laboraufträge · Größe L

**Ergebnis:**
- Ein Arzt überweist an einen Facharzt oder beauftragt ein Labor in der App.
- Der Patient sieht den Auftrag und wählt Labor oder Facharzt, der Arzt kann einen vorschlagen. Für Patienten ohne Smartphone gibt es einen Zettel mit Auftragsnummer.
- Das Labor sieht den Auftrag. Der Befund geht automatisch zum Auftrag, zum anfordernden Arzt und in die Akte.
- Das Labor kann einen Befund korrigieren oder zurückziehen. Alle Empfänger sehen die Korrektur.

**Bauteile:** Migration für Aufträge und Aufgaben, `src/orders.js`, Seiten für Arzt (Auftrag anlegen mit Tests aus dem Katalog), Labor (Eingang, Status) und Patient (meine Aufträge).

**Schnittstellen:**
- ServiceRequest mit LOINC-Tests und ICD-11-Grund, Task mit dem Status angefragt, angenommen, in Arbeit, erledigt oder abgelehnt.
- HL7 v2 OML^O21 an die Laborsoftware, Antwort ORL^O22, Befund ORU^R01 mit der Auftragsnummer, nach dem IHE-Profil Laboratory Testing Workflow.
- Korrekturen als DiagnosticReport mit Status `corrected` oder `entered-in-error`, in HL7 v2 über den Befundstatus in OBR-25.

**Voraussetzung:** `HEALTH_FILE=on` und ein Pilotlabor mit Laborsoftware.

**Tests:** Ein Labor sieht nur Aufträge an sich; ein Befund ohne passenden Auftrag nimmt den bisherigen Weg; eine Korrektur ersetzt die alte Fassung sichtbar; ein Rückzug entfernt den Befund mit Hinweis aus der Akte; die Auftragsnummer wird nie geraten (zufällig, mit Prüfzeichen).

### 3c Patientenkurzakte und Teilen über Grenzen · Größe M

**Ergebnis:**
- Der Patient lädt seine Kurzakte als PDF auf Arabisch und Englisch und als FHIR-Dokument herunter.
- Er teilt sie per QR-Code mit jedem Arzt, auch im Ausland, ohne dass der Arzt ein Konto braucht. Der Link läuft ab, auf Wunsch mit PIN.
- Der Knopf „Meine Akte herunterladen" kommt dazu. Die Technik dafür (`$everything`) gibt es schon.

**Bauteile:**
- `Patient/$summary` nach IPS 2.0.1: Composition mit Medikamenten, Allergien, Problemen, Befunden und Impfungen.
- Patienten können Allergien und Dauerdiagnosen selbst eintragen (AllergyIntolerance, Condition mit ICD-11). Die Medikamenten-Erinnerungen werden zu MedicationStatement.
- SMART Health Links: verschlüsselte Datei, der Schlüssel steht im `#`-Teil des Links, mit Ablauf und Abrufprotokoll. Eine Ansichtsseite für Ärzte ohne Konto.
- Die bestehenden Freigaben werden zusätzlich nach IHE PCF beschrieben.

**Tests:** Das IPS-Dokument besteht den HL7-Validator mit den IPS-Profilen; ein abgelaufener Link ergibt 404; höchstens 5 Versuche für die PIN; jeder Abruf steht im Protokoll, das der Patient sieht.

### 3d Impfpass, Kinder und Schwangerschaft · Größe M

**Ergebnis:**
- Eltern führen den Impfpass ihrer Kinder und werden an fällige Impfungen erinnert, nach dem syrischen Impfkalender.
- Ärzte und Impfzentren tragen Impfungen ein. Der Eintrag zeigt, wer geimpft hat.
- Schwangere sehen ihre Vorsorgetermine nach der WHO-Empfehlung. Der Schwangerschaftsplaner auf syriahc.com verweist darauf.

**Schnittstellen:** Immunization und ImmunizationRecommendation nach dem WHO Immunization DAK; Observation für Gewicht, Größe und Blutdruck; Lesen nach IHE QEDm.

**Voraussetzung:** `HEALTH_FILE=on`; den Impfkalender bestätigt das Gesundheitsministerium.

**Tests:** Erinnerungen kommen einmal pro fälliger Impfung; selbst eingetragene und von Ärzten bestätigte Impfungen sind unterscheidbar; das Kinderprofil bleibt getrennt.

### 3e Elektronisches Rezept · Größe L, erst nach rechtlicher Klärung

**Ergebnis:** Der Arzt stellt ein Rezept aus. Der Patient hat es in der App und als QR-Zettel. Die Apotheke scannt es, gibt ab und markiert es als abgegeben. Ein Rezept lässt sich nur einmal einlösen. Die Medikamenten-Erinnerung lässt sich aus dem Rezept übernehmen.

**Schnittstellen:** MedicationRequest, MedicationDispense, Wirkstoffe nach WHO ATC, dazu die syrische Arzneimittelliste, falls verfügbar.

**Voraussetzung:** Klärung mit dem Gesundheitsministerium und der Apothekerkammer (نقابة الصيادلة).

### 3f Kodierung und Terminologie · Größe S–M

**Ergebnis:** Ärzte wählen Gründe und Diagnosen aus ICD-11 auf Arabisch oder Englisch. Andere Systeme können Codes nachschlagen und prüfen.

**Bauteile:**
- ICD-11 MMS als lokale Liste auf dem Server, nie als Anfrage an fremde Server mit Patientendaten.
- `CodeSystem/$lookup`, `ValueSet/$expand` mit Filter für die Suche beim Tippen, `$validate-code`, `ConceptMap/$translate` von den eigenen Katalog-Codes auf LOINC und ICD-11.
- Arabische Suche: Schreibvarianten werden gleich behandelt (أ إ آ ا, ة ه, ى ي), in der Arztsuche, der Einrichtungssuche und bei ICD-11.

**Tests:** `$expand` mit arabischem Filter findet Begriffe unabhängig von der Hamza; „احمد" findet „أحمد".

### 3g Ereignisse und Massenabruf · Größe M

**Bauteile:**
- **Subscriptions** nach dem R5 Backport: Themen wie „neuer Befund für meine Einrichtung", „Termin gebucht oder abgesagt", „Auftrag geändert", „Verzeichnis geändert". Zustellung per rest-hook, nur mit Kennung, signiert, über den Postausgang mit Wiederholung und Lebenszeichen.
- **Bulk Data** `$export`: das ganze Verzeichnis für Partner, die eigenen Daten einer Einrichtung für ihre Software. NDJSON-Dateien, nach 24 Stunden gelöscht, nur mit SMART Backend Services.

**Tests:** Ein Ereignis enthält nie Inhalte; eine fremde Einrichtung bekommt keine Ereignisse; das Inferno-Testkit für Bulk Data ist grün.

### 3h Zahlen für das Gesundheitswesen (DHIS2) · Größe S–M

**Ergebnis:** Monatlich gehen Summen pro Gouvernement an das DHIS2 des Gesundheitsministeriums: Termine nach Fachrichtung, Laboruntersuchungen nach Art, Blutspende-Aufrufe, eingetragene Einrichtungen.

**Bauteile:** Bericht als DHIS2 dataValueSets über die Web API, oder als ADX-Datei zum Herunterladen. Standardmäßig aus.

**Voraussetzung:** Vereinbarung mit dem Gesundheitsministerium.

**Tests:** Kein Wert zwischen 1 und 4 wird gemeldet; der Bericht enthält keine Namen, Nummern oder Kennungen.

### 3i Plattform stärker machen, ohne neue Standards

| Funktion | Nutzen | Größe |
|---|---|---|
| **Team-Zugänge** mit Rollen: Leitung, Empfang, Fachpersonal | Empfang verwaltet Termine, Laborpersonal stellt Befunde ein, ohne das Passwort der Leitung | M |
| **Konto selbst löschen**, in der App und als Webseite | Pflicht für Google Play, Recht auf Löschung | S |
| **Impressum** und Hinweis „ersetzt keinen Arztbesuch" | Pflicht für Betreiber in Deutschland und für Gesundheits-Apps in Google Play | S |
| **Android-App in Google Play** als Trusted Web Activity | Sichtbar im Store; braucht ein Google-Konto als Organisation | S |
| **Statistik für Einrichtungen**: Termine, Nichterscheinen, Bewertungen | Praxen und Labore sehen ihre Auslastung, ohne Personendaten | S |
| **Größerer Server** (4 GB statt 2 GB) | nötig, sobald Terminologie, Bulk-Export und Inferno-Prüfungen laufen | – |

## 6. Nicht in Stufe 3

- Röntgen- und CT-Bilder (DICOM, DICOMweb, IHE WIA): Stufe 4.
- HL7 v2 über MLLP (eigener Port): nur, wenn ein Pilotlabor es zwingend braucht.
- Abrechnung mit Versicherungen und Bezahlen in der App: später, nach rechtlicher Prüfung.
- Austausch mit EU-Systemen wie MyHealth@EU: nicht vorgesehen. Das Teilen durch den Patienten über IPS und SMART Health Links deckt den Bedarf ab.
- Suche nach Patienten über Name oder Telefon: nie.

## 7. Entscheidungen (mit Standard, damit die Arbeit weitergehen kann)

| # | Frage | Standard |
|---|---|---|
| 1 | Welche fremden Apps dürfen sich verbinden? | Nur Apps, die ein Admin eingetragen hat, jede mit eigener Datenschutzerklärung |
| 2 | Dürfen Patienten-Apps schreiben? | Nein, in 3.0 nur lesen |
| 3 | Wer wählt das Labor bei einem Auftrag? | Der Patient; der Arzt kann eines vorschlagen |
| 4 | ICD-11 oder SNOMED CT? | ICD-11: frei nutzbar und auf Arabisch. SNOMED CT nur nach Prüfung der Lizenz für Syrien |
| 5 | Impfkalender | Vom Gesundheitsministerium bestätigen lassen; bis dahin Einträge ohne Erinnerungen |
| 6 | Elektronisches Rezept | Erst nach Klärung mit Ministerium und Apothekerkammer |
| 7 | Gültigkeit eines SMART Health Links | 7 Tage, PIN empfohlen |
| 8 | Zahlen an DHIS2 | Nur mit Vereinbarung; Mindestwert 5 |
| 9 | Inhalt von Ereignissen an Systeme | Nur Kennungen, nie Inhalte |
| 10 | Rollen in Team-Zugängen | Leitung, Empfang, Fachpersonal |

## 8. Reihenfolge

1. **3i Pflichtteile** (Konto löschen, Impressum, Hinweis) und **3f** (Kodierung, arabische Suche): klein und Grundlage für alles Weitere.
2. **3.0** Fremde Apps: Grundlage für jede neue Schnittstelle.
3. **3a** Termine: ohne Gesundheitsdaten, kann sofort live.
4. **3i Team-Zugänge** und Google Play.
5. **3c** Kurzakte und **3d** Impfpass: sobald `HEALTH_FILE=on`.
6. **3b** Aufträge: mit einem Pilotlabor.
7. **3g** Ereignisse und Massenabruf: zusammen mit 3a und 3b, sobald ein Partner sie nutzt.
8. **3h** DHIS2: nach Vereinbarung mit dem Ministerium.
9. **3e** Rezept: nach rechtlicher Klärung.

Jeder Teilschritt geht erst live, wenn du zustimmst.

## 9. Quellen

- HL7 SMART App Launch 2.2: https://hl7.org/fhir/smart-app-launch/
- IHE ITI Scheduling: https://profiles.ihe.net/ITI/Scheduling/volume-1.html
- IHE mCSD ITI-91: https://profiles.ihe.net/ITI/mCSD/ITI-91.html
- HL7 IPS, Operation `$summary`: https://hl7.org/fhir/uv/ips/en/OperationDefinition-summary.html
- HL7 SMART Health Cards and Links, STU 1: https://hl7.org/fhir/uv/smart-health-cards-and-links
- WHO SMART Guidelines: https://smart.who.int/
- Syrien und DHIS2: https://dhis2.org/syria-workshop-health-system-april-2025/
- WHO zum syrischen Gesundheitsinformationssystem: https://www.emro.who.int/syria/news/who-welcomes-us-1-million-from-norway-to-strengthen-syrias-national-health-information-system.html
