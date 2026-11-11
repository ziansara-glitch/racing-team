import type { Actor } from "../authz/authorize.ts";
import { visibleProjects } from "./access.ts";
import { all, run, type Conn } from "./sql.ts";

// L'indice FTS5 contiene solo testo. La visibilità si applica SEMPRE nella stessa query, con join
// sul predicato dei progetti: nessun risultato non autorizzato esce mai dal database.

export function indexEntity(conn: Conn, e: { orgId: number; projectId: number; type: "project" | "task"; id: number; title: string; body: string }): void {
  run(conn, "DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?", e.type, e.id);
  run(conn, "INSERT INTO search_index (title, body, org_id, project_id, entity_type, entity_id) VALUES (?, ?, ?, ?, ?, ?)", e.title, e.body, e.orgId, e.projectId, e.type, e.id);
}

export function removeFromIndex(conn: Conn, type: "project" | "task", id: number): void {
  run(conn, "DELETE FROM search_index WHERE entity_type = ? AND entity_id = ?", type, id);
}

/** Trasforma il testo digitato in una query FTS5 sicura: ogni parola tra virgolette, con prefisso. */
export function toMatch(input: string): string | null {
  const tokens = input.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0).slice(0, 8);
  return tokens.length === 0 ? null : tokens.map((t) => `"${t}"*`).join(" ");
}

export type SearchHit = {
  type: "project" | "task" | "member";
  id: number;
  title: string;
  subtitle: string;
  snippet: string;
  url: string;
};

export function search(conn: Conn, actor: Actor, text: string, limit = 8): SearchHit[] {
  const match = toMatch(text);
  if (!match) return [];
  const vis = visibleProjects(actor, "p");
  const hits: SearchHit[] = [];

  for (const r of all<{ id: number; key: string; name: string; status: string; snip: string }>(
    conn,
    `SELECT p.id, p.key, p.name, p.status, snippet(search_index, 1, '[', ']', '…', 10) AS snip
       FROM search_index JOIN projects p ON p.id = search_index.entity_id
      WHERE search_index MATCH ? AND search_index.entity_type = 'project' AND search_index.org_id = ? AND ${vis.sql}
      ORDER BY rank LIMIT ?`,
    match,
    actor.orgId,
    ...vis.params,
    limit,
  )) {
    hits.push({ type: "project", id: r.id, title: r.name, subtitle: `Progetto ${r.key}`, snippet: r.snip, url: `/projects/${r.key}` });
  }

  for (const r of all<{ id: number; number: number; key: string; title: string; status: string; snip: string }>(
    conn,
    `SELECT t.id, t.number, p.key, t.title, s.name AS status, snippet(search_index, 1, '[', ']', '…', 10) AS snip
       FROM search_index
       JOIN tasks t ON t.id = search_index.entity_id AND t.deleted_at IS NULL
       JOIN projects p ON p.id = t.project_id
       JOIN project_statuses s ON s.id = t.status_id
      WHERE search_index MATCH ? AND search_index.entity_type = 'task' AND search_index.org_id = ? AND ${vis.sql}
      ORDER BY rank LIMIT ?`,
    match,
    actor.orgId,
    ...vis.params,
    limit,
  )) {
    hits.push({ type: "task", id: r.id, title: r.title, subtitle: `${r.key}-${r.number} · ${r.status}`, snippet: r.snip, url: `/projects/${r.key}/tasks/${r.number}` });
  }

  // Persone: la directory è visibile a tutti i membri attivi dell'organizzazione (nome, reparto, titolo).
  const like = `%${text.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  for (const r of all<{ id: number; name: string; department: string; title: string }>(
    conn,
    `SELECT u.id, u.name, u.department, m.title FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ? AND m.status = 'active' AND (u.name LIKE ? ESCAPE '\\' OR m.title LIKE ? ESCAPE '\\')
      ORDER BY u.name LIMIT ?`,
    actor.orgId,
    like,
    like,
    limit,
  )) {
    hits.push({ type: "member", id: r.id, title: r.name, subtitle: `${r.department} · ${r.title}`, snippet: "", url: `/people?q=${encodeURIComponent(r.name)}` });
  }
  return hits;
}
