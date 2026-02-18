
import {
  Ticket, TicketStatus, Criticality,
  AdminTicket, AdminTicketsResponse, AdminAnalytics,
  AdminTicketUpdate, RoutingRule, AdminNote,
} from '../types';
import { offlineStore, syncManager } from './offlineStore';
import { msalInstance, tokenRequest, msalReady } from '../authConfig';

/**
 * For a unified deployment (FastAPI serving React),
 * we use relative paths starting with /api.
 */
const API_BASE = "/api";

/**
 * Acquire an access token for the backend API.
 * Attempts silent acquisition first; falls back to an interactive popup
 * if the silent call fails (e.g., no cached token or consent required).
 */
export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Ensure MSAL is fully initialized before any token operation
  await msalReady;

  const accounts = msalInstance.getAllAccounts();
  if (accounts.length === 0) {
    throw new Error("No authenticated user. Please sign in.");
  }

  try {
    const response = await msalInstance.acquireTokenSilent({
      ...tokenRequest,
      account: accounts[0],
    });
    return {
      "Authorization": `Bearer ${response.accessToken}`,
      "Content-Type": "application/json",
    };
  } catch (silentError) {
    // Silent acquisition failed — fall back to popup
    try {
      const response = await msalInstance.acquireTokenPopup(tokenRequest);
      return {
        "Authorization": `Bearer ${response.accessToken}`,
        "Content-Type": "application/json",
      };
    } catch (popupError) {
      console.error("Token acquisition failed:", popupError);
      throw popupError;
    }
  }
}

/**
 * Determine whether a fetch failure should trigger offline queueing.
 * Network errors (TypeError from fetch) and 5xx server errors qualify.
 */
function isOfflineEligible(error: unknown, response?: Response): boolean {
  // Network-level failure (no response at all)
  if (error instanceof TypeError) return true;
  // Server error (5xx) — backend is down or broken
  if (response && response.status >= 500) return true;
  return false;
}

