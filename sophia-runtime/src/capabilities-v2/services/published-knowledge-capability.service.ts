import { Inject, Injectable } from "@nestjs/common";
import { runtimeConfig } from "../../config/runtime-config.js";
import { DatabaseService } from "../../database/database.service.js";
import type { CapabilityContext, ExtensionValue, KnowledgeRecord, PageRequest } from "../contracts/business-capability.contracts.js";
import type { KnowledgePort, Paged } from "../ports/business-capability.ports.js";

type SearchRow = {
  knowledge_snapshot_id: string;
  knowledge_revision_id: string;
  connector_binding_id: string;
  title: string;
  document_text: string;
  published_at: Date | string;
};

@Injectable()
export class PublishedKnowledgeCapabilityService implements KnowledgePort {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async search(
    input: { query: string; page: PageRequest; extension?: ExtensionValue },
    context: CapabilityContext,
  ): Promise<Paged<KnowledgeRecord>> {
    const snapshotId = typeof input.extension?.["snapshotId"] === "string"
      ? input.extension["snapshotId"]
      : undefined;
    if (!snapshotId) return { items: [], page: { hasMore: false } };
    return this.searchPublishedSnapshot({
      tenantId: context.tenantId,
      snapshotId,
      capabilityBindingId: context.capabilityBindingId,
      query: input.query,
      limit: input.page.limit,
    });
  }

  async searchPublishedSnapshot(input: {
    tenantId: string;
    snapshotId: string;
    capabilityBindingId: string;
    query: string;
    limit: number;
  }): Promise<Paged<KnowledgeRecord>> {
    const schema = runtimeConfig().schema;
    const limit = Math.max(1, Math.min(input.limit, 20));
    const result = await this.database.tenantTransaction(input.tenantId, (client) => client.query<SearchRow>(
      `SELECT s.knowledge_snapshot_id, s.knowledge_revision_id,
              COALESCE(b.connector_binding_id, g.capability_binding_id) AS connector_binding_id,
              d.title, d.document_text, s.published_at
       FROM ${schema}.knowledge_snapshots s
       JOIN ${schema}.knowledge_snapshot_grants g
         ON g.knowledge_snapshot_id = s.knowledge_snapshot_id AND g.customer_id = s.customer_id
       JOIN ${schema}.capability_bindings b
         ON b.capability_binding_id = g.capability_binding_id
       JOIN ${schema}.knowledge_index_documents d
         ON d.knowledge_snapshot_id = s.knowledge_snapshot_id AND d.customer_id = s.customer_id
       WHERE s.customer_id = $1 AND s.knowledge_snapshot_id = $2
         AND s.status = 'published' AND g.capability_binding_id = $3
         AND d.search_vector @@ plainto_tsquery('simple', $4)
       ORDER BY ts_rank_cd(d.search_vector, plainto_tsquery('simple', $4)) DESC
       LIMIT $5`,
      [input.tenantId, input.snapshotId, input.capabilityBindingId, input.query, limit],
    ));
    const retrievedAt = new Date().toISOString();
    return {
      items: result.rows.map((row) => ({
        recordRef: { connectorBindingId: row.connector_binding_id, opaqueId: row.knowledge_revision_id },
        title: row.title,
        excerpt: excerpt(row.document_text, input.query),
        sources: [{
          sourceRef: row.knowledge_revision_id,
          retrievedAt,
          freshness: "cached" as const,
          accessClassification: "internal" as const,
        }],
        extension: { snapshotId: row.knowledge_snapshot_id, publishedAt: new Date(row.published_at).toISOString() },
      })),
      page: { hasMore: false },
    };
  }
}

function excerpt(document: string, query: string): string {
  const term = query.trim().split(/\s+/)[0]?.toLocaleLowerCase() ?? "";
  const position = term ? document.toLocaleLowerCase().indexOf(term) : -1;
  const start = Math.max(0, position < 0 ? 0 : position - 180);
  return document.slice(start, start + 500);
}
