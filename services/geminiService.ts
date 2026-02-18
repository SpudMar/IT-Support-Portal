
import { Message, Ticket } from "../types";
import { getAuthHeaders } from "./apiService";

const API_BASE = "/api";

interface ChatResponse {
  text: string;
  functionCalls: Array<{ name: string; args: Record<string, any> }>;
  incidentData: Record<string, any> | null;
}

interface AdminChatResponse {
  text: string;
}

/**
 * Send a chat message to the server-side Gemini endpoint.
 * The backend handles all Gemini SDK calls, function execution (KB search),
 * and returns the final response text plus any incident data.
 */
export async function chatWithGemini(
  messages: Message[],
  image?: string
): Promise<ChatResponse> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        image: image || undefined,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`Chat API error ${response.status}:`, errorText);
      return {
        text: "Sorry, something went wrong connecting to the AI service. Please try again.",
        functionCalls: [],
        incidentData: null,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        text: data.error,
        functionCalls: [],
        incidentData: null,
      };
    }

    return {
      text: data.text || "",
      functionCalls: data.function_calls || [],
      incidentData: data.incident_data || null,
    };
  } catch (error) {
    console.error("Chat request failed:", error);
    return {
      text: "Network error. Please check your connection and try again.",
      functionCalls: [],
      incidentData: null,
    };
  }
}

/**
 * Send an admin consultation message to the server-side Gemini Pro endpoint.
 * The backend handles the full Gemini Pro interaction with ticket context.
 */
export async function chatWithAdminExpert(
  ticket: Ticket,
  adminMessages: Message[]
): Promise<AdminChatResponse> {
  try {
    const headers = await getAuthHeaders();
    const response = await fetch(`${API_BASE}/chat/admin`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        ticket: {
          id: ticket.id,
          category: ticket.category || "General",
          summary: ticket.summary,
          criticality: ticket.criticality,
          sharepointId: ticket.sharepointId || undefined,
        },
        messages: adminMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      console.error(`Admin chat API error ${response.status}:`, errorText);
      return {
        text: "Sorry, something went wrong consulting the AI architect. Please try again.",
      };
    }

    const data = await response.json();

    if (data.error) {
      return { text: data.error };
    }

    return { text: data.text || "" };
  } catch (error) {
    console.error("Admin chat request failed:", error);
    return {
      text: "Network error. Please check your connection and try again.",
    };
  }
}
