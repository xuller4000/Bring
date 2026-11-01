# Bring! MCP-Connector (Cloudflare Worker)

Remote-MCP-Server, über den Claude auf deine Bring!-Einkaufslisten zugreifen kann:
Listen anzeigen, Artikel hinzufügen, abhaken und löschen. Läuft als Cloudflare Worker
und funktioniert damit in claude.ai, in der Desktop-App und am Handy.

Nutzt die inoffizielle Bring!-API; wenn Bring! sie ändert, kann der Connector ausfallen.

## Tools

| Tool | Funktion |
|---|---|
| `list_lists` | alle Listen |
| `get_list` | Artikel einer Liste (optional auch zuletzt abgehakte) |
| `add_items` | Artikel mit optionaler Spezifikation hinzufügen |
| `complete_items` | Artikel abhaken |
| `remove_items` | Artikel ganz löschen |

Ohne `list_name` wird die Standardliste verwendet.

## Einrichtung

Voraussetzungen: Node.js und ein kostenloser Cloudflare-Account.

```powershell
powershell -ExecutionPolicy Bypass -File setup.ps1
```

Das Skript meldet dich bei Cloudflare an, deployt den Worker, fragt deine
Bring!-Zugangsdaten ab, speichert sie als verschlüsselte Worker-Secrets und gibt am Ende
die Connector-URL aus. Die trägst du in claude.ai unter
**Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen** ein.

## Sicherheit

- Die Zugangsdaten liegen nur als Cloudflare-Secrets vor, nicht im Repo.
- Der Endpunkt ist `/mcp/<MCP_TOKEN>`; alle anderen Pfade liefern 404. Die URL ist also
  dein Schlüssel. Erneutes Ausführen von `setup.ps1` erzeugt einen neuen Token.

## Secrets manuell setzen

```bash
npx wrangler secret put BRING_EMAIL
npx wrangler secret put BRING_PASSWORD
npx wrangler secret put MCP_TOKEN
```
