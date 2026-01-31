
import { Ticket, TicketStatus, Criticality } from '../types';

/**
 * For a unified deployment (FastAPI serving React), 
 * we use relative paths starting with /api.
 */
const API_BASE = "/api";

export const apiService = {
  async saveTicket(ticket: Ticket): Promise<string | null> {
    try {
      const response = await fetch(`${API_BASE}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ticket),
      });

      if (!response.ok) return null;
      const data = await response.json();
      return data.sharepoint_id;
    } catch (error) {
      console.error("Bridge Connection Failure:", error);
      return null;
    }
  },

  async searchTickets(email: string): Promise<Partial<Ticket>[]> {
    try {
      const response = await fetch(`${API_BASE}/tickets/search/${encodeURIComponent(email)}`);
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
      const response = await fetch(`${API_BASE}/tickets/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sharepointId, status }),
      });
      return response.ok;
    } catch (error) {
      return false;
    }
  },

  async searchKnowledgeBase(query: string): Promise<import('../types').KBArticle[]> {
    try {
      const response = await fetch(`${API_BASE}/kb/search?q=${encodeURIComponent(query)}`);
      if (!response.ok) return [];
      const data = await response.json();
      return data.articles || [];
    } catch (error) {
      console.error("KB Search failed:", error);
      return [];
    }
  }
};
