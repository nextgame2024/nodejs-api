import { createHash } from "node:crypto";
import { AnalyticsMetricDefinitionSchema, BusinessPackManifestSchema, type AnalyticsMetricDefinition,
  type BusinessPackManifest, type BusinessPackRegistration } from "./business-pack.contracts.js";
import type { RuntimeTool } from "../tools/tool-registry.js";

export class BusinessPackRegistry {
  private readonly registrations: readonly BusinessPackRegistration[];

  constructor(registrations: readonly BusinessPackRegistration[] = []) {
    const packIds = new Set<string>();
    const toolNames = new Set<string>();
    const canonicalIds = new Set<string>();
    const connectorKeys = new Set<string>();
    const workflowTemplateKeys = new Set<string>();
    const analyticsMetricKeys = new Set<string>();
    for (const registration of registrations) {
      const manifest = BusinessPackManifestSchema.parse(registration.manifest);
      if (packIds.has(manifest.packId)) throw new Error(`Duplicate business pack: ${manifest.packId}`);
      packIds.add(manifest.packId);
      if (registration.connectorAdministration.connectorKey !== registration.connectorManifest.connectorKey ||
          !manifest.connectorKeys.includes(registration.connectorAdministration.connectorKey)) {
        throw new Error(`Business pack ${manifest.packId} has inconsistent connector administration metadata.`);
      }
      if (connectorKeys.has(registration.connectorAdministration.connectorKey)) {
        throw new Error(`Duplicate business-pack connector: ${registration.connectorAdministration.connectorKey}`);
      }
      connectorKeys.add(registration.connectorAdministration.connectorKey);
      for (const template of registration.workflowTemplates) {
        if (workflowTemplateKeys.has(template.templateKey)) {
          throw new Error(`Duplicate workflow template: ${template.templateKey}`);
        }
        if (!manifest.connectorKeys.includes(template.connectorKey) ||
            (template.retry.support === "owner-idempotent" && typeof template.retry.execute !== "function")) {
          throw new Error(`Business pack ${manifest.packId} has invalid workflow template metadata.`);
        }
        workflowTemplateKeys.add(template.templateKey);
      }
      for (const tool of registration.tools) {
        if (toolNames.has(tool.definition.name)) throw new Error(`Duplicate business-pack tool: ${tool.definition.name}`);
        toolNames.add(tool.definition.name);
        if (!tool.policy) throw new Error(`Business-pack tool ${tool.definition.name} is missing policy metadata.`);
        if (canonicalIds.has(tool.policy.toolId)) throw new Error(`Duplicate business-pack operation: ${tool.policy.toolId}`);
        canonicalIds.add(tool.policy.toolId);
      }
      const packToolIds = new Set(registration.tools.map((tool) => tool.policy?.toolId));
      for (const rawMetric of registration.analyticsMetrics) {
        const metric = AnalyticsMetricDefinitionSchema.parse(rawMetric);
        if (analyticsMetricKeys.has(metric.metricKey)) throw new Error(`Duplicate analytics metric: ${metric.metricKey}`);
        if (!packToolIds.has(metric.source.canonicalToolId)) {
          throw new Error(`Analytics metric ${metric.metricKey} references a tool outside business pack ${manifest.packId}.`);
        }
        analyticsMetricKeys.add(metric.metricKey);
      }
    }
    this.registrations = [...registrations];
  }

  manifests(): BusinessPackManifest[] { return this.registrations.map(({ manifest }) => manifest); }
  connectorRegistrations(): readonly BusinessPackRegistration["connectorAdministration"][] {
    return this.registrations.map(({ connectorAdministration }) => connectorAdministration);
  }
  connectorManifests() { return this.registrations.map(({ connectorManifest }) => connectorManifest); }
  workflowTemplates() { return this.registrations.flatMap(({ workflowTemplates }) => workflowTemplates); }
  analyticsMetrics(): readonly AnalyticsMetricDefinition[] {
    return this.registrations.flatMap(({ analyticsMetrics }) => analyticsMetrics);
  }
  tools(): RuntimeTool<any, unknown>[] { return this.registrations.flatMap(({ tools }) => tools); }
  instructions(mode: "canonical" | "legacy"): string[] {
    return this.registrations.flatMap(({ instructionFragments }) => instructionFragments[mode]);
  }
  has(packId: string): boolean { return this.registrations.some(({ manifest }) => manifest.packId === packId); }

  catalogVersion(): string {
    if (this.registrations.length === 1) return this.registrations[0].manifest.toolCatalogVersion;
    if (!this.registrations.length) return "core-tools-v1";
    const digest = createHash("sha256").update(JSON.stringify(this.registrations.map(({ manifest }) => [
      manifest.packId, manifest.version, manifest.toolCatalogVersion,
    ]).sort())).digest("hex").slice(0, 16);
    return `compiled-packs-${digest}`;
  }
}
