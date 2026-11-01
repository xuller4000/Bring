// Remote-MCP-Server fuer die Bring! Einkaufslisten-App als Cloudflare Worker.
// Streamable HTTP (nur JSON-Antworten, kein SSE). Erreichbar unter /mcp/<MCP_TOKEN>.
// Secrets: BRING_EMAIL, BRING_PASSWORD, MCP_TOKEN (per `wrangler secret put`).

const API = "https://api.getbring.com/rest/v2";
const BASE_HEADERS = {
  "X-BRING-API-KEY": "cof4Nc6D8saplXjE3h3HXqHH8m7VU2i1Gs0g85Sp",
  "X-BRING-CLIENT": "webApp",
  "X-BRING-APPLICATION": "bring",
  "X-BRING-COUNTRY": "DE",
};
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "Zugriff auf die Bring!-Einkaufslisten des Nutzers. Ohne list_name wird die " +
  "Standardliste verwendet. Artikelnamen auf Deutsch angeben (z.B. 'Milch'), Details " +
  "wie Menge oder Marke gehoeren in 'spec'. complete_items hakt Artikel ab (wie in der " +
  "App), remove_items loescht sie ganz. Vor dem Abhaken oder Loeschen mehrerer Artikel " +
  "kurz nachfragen.";

// Bleibt pro Worker-Isolate erhalten, spart den Login bei Folgeanfragen.
let session = null;

class Bring {
  constructor(env) {
    this.env = env;
  }

