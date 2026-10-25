/**
 * German texts. vue-i18n interprets { } @ | $; use these characters only
 * for placeholders.
 */
export default {
  app: {
    name: "KeeMan",
    tagline: "Selbst gehosteter Passwortmanager",
  },
  common: {
    cancel: "Abbrechen",
    retry: "Erneut versuchen",
    save: "Speichern",
    close: "Schließen",
    print: "Drucken",
    show: "Anzeigen",
    hide: "Verbergen",
    working: "Bitte warten…",
    reload: "Neu laden",
    understood: "Verstanden",
    edit: "Bearbeiten",
    delete: "Löschen",
    rename: "Umbenennen",
  },
  nav: {
    entries: "Einträge",
    home: "Datenbanken",
    account: "Konto",
    lock: "Sperren",
    logout: "Abmelden",
    main: "Hauptnavigation",
  },
  theme: {
    label: "Darstellung",
    system: "Wie System",
    light: "Hell",
    dark: "Dunkel",
  },
  language: {
    label: "Sprache",
    de: "Deutsch",
    en: "English",
  },
  footer: {
    source: "Quellcode",
    webclient: "Web-Client",
    server: "Server",
  },
  start: {
    loading: "Verbindung wird aufgebaut…",
    unreachableTitle: "Server nicht erreichbar",
    unreachableText:
      "Der KeeMan-Server antwortet gerade nicht. Prüfe die Verbindung und versuche es erneut.",
    configTitle: "Konfiguration ungültig",
    configText:
      "Die Datei config.json fehlt oder ist ungültig. Bitte die Administration informieren.",
    forbiddenTitle: "Konfigurationsfehler",
    forbiddenText:
      "Der Server lehnt diese Adresse ab (Origin nicht erlaubt). Bitte die Administration informieren.",
    versionTitle: "Server-Version nicht unterstützt",
    versionText: "Dieser Web-Client passt nicht zur Version des Servers.",
    cryptoTitle: "Kryptografie nicht verfügbar",
    cryptoText:
      "Der Browser konnte die Verschlüsselungsbibliothek nicht laden. Bitte einen aktuellen Browser verwenden.",
    integrityTitle: "Daten passen nicht zusammen",
    integrityText:
      "Der Server hat Kontodaten geliefert, die nicht zusammenpassen. Aus Sicherheitsgründen wurdest du abgemeldet. Bitte die Administration informieren.",
    toLogin: "Zur Anmeldung",
  },
  login: {
    title: "Anmelden",
    email: "E-Mail-Adresse",
    password: "Master-Passwort",
    submit: "Anmelden",
    busy: "Anmeldung läuft…",
    toRegister: "Neues Konto mit Einladung anlegen",
    expired: "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
    forgot: "Master-Passwort vergessen? Mit dem Recovery Key wiederherstellen",
  },
  secondFactor: {
    title: "Zweiter Faktor",
    totpLabel: "Code aus der Authenticator-App (6 Ziffern)",
    backupLabel: "Backup-Code",
    submit: "Bestätigen",
    busy: "Wird geprüft…",
    passkeyIntro:
      "Bestätige die Anmeldung mit deinem Passkey (z. B. Fingerabdruck, Gesichtserkennung oder Sicherheitsschlüssel).",
    usePasskeyNow: "Mit Passkey bestätigen",
    useTotp: "Code aus der Authenticator-App verwenden",
    usePasskey: "Passkey verwenden",
    useBackupCode: "Backup-Code verwenden",
    passkeyUnsupported:
      "Dieser Browser unterstützt keine Passkeys. Verwende einen Code oder einen anderen Browser.",
    expired:
      "Die Zeit für den zweiten Faktor ist abgelaufen. Bitte erneut anmelden.",
  },
  register: {
    title: "Konto anlegen",
    intro:
      "Alle Daten werden auf diesem Gerät verschlüsselt. Ohne Master-Passwort oder Recovery Key kann niemand sie lesen, auch der Server nicht.",
    inviteCode: "Einladungscode",
    email: "E-Mail-Adresse",
    password: "Master-Passwort",
    confirm: "Master-Passwort wiederholen",
    submit: "Konto anlegen",
    busy: "Konto wird angelegt…",
    retryInfo:
      "Die Verbindung wurde unterbrochen. Das Konto wurde möglicherweise schon angelegt. „Erneut versuchen“ sendet dieselbe Anfrage noch einmal.",
    abandon: "Abbrechen und neu beginnen",
    toLogin: "Bereits ein Konto? Anmelden",
  },
  recovery: {
    title: "Dein Recovery Key",
    intro:
      "Mit diesem Schlüssel kommst du an deine Daten, falls du das Master-Passwort vergisst. Er ist so mächtig wie dein Master-Passwort.",
    keep: "Drucke ihn aus oder schreibe ihn ab und bewahre ihn offline an einem sicheren Ort auf. Er wird nur jetzt angezeigt.",
    groups: "Recovery Key in 14 Gruppen",
    confirmLabel: "Letzte Gruppe zur Bestätigung eintippen",
    confirm: "Ich habe den Recovery Key gesichert",
    wrong:
      "Die eingegebene Gruppe stimmt nicht mit der letzten Gruppe überein.",
    leave:
      "Der Recovery Key ist noch nicht bestätigt. Seite wirklich verlassen?",
    saving: "Bestätigung wird gespeichert…",
  },
  unlock: {
    title: "Entsperren",
    intro: "Angemeldet als {email}",
    password: "Master-Passwort",
    submit: "Entsperren",
    busy: "Entsperre…",
    logout: "Abmelden",
    forgot:
      "Master-Passwort vergessen? Abmelden und mit dem Recovery Key wiederherstellen",
  },
  recover: {
    title: "Konto wiederherstellen",
    intro:
      "Mit dem Recovery Key setzt du ein neues Master-Passwort. Deine Daten bleiben erhalten.",
    email: "E-Mail-Adresse",
    key: "Recovery Key (14 Gruppen; Leerzeichen und Bindestriche werden ignoriert)",
    start: "Weiter",
    busy: "Wird geprüft…",
    passwordIntro: "Wähle ein neues Master-Passwort.",
    effects:
      "Danach sind alle anderen Geräte abgemeldet. Die Zwei-Faktor-Anmeldung bleibt bestehen.",
    password: "Neues Master-Passwort",
    confirm: "Neues Master-Passwort wiederholen",
    next: "Weiter zum neuen Recovery Key",
    preparing: "Schlüssel werden abgeleitet…",
    newKeyIntro:
      "Du bekommst einen neuen Recovery Key; der bisherige gilt nach dem Abschluss nicht mehr.",
    finish: "Recovery Key gesichert, Wiederherstellung abschließen",
    finishing: "Wird abgeschlossen…",
    retryInfo:
      "Die Verbindung wurde unterbrochen. Die Wiederherstellung ist möglicherweise schon abgeschlossen. „Erneut versuchen“ sendet dieselbe Anfrage noch einmal.",
    leave:
      "Die Wiederherstellung ist noch nicht abgeschlossen. Seite wirklich verlassen?",
    toLogin: "Zurück zur Anmeldung",
  },
  vaults: {
    settings: "Einstellungen",
    open: "In der Hauptansicht öffnen",
    icon: "Icon der Datenbank",
    iconDefault: "Standard-Icon",
    recycleBinEnabled: "Papierkorb verwenden",
    historyMaxItems: "Frühere Stände pro Eintrag (0–100)",
    title: "Datenbanken",
    defaultName: "Persönlich",
    recycleBin: "Papierkorb",
    loading: "Lädt…",
    unnamed: "(ohne Namen)",
    empty: "Du hast noch keine Datenbank. Lege unten eine an.",
    firstCreating: "Deine erste Datenbank wird angelegt…",
    firstFailed: "Die erste Datenbank konnte nicht angelegt werden.",
    create: "Neue Datenbank",
    createSubmit: "Datenbank anlegen",
    name: "Name",
    description: "Beschreibung",
    useColor: "Eigene Farbe",
    color: "Farbe",
    moveUp: "Nach oben",
    moveDown: "Nach unten",
    corrupt: "Beschädigte Objekte: {count}",
    keyRollback:
      "Darunter ist eine ältere Schlüsselversion der Datenbank: Was jetzt geschrieben würde, könnten entfernte Mitglieder lesen. Bestätige nur, wenn der Server aus einer Sicherung wiederhergestellt wurde.",
    rollback:
      "Der Server hat ältere Daten geliefert als zuletzt auf diesem Gerät gesehen. Die Datenbank ist schreibgeschützt, bis du bestätigst. Das kann ein Fehler oder ein Angriff auf den Server sein.",
    status: {
      loading: "Lädt…",
      error: "Diese Datenbank konnte nicht geladen werden.",
      corrupt:
        "Der Schlüssel dieser Datenbank lässt sich nicht entschlüsseln (beschädigt).",
    },
    connection: {
      online: "Verbunden",
      connecting: "Verbindet…",
      offline: "Nicht verbunden",
    },
    deleteTitle: "Datenbank löschen",
    deleteText:
      "Die Datenbank „{name}“ wird mit allen Gruppen und Einträgen endgültig gelöscht, auch für alle Mitglieder. Zum Bestätigen den Namen eintippen und das Master-Passwort eingeben.",
    deleteConfirmName: "Name der Datenbank",
    deletePassword: "Master-Passwort",
    deleteSubmit: "Endgültig löschen",
  },
  vault: {
    back: "Zurück zu den Datenbanken",
    readOnly: "Diese Datenbank ist schreibgeschützt.",
    notFound: "Diese Datenbank gibt es nicht (mehr).",
    corruptTitle: "Beschädigte Objekte",
    corruptText:
      "Diese Objekte ließen sich nicht entschlüsseln oder prüfen. Sie werden nicht verändert.",
    corruptItem: "{type} {id}: {reason}",
    icons: {
      title: "Eigene Icons",
      count: "{count} eigene Icons.",
      unused: "Davon unbenutzt: {count}.",
      blockedCorrupt:
        "Beschädigte Objekte könnten Icons verwenden; deshalb lassen sich gerade keine Icons entfernen.",
      remove: "Unbenutzte Icons entfernen",
      confirm:
        "{count} Icons, die kein Eintrag, keine Gruppe und kein früherer Stand verwendet, werden endgültig entfernt.",
      removeConfirm: "Entfernen",
      removed: "{count} Icons wurden entfernt.",
    },
    reasons: {
      no_key: "Schlüssel fehlt",
      no_data: "keine Daten",
      dropped: "bei einer Rotation verworfen",
      format: "ungültiges Format",
      auth: "Prüfsumme falsch",
      padding: "ungültiges Padding",
      encoding: "ungültige Kodierung",
      validation: "ungültiger Inhalt",
    },
  },
  main: {
    toolbar: "Werkzeuge",
    back: "Zurück",
    search: "Suchen",
    scope: "Suchbereich",
    scopes: {
      group: "Diese Gruppe",
      vault: "Diese Datenbank",
      all: "Alle Datenbanken",
    },
    includeTrash: "Papierkorb einbeziehen",
    newEntry: "Neuer Eintrag",
    newGroup: "Neue Gruppe",
    subgroups: "Einträge aus Untergruppen",
    detailBottom: "Details unten anzeigen",
    detailRight: "Details rechts anzeigen",
  },
  tree: {
    label: "Gruppen",
    menu: "Gruppe",
    unnamed: "(ohne Namen)",
    newName: "Neuer Name",
    orphan: "verwaist",
    cycle: "Zyklus",
    missingRoot: "Wurzelgruppe fehlt",
    rootName: "Wurzel",
    newGroup: "Neue Gruppe",
    newEntry: "Neuer Eintrag",
    properties: "Eigenschaften…",
    rename: "Umbenennen",
    move: "Verschieben nach…",
    up: "Nach oben",
    down: "Nach unten",
    delete: "Löschen",
    restore: "Wiederherstellen",
    deletePermanently: "Endgültig löschen",
    emptyBin: "Papierkorb leeren",
    database: "Einstellungen der Datenbank",
    repair: "Reparieren",
  },
  list: {
    label: "Einträge",
    results: "Suchergebnisse",
    icon: "Icon",
    columns: {
      totp: "TOTP",
      title: "Titel",
      username: "Benutzername",
      url: "URL",
      modified: "Geändert",
      path: "Pfad",
    },
    empty: "Keine Einträge in dieser Gruppe.",
    noResults: "Nichts gefunden.",
  },
  entry: {
    detail: "Details",
    none: "Kein Eintrag ausgewählt.",
    missing: "Diesen Eintrag gibt es nicht (mehr).",
    untitled: "(ohne Titel)",
    title: "Titel",
    username: "Benutzername",
    password: "Passwort",
    url: "URL",
    notes: "Notizen",
    tags: "Tags",
    expires: "Läuft ab",
    expired: "abgelaufen",
    fields: "Felder",
    icon: "Icon",
    metadata: "Verlauf",
    created: "Erstellt: {date}",
    modified: "Geändert: {date} von {name}",
    unknown: "unbekannt",
    me: "mir",
    member: "Mitglied {id}",
    show: "{field} anzeigen",
    hide: "{field} verbergen",
    copy: "{field} kopieren",
    edit: "Bearbeiten",
    details: "Details",
    history: "Historie ({count})",
    rollback:
      "Der Server hat eine ältere Fassung dieses Eintrags geliefert. Er ist schreibgeschützt, bis du die Warnung an der Datenbank bestätigst.",
    newerSchema:
      "Dieser Eintrag stammt von einer neueren Version und ist hier schreibgeschützt.",
    superseded:
      "Neuere Fassung beschädigt: Angezeigt wird die letzte gültige Fassung, schreibgeschützt. Die beschädigte steht in der Liste der beschädigten Objekte der Datenbank.",
    invalid:
      "Dieser Eintrag enthält {count} ungültige Elemente und ist schreibgeschützt.",
    removeInvalid: "Ungültige Elemente entfernen",
    removeInvalidText:
      "Die ungültigen Elemente werden aus dem Eintrag und seiner Historie entfernt. Das lässt sich nicht rückgängig machen.",
    reference: "Referenz",
    refWarning: {
      cycle: "Zirkelbezug: Ein Verweis führt im Kreis und bleibt stehen.",
      missing: "Ein Verweis zeigt auf keinen Eintrag dieser Datenbank.",
      too_complex:
        "Zu viele Verweise: Der Wert erscheint wie gespeichert, ohne sie aufzulösen.",
    },
  },
  totp: {
    label: "TOTP",
    copy: "TOTP-Code kopieren",
    copyNext: "Nächsten TOTP-Code kopieren",
    next: "Nächster:",
    remaining: "Noch {seconds} Sekunden gültig",
    unsupported:
      "{type} wird in dieser Version nicht unterstützt; der Wert bleibt erhalten.",
    invalid: "Die TOTP-Angabe ist ungültig; der Wert bleibt erhalten.",
    kinds: { hotp: "HOTP", steam: "Steam" },
  },
  url: {
    open: "URL öffnen",
    copy: "Aufgelöste URL kopieren",
    preview: "Aufgelöste URL",
    secret:
      "Die URL enthält ein Passwort oder einen geschützten Wert. Er landet im Browserverlauf und in den Server-Logs des Ziels.",
    missing:
      "Ein Platzhalter oder Verweis wurde nicht gefunden und bleibt unverändert stehen.",
    problem: {
      cycle:
        "Zirkelbezug: Die URL verweist auf sich selbst. Sie wird nicht geöffnet.",
      placeholder_in_scheme:
        "Das Schema der URL (etwa https) darf nicht aus einem Platzhalter stammen.",
      invalid_host:
        "Ein Wert im Hostnamen enthält Leerzeichen oder Trennzeichen einer URL.",
      invalid_url: "Die aufgelöste URL ist ungültig und wird nicht geöffnet.",
      too_complex:
        "Zu viele Verweise: Die URL wird nicht aufgelöst und nicht geöffnet.",
      scheme_forbidden:
        "Dieses Schema wird aus Sicherheitsgründen nie geöffnet. Kopieren geht trotzdem.",
      scheme_not_allowed:
        "Dieses Schema ist nicht erlaubt. Erlaubte Schemata legst du in den Einstellungen fest.",
    },
  },
  history: {
    label: "Frühere Stände",
    empty: "Noch keine früheren Stände.",
    conflict: "Konflikt",
    unreadable: "Dieser Stand ist nicht lesbar.",
    restore: "Diesen Stand wiederherstellen",
    notRestorable: "Dieser Stand stammt von einer neueren Version.",
    restoreTitle: "Stand wiederherstellen",
    restoreText:
      "Der Stand vom {date} wird der aktuelle. Der jetzige Stand bleibt in der Historie.",
  },
  attachments: {
    title: "Anhänge",
    none: "Noch keine Anhänge.",
    unnamed: "(ohne Namen)",
    preview: "Vorschau",
    download: "{name} herunterladen",
    remove: "{name} entfernen",
    add: "Dateien hinzufügen",
    hint: "Ablegen oder auswählen; höchstens {size} pro Datei und {count} Anhänge pro Eintrag. Dateien werden sofort verschlüsselt hochgeladen und mit dem Eintrag gespeichert.",
    hintNoLimit:
      "Ablegen oder auswählen; höchstens {count} Anhänge pro Eintrag. Dateien werden sofort verschlüsselt hochgeladen und mit dem Eintrag gespeichert.",
    uploading: "{name} wird hochgeladen",
    waiting: "Speichern ist möglich, sobald alle Uploads fertig sind.",
  },
  editor: {
    new: "Neuer Eintrag",
    edit: "Eintrag bearbeiten",
    tabs: {
      general: "Allgemein",
      totp: "TOTP",
      fields: "Felder",
      attachments: "Anhänge",
      icon: "Icon",
    },
    leave: "Deine Änderungen sind noch nicht gespeichert. Trotzdem verlassen?",
    addTag: "Tag hinzufügen",
    removeTag: "Tag {tag} entfernen",
    fieldName: "Feldname",
    fieldValue: "Wert {name}",
    protected: "geschützt",
    fieldUp: "Feld {name} nach oben",
    fieldDown: "Feld {name} nach unten",
    fieldRemove: "Feld {name} entfernen",
    addField: "Feld hinzufügen",
    iconDefault: "Standard der Gruppe",
    problems: {
      field_name_empty: "Der Feldname fehlt.",
      field_name_too_long: "Der Feldname ist länger als 128 Zeichen.",
      field_name_reserved:
        "Dieser Name ist reserviert (Titel, Benutzername, Passwort, URL, Notizen, otp).",
      field_name_duplicate: "Diesen Feldnamen gibt es schon.",
      too_many_fields: "Höchstens 100 Felder.",
      too_many_attachments: "Höchstens 50 Anhänge pro Eintrag.",
      tag_invalid:
        "Tags dürfen nicht leer sein, kein Komma oder Semikolon enthalten und höchstens 128 Zeichen lang sein.",
      tag_duplicate: "Diesen Tag gibt es schon.",
      expires_invalid: "Das Ablaufdatum ist ungültig.",
      otp_invalid: "Die TOTP-Angabe ist ungültig.",
      otp_unsupported:
        "HOTP und Steam werden in dieser Version nicht unterstützt.",
      otp_migration:
        "Exporte aus dem Google Authenticator werden in dieser Version nicht unterstützt.",
    },
  },
  totpEditor: {
    none: "Für diesen Eintrag ist kein TOTP eingerichtet.",
    current: "{type}, {count} Stellen, {seconds} s",
    compare: "Vergleiche den Code mit dem Dienst, bevor du speicherst.",
    remove: "TOTP entfernen",
    uriTitle: "URI einfügen",
    uri: "otpauth-URI",
    apply: "Übernehmen",
    qrTitle: "QR-Code",
    qrFile: "Bild mit QR-Code wählen",
    qrHint:
      "Oder ein Bild hier ablegen oder mit Strg+V einfügen (z. B. einen Screenshot).",
    reading: "QR-Code wird gelesen…",
    noQr: "In diesem Bild wurde kein QR-Code gefunden.",
    badImage: "Dieses Bild lässt sich nicht lesen.",
    migration:
      "Exporte aus dem Google Authenticator (otpauth-migration) werden in dieser Version nicht unterstützt. Bitte den QR-Code des Dienstes selbst verwenden.",
    manualTitle: "Manuell",
    secret: "Secret (Base32)",
    advanced: "Erweitert",
    algorithm: "Algorithmus",
    digits: "Stellen (6–8)",
    period: "Periode in Sekunden (15–300)",
    problems: {
      not_otpauth: "Das ist keine otpauth-URI für TOTP.",
      secret: "Das Secret ist kein gültiges Base32.",
      algorithm:
        "Der Algorithmus wird nicht unterstützt (SHA1, SHA256, SHA512).",
      digits:
        "Die Stellenzahl muss zwischen 6 und 8 liegen, die Periode zwischen 15 und 300 Sekunden.",
      period: "Die Periode muss zwischen 15 und 300 Sekunden liegen.",
    },
  },
  generator: {
    title: "Passwortgenerator",
    open: "Passwort erzeugen",
    again: "Neu erzeugen",
    bits: "Stärke: {bits} Bit",
    short: "Kürzer als 12 Zeichen ist schwach.",
    mode: "Art",
    chars: "Zeichen",
    words: "Passphrase",
    length: "Länge",
    classes: "Zeichenklassen",
    symbols: "Sonderzeichen",
    lookalikes: "Verwechselbare Zeichen ausschließen",
    wordCount: "Anzahl Wörter",
    separator: "Trennzeichen",
    capitalize: "Wörter groß beginnen",
    invalid: "Diese Einstellungen sind ungültig.",
    use: "Übernehmen",
    saveDefault: "Als Standard speichern",
    saved: "Als Standard gespeichert.",
  },
  groupDialog: {
    new: "Neue Gruppe",
    edit: "Eigenschaften der Gruppe",
    name: "Name",
    icon: "Icon",
    defaultEntryIcon: "Icon für neue Einträge",
    inherit: "Von der Elterngruppe",
  },
  moveDialog: {
    title: "Verschieben nach…",
    target: "Ziel",
    move: "Verschieben",
    acrossTitle: "In eine andere Datenbank verschieben",
    across:
      "Die Einträge werden in der anderen Datenbank neu angelegt und hier gelöscht.",
    acrossShared:
      "Die Einträge werden in der anderen Datenbank neu angelegt und hier gelöscht. Alle Mitglieder dieser Datenbank sehen sie dann samt Historie.",
    brokenRefs:
      "Verweise zwischen verschobenen und übrigen Einträgen funktionieren danach nicht mehr (betroffene Einträge: {count}).",
  },
  kdbx: {
    title: "KDBX (KeePass)",
    field: "Feld",
    import: {
      title: "KDBX-Datei importieren",
      titleGroup: "KDBX-Datei in eine Gruppe importieren",
      intro:
        "Eine Datenbank aus KeePass oder KeePassXC als neue Datenbank übernehmen.",
      openDialog: "KDBX importieren…",
      openGroupDialog: "In eine Gruppe importieren…",
      file: "KDBX-Datei",
      password: "Passwort der Datei",
      keyFile: "Schlüsseldatei (optional)",
      open: "Öffnen",
      opening: "Die Datei wird geöffnet…",
      slow: "Die Datei verlangt für Argon2 {size} MiB Speicher; das Öffnen kann länger dauern.",
      version: "KDBX {version}",
      name: "Name der neuen Datenbank",
      group: "Zielgruppe",
      start: "Importieren",
      progress: "{count} von {entries} Objekten geschrieben ({value} %)",
      failed:
        "Der Import wurde unterbrochen. Bereits geschriebene Daten bleiben erhalten.",
      cancelled:
        "Der Import wurde abgebrochen. Bereits geschriebene Daten bleiben erhalten.",
      resume: "Fortsetzen",
      deleteNew: "Neue Datenbank löschen",
      done: "Der Import ist abgeschlossen.",
      openResult: "Öffnen",
    },
    export: {
      title: "Als KDBX exportieren",
      openDialog: "Als KDBX exportieren…",
      warning:
        "Die Datei enthält alle Passwörter dieser Datenbank und ist nur durch das Export-Passwort geschützt. Verwende nicht dein Master-Passwort und bewahre die Datei sicher auf.",
      password: "Export-Passwort",
      confirm: "Export-Passwort wiederholen",
      submit: "Exportieren",
      working: "Die Datei wird erzeugt und geprüft…",
      done: "„{name}“ wurde erzeugt, geprüft und heruntergeladen.",
      again: "Erneut herunterladen",
      substituteRoot:
        "Die Wurzelgruppe fehlte; die Datei enthält eine Ersatz-Wurzel.",
      corrupt: "{count} beschädigte Objekte wurden nicht exportiert.",
      removedCharacters:
        "{count} Zeichen, die in XML nicht erlaubt sind, wurden entfernt.",
      attachment_unreadable:
        "{where}: Anhang „{name}“ ließ sich nicht laden und fehlt in der Datei.",
      attachment_renamed: "{where}: Anhang „{from}“ heißt in der Datei „{to}“.",
      loading: "Anhänge werden geladen: {count} von {entries}…",
      snapshots_skipped:
        "{where}: {count} unlesbare frühere Stände übersprungen.",
      custom_icon_missing:
        "{where}: eigenes Icon fehlt oder ist beschädigt; Standard-Icon exportiert.",
    },
    report: {
      top: "oberste Ebene",
      willImport:
        "Es werden {groups} Gruppen und {entries} Einträge importiert.",
      imported: "{groups} Gruppen und {entries} Einträge wurden importiert.",
      skippedBin:
        "Papierkorb der Datei übersprungen: {groups} Gruppen, {entries} Einträge.",
      newIds: "{count} Objekte ohne oder mit doppelter UUID bekamen neue IDs.",
      conflicts:
        "{count} Objekte bekamen neue IDs, weil es sie im Ziel schon gab; Verweise wurden angepasst.",
      extraRoots:
        "{count} weitere Gruppen der obersten Ebene stehen unter der Wurzel.",
      descriptionTruncated: "Die Beschreibung der Datenbank wurde gekürzt.",
      notes: "Hinweise",
      field_renamed: "{where}: Feld „{from}“ heißt jetzt „{to}“.",
      fields_skipped: "{where}: mehr als 100 Felder, übersprungen: {names}",
      entry_skipped: "{where}: größer als 1 MiB, übersprungen.",
      tags_truncated: "{where}: Tags auf 128 Zeichen gekürzt.",
      history_trimmed: "{where}: {count} ältere Stände verworfen.",
      group_truncated: "{where}: Gruppe zu groß, Notizen gekürzt.",
      attachment_too_large:
        "{where}: Anhang „{name}“ ist größer, als der Server erlaubt, und wurde übersprungen.",
      attachments_skipped:
        "{where}: mehr als 50 Anhänge, übersprungen: {names}",
      willUpload: "Dazu werden {count} Anhänge hochgeladen.",
      uploaded: "{count} Anhänge wurden hochgeladen.",
      custom_icon_unreadable:
        "{where}: eigenes Icon ließ sich nicht lesen, Standard-Icon verwendet.",
      custom_icon_unreadable_group:
        "{where}: eigenes Icon der Gruppe ließ sich nicht lesen, Standard-Icon verwendet.",
      willAddIcons: "Dazu werden {count} eigene Icons übernommen.",
      addedIcons: "{count} eigene Icons wurden übernommen.",
      otp_kept:
        "{where}: OTP ({problem}) unverändert übernommen; diese Version zeigt dafür keinen Code.",
      otp_unconverted:
        "{where}: OTP-Angaben nicht umwandelbar, als Felder übernommen: {names}",
      notTaken: "Nicht übernommen",
      alwaysIgnored:
        "Immer ignoriert: Zugriffszeiten, Nutzungszähler, Gruppeneinstellungen und Einstellungen der Datei.",
    },
    otpProblem: {
      hotp: "HOTP",
      steam: "Steam",
      not_otpauth: "nicht lesbar",
      secret: "Secret ungültig",
      algorithm: "Algorithmus ungültig",
      digits: "Stellenzahl ungültig",
      period: "Periode ungültig",
    },
    ignored: {
      autoType: "Auto-Type ({count})",
      customData: "Zusatzdaten von Programmen ({count})",
      colors: "Farben ({count})",
      overrideUrl: "Override-URL ({count})",
      qualityCheck: "Qualitätsprüfung abgeschaltet ({count})",
      groupSettings: "Gruppeneinstellungen ({count})",
      deletedObjects: "Liste gelöschter Objekte ({count})",
      publicCustomData: "Öffentliche Kopfdaten ({count})",
    },
  },
  deleteDialog: {
    title: "Endgültig löschen",
    text: "{groups} Gruppen und {entries} Einträge werden endgültig gelöscht. Das lässt sich nicht rückgängig machen.",
    emptyBin:
      "Alles im Papierkorb wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.",
  },
  shortcuts: {
    title: "Tastenkürzel",
    search: "Suchen",
    clearSearch: "Suche leeren",
    area: "Bereich wechseln",
    newEntry: "Neuer Eintrag",
    edit: "Eintrag bearbeiten",
    delete: "Löschen",
    rename: "Gruppe umbenennen",
    copyPassword: "Passwort kopieren",
    copyUsername: "Benutzername kopieren",
    copyUrl: "URL kopieren",
    openUrl: "URL öffnen",
    copyTotp: "TOTP-Code kopieren",
    lock: "Sperren",
    help: "Diese Übersicht",
    keys: {
      Enter: "Enter",
      Delete: "Entf",
      Backspace: "Rücktaste",
      Escape: "Esc",
      F2: "F2",
      F6: "F6",
    },
  },
  clipboard: {
    copied: "Kopiert.",
    copiedClears: "Kopiert. Wird in {seconds} s geleert.",
    cleared: "Zwischenablage geleert.",
    clearOnAction:
      "Der Browser erlaubt das Leeren gerade nicht. Die Zwischenablage wird beim nächsten Klick oder Tastendruck hier geleert.",
    failed: "Kopieren war nicht möglich.",
  },
  icons: {
    search: "Icons durchsuchen",
    custom: "Eigene Icons",
    builtin: "Eingebaute Icons",
    unnamed: "Ohne Namen",
    upload: "Bild hochladen…",
    faviconUrl: "Adresse der Website für das Favicon",
    faviconPlaceholder: "https://www.example.com",
    fetchFavicon: "Favicon abrufen",
    faviconHint:
      "Der Server ruft das Favicon ab und erfährt dabei die Adresse der Website (nur Schema, Host und Port).",
    working: "Das Icon wird verarbeitet…",
  },
  notice: {
    entry_conflict:
      "Jemand hat dieselben Felder gleichzeitig geändert ({field}). Deine Fassung steht in der Historie (Konflikt).",
    discarded:
      "Deine Änderung an „{field}“ wurde verworfen, weil sie gleichzeitig auf einem anderen Gerät geändert wurde (verworfen: {value}).",
    deleted_meanwhile:
      "Das Objekt wurde inzwischen auf einem anderen Gerät gelöscht; deine Änderung wurde verworfen.",
    changed_meanwhile:
      "Das Objekt wurde inzwischen auf einem anderen Gerät geändert und deshalb nicht gelöscht. Bitte prüfen und erneut löschen.",
    exists: "Ein Objekt mit dieser ID gibt es bereits; nichts wurde angelegt.",
  },
  deleteAccount: {
    title: "Konto löschen",
    intro:
      "Das Konto wird endgültig gelöscht. Datenbanken, die nur dir gehören, werden mit allen Daten gelöscht; aus gemeinsamen Datenbanken trittst du aus.",
    deleted: "Diese Datenbanken werden gelöscht:",
    left: "Aus diesen Datenbanken trittst du aus:",
    none: "Keine.",
    email: "Zum Bestätigen deine E-Mail-Adresse",
    password: "Master-Passwort",
    submit: "Konto endgültig löschen",
    done: "Dein Konto wurde gelöscht.",
  },
  account: {
    title: "Konto",
    nav: "Kontobereiche",
    password: "Master-Passwort",
    kdf: "Schlüsselableitung",
    recovery: "Recovery Key",
    twoFactor: "Zwei-Faktor",
    sessions: "Sitzungen",
    settings: "Einstellungen",
    about: "Über KeeMan",
    contacts: "Kontakte",
    delete: "Konto löschen",
  },
  password: {
    title: "Master-Passwort ändern",
    intro:
      "Nach dem Wechsel werden alle anderen Sitzungen abgemeldet. Deine Daten bleiben unverändert.",
    current: "Aktuelles Master-Passwort",
    new: "Neues Master-Passwort",
    confirm: "Neues Master-Passwort wiederholen",
    submit: "Passwort ändern",
    busy: "Passwort wird geändert…",
    done: "Das Master-Passwort wurde geändert.",
  },
  rules: {
    too_short: "Mindestens 12 Zeichen.",
    too_weak:
      "Zu leicht zu erraten. Länger machen oder mehrere zufällige Wörter verwenden.",
    mismatch: "Die Wiederholung stimmt nicht überein.",
    unchanged: "Das neue Passwort muss sich vom alten unterscheiden.",
    malformed: "Das Passwort enthält ungültige Zeichen.",
    outerSpace:
      "Hinweis: Das Passwort beginnt oder endet mit einem Leerzeichen.",
    loading: "Bewertung wird geladen…",
    unavailable: "Die Passwortbewertung konnte nicht geladen werden.",
    strength: "Stärke",
    score0: "sehr schwach",
    score1: "schwach",
    score2: "mittel",
    score3: "stark",
    score4: "sehr stark",
  },
  kdf: {
    title: "Schlüsselableitung (KDF)",
    intro:
      "Höhere Werte machen das Erraten deines Master-Passworts teurer, verlangsamen aber auch das Entsperren auf allen Geräten.",
    current: "Aktuell: {ops} Durchläufe, {mem} MiB",
    preset: "Voreinstellung",
    presetStandard: "Standard (3 / 64 MiB)",
    presetStrong: "Stark (4 / 128 MiB)",
    presetVeryStrong: "Sehr stark (4 / 256 MiB)",
    presetCustom: "Eigene Werte",
    ops: "Durchläufe (2–10)",
    mem: "Speicher in MiB (19–1024)",
    warnHigh: "Über 256 MiB kann das Entsperren auf Mobilgeräten scheitern.",
    confirmLower:
      "Die Werte sinken. Ich weiß, dass das die Sicherheit verringert.",
    invalid: "Werte außerhalb des erlaubten Bereichs.",
    password: "Master-Passwort zur Bestätigung",
    submit: "Parameter ändern",
    busy: "Parameter werden geändert…",
    done: "Die Parameter wurden geändert.",
    weakerTitle: "Schwächere Schlüsselableitung",
    weakerText:
      "Die Schlüsselableitung ist schwächer als zuletzt auf diesem Gerät ({old} → {new}). Wenn du das nicht selbst geändert hast, erhöhe die Werte jetzt.",
    raise: "Erhöhen",
    understood: "Verstanden",
  },
  renew: {
    title: "Recovery Key neu erzeugen",
    intro:
      "Der alte Recovery Key bleibt gültig, bis du den neuen bestätigt hast. Danach funktioniert nur noch der neue.",
    password: "Master-Passwort",
    start: "Neuen Recovery Key erzeugen",
    busy: "Wird vorbereitet…",
    commit: "Neuen Recovery Key aktivieren",
    committing: "Wird aktiviert…",
    done: "Der neue Recovery Key ist aktiv.",
    reauth:
      "Die Bestätigung ist abgelaufen. Bitte das Master-Passwort erneut eingeben.",
  },
  twoFactor: {
    title: "Zwei-Faktor-Anmeldung",
    recommend:
      "Du hast noch keinen zweiten Faktor. Mit TOTP oder einem Passkey reicht ein gestohlenes Master-Passwort allein nicht zur Anmeldung.",
    on: "aktiv",
    off: "aus",
    totp: "Authenticator-App (TOTP)",
    totpIntro:
      "Eine App wie KeePassXC, Aegis oder Google Authenticator erzeugt alle 30 Sekunden einen Code.",
    setup: "TOTP einrichten",
    disable: "TOTP ausschalten",
    passkeys: "Passkeys",
    passkeysIntro:
      "Ein Passkey bestätigt die Anmeldung per Fingerabdruck, Gesichtserkennung, PIN oder Sicherheitsschlüssel (höchstens 10).",
    addPasskey: "Passkey hinzufügen",
    passkeyName: "Name des Passkeys",
    passkeyDates: "angelegt {date}, zuletzt verwendet: {value}",
    never: "nie",
    remove: "Entfernen",
    passkeyUnsupported: "Dieser Browser unterstützt keine Passkeys.",
    codesTitle: "Backup-Codes",
    codesLeft: "Verbleibende Backup-Codes",
    codesAbout:
      "Jeder Backup-Code ersetzt einmal den zweiten Faktor, falls du dein Gerät verlierst.",
    codesIntro:
      "Mit diesen Codes meldest du dich an, wenn TOTP oder Passkey nicht verfügbar sind. Jeder Code gilt einmal.",
    codesKeep:
      "Drucke sie aus oder schreibe sie ab und bewahre sie sicher auf. Sie werden nur jetzt angezeigt.",
    codesSaved: "Ich habe die Codes gesichert",
    regenerate: "Neue Backup-Codes erzeugen",
    password: "Master-Passwort",
    continue: "Weiter",
    confirmSetup: "Bestätige mit deinem Master-Passwort, um TOTP einzurichten.",
    confirmDisable:
      "Bestätige mit deinem Master-Passwort, um TOTP auszuschalten.",
    confirmCodes:
      "Neue Backup-Codes ersetzen alle bisherigen. Bestätige mit deinem Master-Passwort.",
    confirmPasskey:
      "Gib dem Passkey einen Namen und bestätige mit deinem Master-Passwort. Danach fragt der Browser nach dem Passkey.",
    confirmRemove:
      "Passkey „{name}“ entfernen? Bestätige mit deinem Master-Passwort.",
    lastFactor:
      "Das ist dein letzter zweiter Faktor. Danach verfallen auch die Backup-Codes.",
    setupTitle: "TOTP einrichten",
    setupIntro:
      "Scanne den QR-Code mit deiner Authenticator-App oder gib das Secret von Hand ein. Bestätige danach mit dem ersten Code.",
    qrLabel: "QR-Code für die Authenticator-App",
    secretLabel: "Secret zum Eintippen:",
    codeLabel: "Code aus der App (6 Ziffern)",
    enable: "TOTP aktivieren",
    totpEnabled: "TOTP ist aktiv.",
    totpDisabled: "TOTP ist ausgeschaltet.",
    passkeyAdded: "Der Passkey wurde hinzugefügt.",
    passkeyRemoved: "Der Passkey wurde entfernt.",
    leave:
      "Das Secret oder die Backup-Codes werden nur jetzt angezeigt. Seite wirklich verlassen?",
  },
  sessions: {
    title: "Sitzungen",
    intro: "Geräte, auf denen dein Konto angemeldet ist.",
    current: "Dieses Gerät",
    created: "Angemeldet",
    lastSeen: "Zuletzt aktiv",
    ip: "Netzwerk",
    unknownIp: "unbekannt",
    revoke: "Abmelden",
    revokeOthers: "Alle anderen abmelden",
    empty: "Keine weiteren Sitzungen.",
  },
  settings: {
    clipboard: "Zwischenablage nach dem Kopieren leeren",
    clipboardOff: "nie",
    clipboardAfter: "nach Sekunden",
    clipboardSeconds: "Sekunden",
    searchProtected: "Geschützte Felder durchsuchen",
    showTotpColumn: "TOTP-Spalte in der Eintragsliste anzeigen",
    urlSchemes: "Erlaubte URL-Schemata (kommagetrennt)",
    urlSchemesHint:
      "Diese Schemata öffnet KeeMan, zum Beispiel http, https, ssh, rdp. Nie erlaubt: {names}.",
    urlSchemesInvalid:
      "Jedes Schema beginnt mit einem Buchstaben und enthält nur Buchstaben, Ziffern und + . - ; keines doppelt. Nie erlaubt: {names}.",
    generatorHint:
      "Die Standardwerte des Passwortgenerators speicherst du im Generator mit „Als Standard speichern“.",
    title: "Einstellungen",
    autoLock: "Automatisch sperren nach Inaktivität (Minuten)",
    lockOnHidden: "Sperren, wenn der Tab versteckt ist",
    lockOnHiddenOff: "nie",
    lockOnHiddenNow: "sofort",
    lockOnHiddenAfter: "nach Minuten",
    lockOnHiddenMinutes: "Minuten",
    language: "Sprache",
    languageDevice: "Wie Gerät",
    saved: "Gespeichert.",
    corrupt:
      "Deine Kontodaten (Einstellungen, Kontakte) konnten nicht gelesen werden. Sie sind schreibgeschützt.",
    readOnly:
      "Deine Kontodaten stammen von einer neueren Version und sind hier schreibgeschützt.",
    reset: "Kontodaten zurücksetzen",
    resetConfirm:
      "Zum Zurücksetzen „ZURÜCKSETZEN“ eintippen. Einstellungen und Kontakte gehen verloren.",
    resetWord: "ZURÜCKSETZEN",
    device: "Dieses Gerät",
  },
  about: {
    thirdParty: "Werke Dritter",
    lucide: "Icons: Lucide, ISC-Lizenz, © 2026 Lucide Icons and Contributors.",
    eff: "Passphrasen: „EFF Long Wordlist“ der Electronic Frontier Foundation, CC BY 3.0 US, ohne die vier Wörter mit Bindestrich.",
    kdbx: "KDBX-Dateien: kdbxweb (© 2021 Antelle), fflate (© 2020 Arjun Barrett), xmldom (© 2019 Christopher J. Brody und andere, © 2012–2017 jindw und andere), hash-wasm (© 2020 Dani Biró), jeweils MIT-Lizenz; kdbxweb geändert.",
    jsqr: "QR-Codes: jsQR von Cosmo Wolfe und Mitwirkenden, Apache License 2.0.",
    qrcode:
      "QR-Code-Anzeige: QR Code Generator von Kazuhiko Arase, MIT-Lizenz.",
    title: "Über KeeMan",
    text: "KeeMan ist freie Software unter der GNU Affero General Public License v3.0 oder später.",
    version: "Version {version} ({commit})",
  },
  contacts: {
    title: "Kontakte",
    intro:
      "Datenbanken teilst du mit verifizierten Kontakten. Vergleiche Fingerprints immer auf einem zweiten Weg, etwa persönlich oder am Telefon.",
    ownFingerprint: "Dein Fingerprint",
    ownHint:
      "Diesen Fingerprint nennst du Personen, die dich als Kontakt prüfen.",
    check: "Kontakt prüfen",
    email: "E-Mail-Adresse",
    checkSubmit: "Prüfen",
    empty: "Noch keine verifizierten Kontakte.",
    verifiedAt: "Geprüft am {date}",
    conflict: "Konflikt – erneut prüfen",
    recheck: "Erneut prüfen",
    remove: "Entfernen",
    removeTitle: "Kontakt entfernen",
    removeText:
      "„{email}“ gilt danach als nicht geprüft. Gemeinsame Datenbanken bleiben bestehen; vor dem nächsten Teilen vergleichst du den Fingerprint erneut.",
    readOnly:
      "Deine Kontodaten sind schreibgeschützt oder beschädigt; Kontakte lassen sich gerade nicht ändern.",
  },
  fingerprint: {
    title: "Fingerprint vergleichen",
    intro: {
      invite:
        "Bevor du {email} einlädst, vergleicht die Fingerprints auf einem zweiten Weg (persönlich oder am Telefon).",
      accept:
        "Bevor du die Einladung von {email} annimmst, vergleicht die Fingerprints auf einem zweiten Weg.",
      key: "{email} hat den Schlüssel einer gemeinsamen Datenbank erneuert. Vergleicht die Fingerprints, bevor du den neuen Schlüssel annimmst.",
      rotation:
        "{email} bekommt den neuen Schlüssel. Vergleicht vorher die Fingerprints auf einem zweiten Weg.",
      contact:
        "Vergleiche die Fingerprints mit {email} auf einem zweiten Weg (persönlich oder am Telefon).",
    },
    own: "Dein Fingerprint",
    other: "Fingerprint von {email}",
    changed:
      "Achtung: Der Schlüssel dieses Kontos hat sich geändert. Bestätige nur, wenn ihr den neuen Fingerprint gerade verglichen habt.",
    conflict:
      "Achtung: Zu diesem Kontakt gibt es widersprüchliche Angaben. Bestätige nur nach einem erneuten Vergleich.",
    confirm: "Stimmt überein",
    readOnly:
      "Deine Kontodaten sind schreibgeschützt oder beschädigt; die Bestätigung kann nicht gespeichert werden.",
  },
  members: {
    title: "Mitglieder",
    me: "ich",
    owner: "Eigentümer",
    member: "Mitglied",
    pending: "eingeladen",
    status: {
      verified: "verifiziert",
      unverified: "nicht geprüft",
      changed: "Schlüssel geändert",
      conflict: "Konflikt",
    },
    inviteEmail: "E-Mail-Adresse",
    inviteSubmit: "Einladen",
    invited: "Die Einladung an {email} ist verschickt.",
    withdraw: "Zurückziehen",
    makeOwner: "Zum Eigentümer machen",
    makeMember: "Zum Mitglied machen",
    remove: "Entfernen",
    renewKey: "Schlüssel erneuern",
    leave: "Austreten",
    leaveTitle: "Datenbank verlassen",
    leaveText:
      "Du verlierst den Zugriff auf „{name}“. Ein Eigentümer erneuert danach den Schlüssel.",
    keyPending:
      "Ein neuer Schlüssel für diese Datenbank wartet auf deine Prüfung.",
    keyCheck: "Prüfen",
    keyMissing:
      "Für diese Datenbank fehlt der aktuelle Schlüssel. Bitte einen Eigentümer, den Schlüssel zu erneuern.",
    keyInvalid:
      "Der neue Schlüssel dieser Datenbank ist ungültig und wurde nicht angenommen. Das kann ein Fehler oder ein Angriff auf den Server sein.",
    rotationRequired:
      "Ein Mitglied ist ausgetreten. Erneuere den Schlüssel, damit es neue Änderungen nicht mehr lesen kann.",
    loading: "Lädt…",
  },
  rotation: {
    title: "Schlüssel erneuern",
    loading: "Die Datenbank wird vollständig geladen…",
    explain:
      "Alle Einträge werden mit einem neuen Schlüssel verschlüsselt. Entfernte Mitglieder können danach keine neuen oder geänderten Einträge mehr lesen. Was sie schon gesehen haben, behalten sie – auch die Schlüssel der Anhänge, denn Anhänge werden nicht neu verschlüsselt. Ändere deshalb wichtige Passwörter.",
    recipients: "Wer den neuen Schlüssel bekommt",
    none: "Außer dir hat niemand Zugriff.",
    remove: "Entfernen",
    discard: "Einladung verwerfen",
    check: "Prüfen",
    corruptTitle: "Beschädigte Objekte",
    corruptText:
      "Diese Objekte lassen sich nicht neu verschlüsseln. Sie werden bei der Erneuerung verworfen.",
    corruptConfirm: "Beschädigte Objekte verwerfen",
    run: "Schlüssel erneuern",
    progress: "{done} von {total} Objekten neu verschlüsselt",
    done: "Der Schlüssel ist erneuert.",
    unverifiedLeft: "Prüfe oder entferne zuerst alle markierten Konten.",
  },
  invitation: {
    text: "{email} lädt dich zur Datenbank „{name}“ ein.",
    unknownName: "(Name unbekannt)",
    unknownSender: "Ein unbekanntes Konto",
    accept: "Annehmen",
    decline: "Ablehnen",
    keyText:
      "Ein neuer Schlüssel für „{name}“ von {email} wartet auf deine Prüfung.",
    keyCheck: "Prüfen",
    keyInvalid:
      "Der neue Schlüssel für „{name}“ ist ungültig und wurde nicht angenommen. Das kann ein Fehler oder ein Angriff auf den Server sein.",
    rotationRequired:
      "Ein Mitglied hat „{name}“ verlassen. Erneuere den Schlüssel.",
    rotationAction: "Zur Datenbank",
  },
  banner: {
    clockSkew:
      "Die Uhrzeit dieses Geräts weicht ab, TOTP-Codes werden korrigiert.",
    recoveryKey:
      "Dein Recovery Key ist noch nicht bestätigt. Erzeuge einen neuen, damit du dein Konto im Notfall wiederherstellen kannst.",
    recoveryKeyAction: "Recovery Key neu erzeugen",
    kdfBelowDefault:
      "Deine Schlüsselableitung liegt unter dem aktuellen Standard.",
    kdfAction: "Werte erhöhen",
    userDataCorrupt:
      "Deine Kontodaten konnten nicht gelesen werden; Einstellungen sind schreibgeschützt.",
    userDataRollback:
      "Der Server hat ältere Kontodaten geliefert als zuletzt auf diesem Gerät gesehen. Die Einstellungen sind schreibgeschützt, bis du bestätigst.",
    marksLimited:
      "Dieser Browser kann die Zähler der Rückschritt-Erkennung nicht speichern. Die Erkennung ist eingeschränkt.",
    preload: "Eine neue Version ist verfügbar.",
    recovered:
      "Dein Konto ist wiederhergestellt. Alle anderen Sitzungen wurden abgemeldet.",
    backupCodesLeft:
      "Du hast dich mit einem Backup-Code angemeldet. Noch {count} Backup-Codes übrig.",
    backupCodesNone:
      "Du hast deinen letzten Backup-Code verwendet. Erzeuge neue, damit du dich im Notfall anmelden kannst.",
    backupCodesAction: "Neue Backup-Codes erzeugen",
    logoutFailed:
      "Die Abmeldung beim Server ist fehlgeschlagen. Die Sitzung ist auf diesem Gerät gelöscht, aber auf dem Server noch aktiv.",
  },
  error: {
    errorId: "Fehler-ID: {id}",
    network: "Keine Verbindung zum Server.",
    server:
      "Der Server hat einen Fehler gemeldet. Bitte später erneut versuchen.",
    bad_response: "Der Server hat unerwartet geantwortet.",
    rate_limited: "Zu viele Versuche. Bitte in {seconds} s erneut versuchen.",
    invalid_credentials: "E-Mail-Adresse oder Master-Passwort ist falsch.",
    session_invalid: "Die Sitzung ist abgelaufen. Bitte erneut anmelden.",
    reauth_required: "Die Bestätigung ist abgelaufen. Bitte erneut versuchen.",
    forbidden: "Diese Aktion ist nicht erlaubt.",
    registration_closed: "Die Registrierung ist geschlossen.",
    invite_invalid:
      "Der Einladungscode ist ungültig, abgelaufen oder schon verwendet.",
    account_disabled:
      "Dieses Konto ist gesperrt. Bitte die Administration informieren.",
    email_taken: "Für diese E-Mail-Adresse gibt es bereits ein Konto.",
    already_registered: "Dieses Konto existiert bereits.",
    kdf_params_invalid: "Die Parameter der Schlüsselableitung sind ungültig.",
    conflict: "Die Daten wurden gleichzeitig auf einem anderen Gerät geändert.",
    validation_failed: "Die Eingaben sind ungültig.",
    not_found: "Nicht gefunden.",
    request_timeout: "Die Anfrage hat zu lange gedauert.",
    payload_too_large: "Die Daten sind zu groß.",
    internal_error: "Der Server hat einen Fehler gemeldet.",
    wrong_password: "Das Master-Passwort ist falsch.",
    wrong_password_manipulated:
      "Das Master-Passwort ist falsch – oder der Server hat manipulierte Parameter geliefert (schwächer als zuletzt auf diesem Gerät).",
    invalid_second_factor: "Der Code oder Passkey wurde nicht akzeptiert.",
    challenge_invalid:
      "Die Anmeldung ist abgelaufen oder es gab zu viele Fehlversuche. Bitte neu beginnen.",
    challenge_expired: "Die Zeit ist abgelaufen. Bitte neu beginnen.",
    two_factor_state_invalid:
      "Das passt nicht zum aktuellen Stand der Zwei-Faktor-Anmeldung. Bitte die Seite neu laden.",
    recovery_invalid: "E-Mail-Adresse oder Recovery Key ist falsch.",
    recovery_key_malformed:
      "Der Recovery Key ist nicht korrekt. Bitte jede Gruppe prüfen.",
    webauthn_cancelled: "Abgebrochen.",
    webauthn_exists: "Dieser Passkey ist schon registriert.",
    webauthn_unsupported: "Dieser Browser unterstützt keine Passkeys.",
    webauthn_failed: "Der Passkey konnte nicht verwendet werden.",
    integrity: "Der Server hat Daten geliefert, die nicht zusammenpassen.",
    kdf_invalid:
      "Der Server hat ungültige Parameter der Schlüsselableitung geliefert.",
    user_data_corrupt:
      "Die Kontodaten sind beschädigt und können nicht geändert werden.",
    user_data_read_only: "Die Kontodaten sind schreibgeschützt.",
    conflict_unresolved:
      "Die Einstellungen konnten wegen gleichzeitiger Änderungen nicht gespeichert werden.",
    locked: "Bitte zuerst entsperren.",
    password_malformed: "Das Passwort enthält ungültige Zeichen.",
    crypto: "Ein Verschlüsselungsfehler ist aufgetreten.",
    config: "Die Konfiguration ist ungültig.",
    unexpected: "Ein unerwarteter Fehler ist aufgetreten.",
    sole_owner_of_shared_vault:
      "Du bist alleiniger Eigentümer einer gemeinsamen Datenbank. Ernenne zuerst einen anderen Eigentümer.",
    stale_key_version:
      "Der Schlüssel der Datenbank wurde erneuert. Bitte neu laden.",
    idempotency_key_reused: "Die Anfrage wurde verändert wiederholt.",
    kdbx_not_kdbx: "Das ist keine KDBX-Datei.",
    kdbx_unsupported_version:
      "Diese KDBX-Version wird nicht unterstützt (nur KDBX 3 und 4).",
    kdbx_unsupported_cipher:
      "Die Verschlüsselung dieser Datei (z. B. Twofish) wird nicht unterstützt. In KeePassXC unter Datenbank-Einstellungen auf AES-256 oder ChaCha20 umstellen.",
    kdbx_unsupported_kdf:
      "Die Schlüsselableitung dieser Datei wird nicht unterstützt (nur Argon2 1.3 und AES-KDF).",
    kdbx_kdf_limits:
      "Die Datei verlangt mehr als 1 GiB Speicher für Argon2; das wird nicht unterstützt.",
    kdbx_wrong_key: "Passwort oder Schlüsseldatei ist falsch.",
    kdbx_corrupt: "Die Datei ist beschädigt.",
    kdbx_too_large: "Die Datei ist größer als 128 MiB.",
    kdbx_no_credentials: "Bitte ein Passwort oder eine Schlüsseldatei angeben.",
    kdbx_cancelled: "Abgebrochen.",
    kdbx_failed:
      "Die Datei konnte nicht verarbeitet werden (zu wenig Speicher oder ein unerwarteter Fehler).",
    kdbx_selfcheck:
      "Die erzeugte Datei stimmt nicht mit der Datenbank überein; es wird nichts angeboten.",
    sync_network:
      "Keine Verbindung zum Server. Deine Änderung ist noch nicht gespeichert.",
    sync_conflict_unresolved:
      "Die Änderung konnte wegen gleichzeitiger Änderungen nicht gespeichert werden. Bitte erneut versuchen.",
    sync_read_only: "Das ist schreibgeschützt.",
    sync_stale_key:
      "Der Schlüssel der Datenbank wurde erneuert. Bitte neu laden.",
    sync_not_found: "Nicht (mehr) vorhanden.",
    sync_invalid_name: "Der Name muss 1 bis 256 Zeichen lang sein.",
    sync_invalid_target: "Dorthin lässt sich das nicht verschieben.",
    sync_wrong_password: "Das Master-Passwort ist falsch.",
    sync_locked: "Bitte zuerst entsperren.",
    sync_invalid_entry: "Bitte die markierten Angaben prüfen.",
    sync_too_large: "Das ist zu groß zum Speichern.",
    sync_move_incomplete:
      "Kopiert, aber die Originale konnten nicht gelöscht werden. Bitte prüfen und dort erneut löschen.",
    sync_attachment_too_large: "Die Datei ist größer, als der Server erlaubt.",
    sync_attachment_corrupt:
      "Der Anhang ist beschädigt und lässt sich nicht entschlüsseln.",
    sync_attachment_missing: "Den Anhang gibt es auf dem Server nicht mehr.",
    sync_cancelled: "Abgebrochen.",
    attachment_too_large: "Die Datei ist größer, als der Server erlaubt.",
    attachment_incomplete:
      "Der Upload ist unvollständig. Bitte die Datei erneut hinzufügen.",
    quota_exceeded:
      "Der Speicherplatz für Anhänge ist erschöpft (Kontingent der Datenbank-Eigentümerin bzw. des Eigentümers).",
    contacts_self: "Das ist dein eigenes Konto.",
    already_member: "Dieses Konto ist schon Mitglied oder eingeladen.",
    user_not_found: "Zu dieser E-Mail-Adresse gibt es kein Konto.",
    last_owner:
      "Die Datenbank braucht mindestens einen Eigentümer. Ernenne zuerst einen anderen Eigentümer; als einziges Mitglied löschst du die Datenbank stattdessen.",
    key_version_mismatch:
      "Der Schlüssel der Datenbank wurde inzwischen erneuert. Bitte erneut versuchen.",
    use_rotate:
      "Aktive Mitglieder werden über „Entfernen“ mit einer Schlüsselerneuerung entfernt.",
    rotation_invalid:
      "Die Schlüsselerneuerung ist abgelaufen. Bitte erneut versuchen.",
    rotation_incomplete:
      "Die Mitglieder haben sich geändert. Bitte erneut prüfen.",
    sync_unverified:
      "Dieses Konto ist kein verifizierter Kontakt. Vergleiche zuerst die Fingerprints.",
    sync_self: "Dich selbst kannst du nicht einladen.",
    sync_key_box_invalid:
      "Der Schlüssel ließ sich nicht öffnen oder prüfen und wurde nicht angenommen. Das kann ein Fehler oder ein Angriff auf den Server sein.",
    sync_rotation_conflict:
      "Die Datenbank oder ihre Mitglieder haben sich während der Erneuerung geändert. Bitte erneut prüfen.",
    sync_corrupt_objects:
      "Beschädigte Objekte verhindern diesen Schritt. Bei einer Schlüsselerneuerung kannst du sie verwerfen.",
    sync_invalid_icon: "Das Bild ist kein gültiges Icon.",
    sync_invalid_url: "Bitte eine Adresse mit http oder https eingeben.",
    icon_too_large:
      "Das Bild ist zu groß (höchstens 5 MiB und 4096 Pixel Kantenlänge).",
    icon_unreadable: "Das Bild lässt sich nicht lesen.",
    url_not_allowed:
      "Diese Adresse ist nicht erlaubt: nur http und https, Port 80 oder 443, keine Benutzerdaten und keine internen Adressen.",
    favicon_not_found: "Für diese Website wurde kein Icon gefunden.",
    feature_disabled: "Diese Funktion ist auf dem Server abgeschaltet.",
    sync_rollback_open:
      "Bestätige zuerst die Warnung über ältere Daten an dieser Datenbank.",
    too_many_attachments: "Höchstens 50 Anhänge pro Eintrag.",
  },
};
