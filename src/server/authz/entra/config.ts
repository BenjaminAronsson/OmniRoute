/**
 * Entra ID SSO configuration for the client API (/v1/*).
 *
 * Separate from the dashboard's `oidc*` settings on purpose: those gate the
 * browser admin login with an `id_token` audienced to the client_id, while this
 * gates /v1/* with an access token audienced to a custom API scope. Sharing one
 * config would force each to accept the other's tokens.
 * See docs/security/ENTRA_SSO.md.
 */

import { getCachedSettings } from "@/lib/db/readCache";

export const ENTRA_LOGIN_HOST = "https://login.microsoftonline.com";
export const GRAPH_HOST = "https://graph.microsoft.com";

export interface EntraGroupMapping {
  groupId: string;
  keyGroupId: string;
}

export interface EntraConfig {
  enabled: boolean;
  tenantId: string;
  clientId: string;
  audience: string;
  groupMappings: EntraGroupMapping[];
  defaultKeyGroupId: string | null;
  graphFallbackEnabled: boolean;
  graphClientSecret: string;
}

export function entraIssuer(tenantId: string): string {
  return `${ENTRA_LOGIN_HOST}/${tenantId}/v2.0`;
}

export function entraJwksUri(tenantId: string): string {
  return `${ENTRA_LOGIN_HOST}/${tenantId}/discovery/v2.0/keys`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asGroupMappings(value: unknown): EntraGroupMapping[] {
  if (!Array.isArray(value)) return [];
  const mappings: EntraGroupMapping[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const groupId = asString((entry as Record<string, unknown>).groupId);
    const keyGroupId = asString((entry as Record<string, unknown>).keyGroupId);
    if (groupId && keyGroupId) mappings.push({ groupId, keyGroupId });
  }
  return mappings;
}

/**
 * `enabled` requires every field needed to verify a token, not just the master
 * switch: a half-configured tenant must fall through to the API-key path that
 * still works rather than reject tokens it cannot validate.
 */
export async function getEntraConfig(): Promise<EntraConfig> {
  const settings = await getCachedSettings();

  const tenantId = asString(settings.entraTenantId);
  const audience = asString(settings.entraApiAudience);
  const defaultKeyGroupId = asString(settings.entraDefaultKeyGroupId);

  return {
    enabled: settings.entraSsoEnabled === true && tenantId !== "" && audience !== "",
    tenantId,
    clientId: asString(settings.entraClientId),
    audience,
    groupMappings: asGroupMappings(settings.entraGroupMappings),
    defaultKeyGroupId: defaultKeyGroupId === "" ? null : defaultKeyGroupId,
    graphFallbackEnabled: settings.entraGraphFallbackEnabled === true,
    graphClientSecret: asString(settings.entraGraphClientSecret),
  };
}