  async login() {
    const email = (this.env.BRING_EMAIL || "").trim();
    const password = (this.env.BRING_PASSWORD || "").trim();
    if (!email || !password) throw new Error("BRING_EMAIL/BRING_PASSWORD sind als Secret nicht gesetzt.");
    const r = await fetch(`${API}/bringauth`, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, password }),
    });
    if (r.status === 400 || r.status === 401) throw new Error("Bring!-Login fehlgeschlagen: E-Mail oder Passwort falsch.");
    if (!r.ok) throw new Error(`Bring!-Login: HTTP ${r.status}`);
    const d = await r.json();
    session = {
      uuid: d.uuid,
      defaultList: d.bringListUUID,
      headers: {
        ...BASE_HEADERS,
        "X-BRING-USER-UUID": d.uuid,
        "X-BRING-PUBLIC-USER-UUID": d.publicUuid || "",
        Authorization: `Bearer ${d.access_token}`,
      },
    };
  }

  async request(method, path, body) {
    if (!session) await this.login();
    const send = () =>
      fetch(`${API}${path}`, {
        method,
        headers: body ? { ...session.headers, "Content-Type": "application/json" } : session.headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    let r = await send();
    if (r.status === 401) {
      // Token abgelaufen
      await this.login();
      r = await send();
    }
    if (!r.ok) throw new Error(`Bring!-API ${method} ${path}: HTTP ${r.status}`);
    const text = await r.text();
    return text ? JSON.parse(text) : null;
  }

  async lists() {
    if (!session) await this.login();
    return (await this.request("GET", `/bringusers/${session.uuid}/lists`)).lists;
  }

  async resolveList(name) {
    const lists = await this.lists();
    if (!name) return lists.find((l) => l.listUuid === session.defaultList) || lists[0];
    const hit = lists.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (!hit) throw new Error(`Liste '${name}' nicht gefunden. Vorhanden: ${lists.map((l) => l.name).join(", ")}`);
    return hit;
  }

  async items(listUuid) {
    return (await this.request("GET", `/bringlists/${listUuid}`)).items;
  }

  async change(listUuid, changes) {
    const geo = { accuracy: "0.0", altitude: "0.0", latitude: "0.0", longitude: "0.0" };
    await this.request("PUT", `/bringlists/${listUuid}/items`, {
      changes: changes.map((c) => ({ ...geo, ...c })),
      sender: "",
    });
  }
}

const find = (items, name) => items.find((i) => i.itemId.trim().toLowerCase() === name.trim().toLowerCase());
const simplify = (items = []) => items.map((i) => ({ name: i.itemId, spec: i.specification || "" }));

async function move(bring, names, listName, operation, verb) {
  const l = await bring.resolveList(listName);
  const existing = await bring.items(l.listUuid);
  const pool = [...(existing.purchase || []), ...(operation === "REMOVE" ? existing.recently || [] : [])];
  const changes = [];
  const missing = [];
  for (const n of names) {
    const m = find(pool, n);
    if (!m) {
      missing.push(n);
      continue;
    }
    changes.push({ itemId: m.itemId, spec: m.specification || "", uuid: m.uuid || crypto.randomUUID(), operation });
  }
  if (changes.length) await bring.change(l.listUuid, changes);
  let msg = `${changes.length} Artikel in '${l.name}' ${verb}`;
  if (changes.length) msg += ": " + changes.map((c) => c.itemId).join(", ");
  if (missing.length) msg += `. Nicht gefunden: ${missing.join(", ")}`;
  return msg;
}

const listNameProp = { type: "string", description: "Name der Liste (optional, sonst Standardliste)" };

const TOOLS = [
  {
    name: "list_lists",
    description: "Alle Bring!-Listen des Nutzers (Name, ID, ob Standardliste).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async (bring) =>
      (await bring.lists()).map((l) => ({ name: l.name, id: l.listUuid, default: l.listUuid === session.defaultList })),
  },
  {
    name: "get_list",
    description: "Artikel einer Liste. include_recent liefert auch die zuletzt abgehakten Artikel.",
    inputSchema: {
      type: "object",
      properties: { list_name: listNameProp, include_recent: { type: "boolean", default: false } },
    },
    annotations: { readOnlyHint: true },
    run: async (bring, a) => {
      const l = await bring.resolveList(a.list_name);
      const items = await bring.items(l.listUuid);
      const out = { list: l.name, to_buy: simplify(items.purchase) };
      if (a.include_recent) out.recent = simplify(items.recently);
      return out;
    },
  },
  {
    name: "add_items",
    description: 'Artikel hinzufuegen. items: [{"name": "Milch", "spec": "2x, fettarm"}, ...] (spec optional).',
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, spec: { type: "string" } },
            required: ["name"],
          },
        },
        list_name: listNameProp,
      },
      required: ["items"],
    },
    run: async (bring, a) => {
      const l = await bring.resolveList(a.list_name);
      const existing = await bring.items(l.listUuid);
      const known = [...(existing.purchase || []), ...(existing.recently || [])];
      const changes = a.items.map((it) => {
        const m = find(known, it.name);
        return {
          itemId: m ? m.itemId : it.name.trim(),
          spec: it.spec || "",
          uuid: (m && m.uuid) || crypto.randomUUID(),
          operation: "TO_PURCHASE",
        };
      });
      await bring.change(l.listUuid, changes);
      return `${changes.length} Artikel zu '${l.name}' hinzugefuegt: ${changes.map((c) => c.itemId).join(", ")}`;
    },
  },
  {
    name: "complete_items",
    description: "Artikel abhaken (wandern in 'Zuletzt verwendet', wie in der App).",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } }, list_name: listNameProp },
      required: ["names"],
    },
    run: (bring, a) => move(bring, a.names, a.list_name, "TO_RECENTLY", "abgehakt"),
  },
  {
    name: "remove_items",
    description: "Artikel komplett von der Liste loeschen (auch aus 'Zuletzt verwendet').",
    inputSchema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } }, list_name: listNameProp },
      required: ["names"],
    },
    annotations: { destructiveHint: true },
    run: (bring, a) => move(bring, a.names, a.list_name, "REMOVE", "geloescht"),
  },
];

async function handleRpc(msg, env) {
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return null; // Notification, keine Antwort
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const v = PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion: v,
        capabilities: { tools: {} },
        serverInfo: { name: "bring", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `Unbekanntes Tool: ${params.name}`);
      try {
        const res = await tool.run(new Bring(env), params.arguments || {});
        const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
        return ok({ content: [{ type: "text", text }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: String(e.message || e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `Methode nicht unterstuetzt: ${method}`);
  }
}

function tokenMatches(given, expected) {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!m || !tokenMatches(m[1], (env.MCP_TOKEN || "").trim())) return new Response("Not found", { status: 404 });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
    }

    const batch = Array.isArray(body);
    const replies = (await Promise.all((batch ? body : [body]).map((msg) => handleRpc(msg, env)))).filter(Boolean);
    if (!replies.length) return new Response(null, { status: 202 });
    return Response.json(batch ? replies : replies[0]);
  },
};
