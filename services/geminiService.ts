
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
    description: 'Saves the triage data to the backend system for IT follow-up.',
    properties: {
      summary: {
        type: Type.STRING,
        description: 'A 10-word technical summary of the issue.',
      },
      category: {
        type: Type.STRING,
        description: 'The specific application or area requiring support.',
        enum: ['365', 'Xero', 'Careview', 'enableHR', 'Hardware', 'General'],
      },
      criticality: {
        type: Type.STRING,
        description: 'The urgency level of the issue.',
        enum: ['High', 'Medium', 'Low'],
      },
      admin_required: {
        type: Type.BOOLEAN,
        description: 'Whether administrative rights or system-level changes are required.',
      },
    },
    required: ['summary', 'category', 'criticality', 'admin_required'],
  },
};

const captureLogisticsDecl: FunctionDeclaration = {
  name: 'capture_logistics',
  parameters: {
    type: Type.OBJECT,
    description: 'Gathers location, availability, and contact info for IT callback/support.',
    properties: {
      location: {
        type: Type.STRING,
        description: 'Current location of the user.',
        enum: ['Home', 'Office', 'On-Site'],
      },
      availability: {
        type: Type.STRING,
        description: 'A 30-minute window for a callback.',
      },
      phone: {
        type: Type.STRING,
        description: 'The staff member\'s mobile phone number for SMS notifications.',
      },
    },
    required: ['location', 'availability', 'phone'],
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
      tools: [{ functionDeclarations: [searchKnowledgeBaseDecl, logIncidentDecl, captureLogisticsDecl] }],
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
