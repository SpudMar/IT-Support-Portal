
import { GoogleGenAI, Type, FunctionDeclaration, GenerateContentResponse } from "@google/genai";
import { Message, Criticality, Ticket } from "../types";
import { SYSTEM_INSTRUCTION, APP_MODELS } from "../constants";

const searchKnowledgeBaseDecl: FunctionDeclaration = {
  name: 'search_knowledge_base',
  parameters: {
    type: Type.OBJECT,
    description: 'Searches the Lotus Assist internal knowledge base for known issues and solutions.',
    properties: {
      query: {
        type: Type.STRING,
        description: 'The search query or keyword related to the issue.',
      },
    },
    required: ['query'],
  },
};

const logIncidentDecl: FunctionDeclaration = {
  name: 'log_incident',
  parameters: {
    type: Type.OBJECT,
    description: 'Logs a structured IT support ticket for admin follow-up. Call when self-service fails, admin access is needed, security is detected, user is frustrated, or outage detected.',
    properties: {
      summary: {
        type: Type.STRING,
        description: 'A concise 10-word technical summary of the issue.',
      },
      category: {
        type: Type.STRING,
        description: 'Top-level issue category.',
        enum: ['Microsoft 365', 'Identity & Access', 'Xero', 'Careview', 'enableHR', 'Hardware', 'Network & Connectivity', 'Security', 'General'],
      },
      sub_category: {
        type: Type.STRING,
        description: 'Specific sub-category (e.g. "Outlook - Sync Issues", "VPN Issues", "Phishing/Suspicious Email").',
      },
      priority: {
        type: Type.STRING,
        description: 'Priority level. P1=Critical (security/outage), P2=High (user blocked), P3=Medium (degraded), P4=Low (non-urgent).',
        enum: ['P1', 'P2', 'P3', 'P4'],
      },
      admin_required: {
        type: Type.BOOLEAN,
        description: 'Whether the fix requires admin/elevated access.',
      },
      self_service_attempted: {
        type: Type.BOOLEAN,
        description: 'Whether a self-service fix was attempted before escalating.',
      },
      self_service_result: {
        type: Type.STRING,
        description: 'Outcome of the self-service attempt.',
        enum: ['resolved', 'not_resolved', 'not_attempted', 'security_bypass'],
      },
      security_flag: {
        type: Type.BOOLEAN,
        description: 'True if this is a security incident requiring immediate attention.',
      },
      outage_flag: {
        type: Type.BOOLEAN,
        description: 'True if this appears to be part of a broader outage (3+ users).',
      },
      affected_application: {
        type: Type.STRING,
        description: 'The primary application or system affected.',
      },
      ai_recommended_actions: {
        type: Type.ARRAY,
        description: 'Suggested next steps for the IT admin.',
        items: { type: Type.STRING },
      },
    },
    required: ['summary', 'category', 'priority', 'admin_required', 'self_service_attempted'],
  },
};

/**
 * Safely extract text from a Gemini response, ignoring thinking/thoughtSignature parts.
 * The .text accessor warns when non-text parts (from thinkingConfig) are present.
 */
export function extractText(response: GenerateContentResponse): string {
  try {
    const parts = response.candidates?.[0]?.content?.parts || [];
    return parts
      .filter((p: any) => p.text !== undefined)
      .map((p: any) => p.text)
      .join('');
  } catch {
    // Fallback to .text if structure is unexpected
    try { return response.text || ''; } catch { return ''; }
  }
}

export async function chatWithGemini(
  messages: Message[], 
  image?: string
): Promise<GenerateContentResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const contents = messages.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));

  // Handle images by attaching to the last user message if applicable
  if (image && contents.length > 0) {
    const lastMsg = contents[contents.length - 1];
    if (lastMsg.role === 'user') {
      lastMsg.parts.push({
        inlineData: {
          mimeType: 'image/jpeg',
          data: image.split(',')[1]
        }
      } as any);
    }
  }

  return await ai.models.generateContent({
    model: APP_MODELS.FLASH,
    contents,
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      thinkingConfig: { thinkingBudget: 24576 },
      tools: [{ functionDeclarations: [searchKnowledgeBaseDecl, logIncidentDecl] }],
    },
  });
}

export async function chatWithAdminExpert(
  ticket: Ticket,
  adminMessages: Message[]
): Promise<GenerateContentResponse> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const systemPrompt = `
    You are the "Lotus Assist Senior IT Architect". You are assisting an IT Admin in resolving an incident.
    USER INCIDENT CONTEXT:
    - ID: ${ticket.id}
    - SharePoint ID: ${ticket.sharepointId || 'Not yet synced'}
    - Category: ${ticket.category || 'General'}
    - Summary: ${ticket.summary}
    - Criticality: ${ticket.criticality}
    
    MISSION: Provide high-level technical remediation steps. If the issue is complex (e.g., Azure Entra ID or Careview database locks), reason through dependencies.
  `;

  return await ai.models.generateContent({
    model: APP_MODELS.PRO,
    contents: adminMessages.map(m => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.content }]
    })),
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: 32768 },
    },
  });
}
