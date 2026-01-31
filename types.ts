
export enum Criticality {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low'
}

export enum TicketStatus {
  NEW = 'New',
  IT_CONTACTED = 'IT Contacted',
  COURIER_DISPATCHED = 'Courier Dispatched',
  CLOSED = 'Closed'
}

export interface Ticket {
  id: string;
  sharepointId?: string; // Tracks the ID returned by our Python Bridge
  summary: string;
  userName: string;
  userEmail: string;
  userPhone?: string; // Maps to StaffPhone in SharePoint
  transcript: Message[];
  criticality: Criticality;
  adminRequired: boolean;
  status: TicketStatus;
  category?: string;
  location?: string;
  availability?: string;
  createdAt: number;
  thinkingLog?: string;
}

export interface Message {
  role: 'user' | 'model' | 'system';
  content: string;
  image?: string;
  isThinking?: boolean;
}

export interface Logistics {
  location: "Home" | "Office" | "On-Site";
  availability: string;
  phone: string;
}

export interface KBArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  keywords: string[];
}
