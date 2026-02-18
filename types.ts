
export enum Criticality {
  HIGH = 'High',
  MEDIUM = 'Medium',
  LOW = 'Low'
}

export enum Priority {
  P1 = 'P1',
  P2 = 'P2',
  P3 = 'P3',
  P4 = 'P4'
}

export enum TicketStatus {
  NEW = 'New',
  IT_CONTACTED = 'IT Contacted',
  COURIER_DISPATCHED = 'Courier Dispatched',
  CLOSED = 'Closed'
}

export type IssueCategory =
  | 'Microsoft 365'
  | 'Identity & Access'
  | 'Xero'
  | 'Careview'
  | 'enableHR'
  | 'Hardware'
  | 'Network & Connectivity'
  | 'Security'
  | 'General';

export interface Ticket {
  id: string;
  sharepointId?: string;
  summary: string;
  userName: string;
  userEmail: string;
  userPhone?: string;
  transcript: Message[];
  criticality: Criticality;
  priority?: Priority;
  adminRequired: boolean;
  status: TicketStatus;
  category?: IssueCategory | string;
  subCategory?: string;
  location?: string;
  availability?: string;
  createdAt: number;
  thinkingLog?: string;
  securityFlag?: boolean;
  outageFlag?: boolean;
  selfServiceAttempted?: boolean;
  selfServiceResult?: 'resolved' | 'not_resolved' | 'not_attempted' | 'security_bypass';
}

export interface Message {
  role: 'user' | 'model' | 'system';
  content: string;
  image?: string;
  isThinking?: boolean;
}

export interface KBArticle {
  id: string;
  title: string;
  category: string;
  content: string;
  keywords: string[];
}

// ── Admin Panel Types ──

export interface AdminTicket {
  sharepointId: string;
  summary: string;
  status: TicketStatus;
  category: IssueCategory | string;
  criticality: Criticality;
  userName: string;
  userEmail: string;
  userPhone?: string;
  location?: string;
  availability?: string;
  thinkingLog?: string;
  transcript: Message[];
  createdDateTime: string;
  adminNotes?: AdminNote[];
}

export interface AdminTicketsResponse {
  tickets: AdminTicket[];
  total: number;
}

export interface AdminNote {
  timestamp: string;
  author: string;
  note: string;
}

export interface AdminAnalytics {
  total_tickets: number;
  open_tickets: number;
  tickets_today: number;
  by_status: Record<string, number>;
  by_category: Record<string, number>;
  by_criticality: Record<string, number>;
  recent_tickets: AdminTicket[];
  tickets_by_day: { date: string; count: number }[];
}

export interface RoutingRule {
  id: string;
  category: string;
  adminEmail: string;
  adminPhone: string;
  notifySms: boolean;
}

export interface AdminTicketUpdate {
  status?: TicketStatus;
  criticality?: Criticality;
  category?: IssueCategory | string;
  notes?: string;
}

export interface KBSuggestion {
  title: string;
  category: string;
  answer: string;
  keywords: string[];
}