export const apiService = {
  /**
   * Save a ticket to the backend. If the API is unreachable (network error
   * or 5xx), the ticket is queued in IndexedDB for later sync.
   *
   * Returns a SharePoint ID on success, or an `offline-{timestamp}` placeholder
   * if the ticket was queued offline, or null if queueing was also unavailable.
   */
  async saveTicket(ticket: Ticket): Promise<string | null> {
    let response: Response | undefined;
    try {
      const headers = await getAuthHeaders();
      response = await fetch(`${API_BASE}/tickets`, {
        method: 'POST',
        headers,
        body: JSON.stringify(ticket),
      });

      if (!response.ok) {
        // 5xx → queue offline
        if (response.status >= 500) {
          return await this._queueForOffline(ticket);
        }
        // 4xx or other client error — don't queue, just report failure
        return null;
      }

      const data = await response.json();
      return data.sharepoint_id;
    } catch (error) {
      console.error("Bridge Connection Failure:", error);

      // Network-level error → queue offline
      if (isOfflineEligible(error, response)) {
        return await this._queueForOffline(ticket);
      }

      return null;
    }
  },

  /**
   * Trigger a manual sync of all pending offline tickets.
   */
  async syncPending(): Promise<{ synced: number; failed: number }> {
    return syncManager.syncPendingTickets();
  },

  /**
   * Internal: queue a ticket into IndexedDB and return a placeholder ID.
   */
  async _queueForOffline(ticket: Ticket): Promise<string | null> {
    try {
      await offlineStore.init();
      await offlineStore.queueTicket(ticket);
      const count = await offlineStore.getPendingCount();
      syncManager.notifyListeners(count);
      syncManager.ensurePeriodicSync();
      return `offline-${Date.now()}`;
    } catch (queueError) {
      console.error('[apiService] Failed to queue ticket offline:', queueError);
      return null;
    }
  },

  async searchTickets(email: string): Promise<Partial<Ticket>[]> {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${API_BASE}/tickets/search/${encodeURIComponent(email)}`,
        { headers }
      );
      if (!response.ok) return [];
      const data = await response.json();
      return data.tickets.map((t: any) => ({
        sharepointId: t.sharepointId,
        summary: t.summary,
        status: t.status as TicketStatus,
        category: t.category,
        criticality: t.criticality as Criticality,
        createdAt: t.createdAt,
        transcript: t.transcript || []  // Include transcript for resume
      }));
    } catch (error) {
      console.error("History fetch failed:", error);
      return [];
    }
  },

  async updateStatus(sharepointId: string, status: TicketStatus): Promise<boolean> {
    if (!sharepointId) return false;
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(`${API_BASE}/tickets/status`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ sharepointId, status }),
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  },

  async searchKnowledgeBase(query: string): Promise<import('../types').KBArticle[]> {
    try {
      const headers = await getAuthHeaders();
      const response = await fetch(
        `${API_BASE}/kb/search?q=${encodeURIComponent(query)}`,
        { headers }
      );
      if (!response.ok) return [];
      const data = await response.json();
      return data.articles || [];
    } catch (error) {
      console.error("KB Search failed:", error);
      return [];
    }
  },

  // ── Admin Panel Methods ──

  async getAdminTickets(params?: {
    status?: string;
    category?: string;
    top?: number;
    skip?: number;
  }): Promise<AdminTicketsResponse> {
    const headers = await getAuthHeaders();
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.category) searchParams.set('category', params.category);
    if (params?.top) searchParams.set('top', String(params.top));
    if (params?.skip) searchParams.set('skip', String(params.skip));

    const qs = searchParams.toString();
    const url = `${API_BASE}/admin/tickets${qs ? `?${qs}` : ''}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch admin tickets: ${response.status}`);
    }
    return response.json();
  },

  async getAdminTicket(id: string): Promise<AdminTicket> {
    const headers = await getAuthHeaders();
    const response = await fetch(
      `${API_BASE}/admin/tickets/${encodeURIComponent(id)}`,
      { headers }
    );
    if (!response.ok) {
      throw new Error(`Failed to fetch ticket ${id}: ${response.status}`);
    }
    return response.json();
  },

  async updateAdminTicket(id: string, data: AdminTicketUpdate): Promise<boolean> {
    const headers = await getAuthHeaders();
    const response = await fetch(
      `${API_BASE}/admin/tickets/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to update ticket ${id}: ${response.status}`);
    }
    return true;
  },

  async addAdminNote(id: string, note: string, author: string): Promise<AdminNote> {
    const headers = await getAuthHeaders();
    const response = await fetch(
      `${API_BASE}/admin/tickets/${encodeURIComponent(id)}/notes`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ note, author }),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to add note to ticket ${id}: ${response.status}`);
    }
    const data = await response.json();
    return data.note;
  },

  async getAnalytics(): Promise<AdminAnalytics> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/admin/analytics`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch analytics: ${response.status}`);
    }
    return response.json();
  },

  async getRouting(): Promise<RoutingRule[]> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/admin/routing`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch routing rules: ${response.status}`);
    }
    return response.json();
  },

  async updateRouting(id: string, data: Partial<RoutingRule>): Promise<boolean> {
    const headers = await getAuthHeaders();
    const response = await fetch(
      `${API_BASE}/admin/routing/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify(data),
      }
    );
    if (!response.ok) {
      throw new Error(`Failed to update routing rule ${id}: ${response.status}`);
    }
    return true;
  },

  async chatWithAdmin(
    ticket: { id?: string; category?: string; summary?: string; criticality?: string; sharepointId?: string },
    messages: { role: string; content: string }[]
  ): Promise<{ text: string; error?: string }> {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/chat/admin`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket, messages }),
    });
    if (!response.ok) {
      throw new Error(`Admin chat failed: ${response.status}`);
    }
    return response.json();
  },
};
